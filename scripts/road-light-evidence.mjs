import { booleanPointInPolygon, geojsonRbush, nearestPointOnLine, point, distance, length } from "@turf/turf";

const HIGH_RADIUS = 150;
const NAME_RADIUS = 300;
const PARCEL_RADIUS = 40;

export function normalizeRoadName(text) {
  return String(text || "").replace(/\([^)]*\)/g, "").replace(/\s/g, "").trim();
}

export function roadNameFromAddress(address) {
  const text = String(address || "").replace(/\([^)]*\)/g, "");
  const tokens = text.match(/[가-힣]+(?:대로|로)(?:\d+번?(?:안)?길)?|[가-힣]+(?:\d+번)?(?:안)?길/g) || [];
  return normalizeRoadName(tokens.at(-1));
}

const endpointKey = ([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`;

/** 동일 도로명 + 동일 종단점만 연결한다. 가까이 지나가거나 교차하는 미분할 도로는 연결하지 않는다. */
function buildNamedGraph(roads) {
  const byName = new Map();
  for (const road of roads.features) {
    const name = road.properties.roadNameSource === "LT_L_SPRD" ? normalizeRoadName(road.properties.name) : "";
    if (!name) continue;
    let graph = byName.get(name);
    if (!graph) { graph = { segments: [], endpoints: new Map() }; byName.set(name, graph); }
    const coords = road.geometry.coordinates;
    const keys = [endpointKey(coords[0]), endpointKey(coords.at(-1))];
    const segment = { road, keys, meters: length(road, { units: "kilometers" }) * 1000 };
    graph.segments.push(segment);
    for (const key of keys) {
      const links = graph.endpoints.get(key) || [];
      links.push(segment);
      graph.endpoints.set(key, links);
    }
  }
  return byName;
}

/** 양쪽 합계 길이. 관리대상 수는 C2에서만 corridor 범위에 완만하게 작용한다. */
export function corridorLength(managedUnitCount, model = "C1", fixedMeters = 200) {
  return model === "C2"
    ? Math.max(150, Math.min(500, 150 + Math.log1p(managedUnitCount) * 55))
    : fixedMeters;
}

/** anchor에서 도로를 따라 양방향으로 최대 total/2m. 종단점에서만 다음 구간으로 진행한다. */
function traceCorridor(graph, anchor, locationMeters, totalMeters) {
  const limit = totalMeters / 2;
  const ends = new Map();
  const queue = [];
  const offer = (key, meters) => {
    if (meters > limit || meters >= (ends.get(key) ?? Infinity)) return;
    ends.set(key, meters);
    queue.push({ key, meters });
  };
  offer(anchor.keys[0], Math.max(0, locationMeters));
  offer(anchor.keys[1], Math.max(0, anchor.meters - locationMeters));
  while (queue.length) {
    queue.sort((a, b) => b.meters - a.meters);
    const { key, meters } = queue.pop();
    if (meters !== ends.get(key)) continue;
    for (const segment of graph.endpoints.get(key) || []) {
      if (segment === anchor) continue;
      offer(segment.keys[0] === key ? segment.keys[1] : segment.keys[0], meters + segment.meters);
    }
  }
  const segments = [{ segment: anchor, corridorDistanceMeters: 0 }];
  for (const segment of graph.segments) {
    if (segment === anchor) continue;
    const along = Math.min(ends.get(segment.keys[0]) ?? Infinity, ends.get(segment.keys[1]) ?? Infinity);
    const midpoint = along + segment.meters / 2;
    if (midpoint <= limit) segments.push({ segment, corridorDistanceMeters: midpoint });
  }
  return segments;
}

function connectedComponent(graph, anchor) {
  const visited = new Set([anchor]);
  const queue = [anchor];
  for (let i = 0; i < queue.length; i++) {
    for (const key of queue[i].keys) for (const segment of graph.endpoints.get(key) || []) {
      if (!visited.has(segment)) { visited.add(segment); queue.push(segment); }
    }
  }
  return visited;
}

function closest(pointFeature, segment) {
  const snapped = nearestPointOnLine(segment.road, pointFeature);
  return { segment, snapped, meters: distance(pointFeature, snapped, { units: "kilometers" }) * 1000 };
}

/** 실제 광원 좌표를 생성하지 않고 관리그룹별 anchor 및 연결된 중심선 구간만 기록한다. */
export function buildRoadLightingEvidence(clusters, roads, boundaries, options = {}) {
  const { corridorModel = "C1", fixedCorridorMeters = 200, strengthModel = "C" } = options;
  const byName = buildNamedGraph(roads);
  const tree = geojsonRbush();
  tree.load({ type: "FeatureCollection", features: roads.features });
  const perRoad = new Map();
  const diagnostics = {
    recordCount: 0, clusterCount: clusters.length, representativePointCount: new Set(clusters.map((c) => c.representativeCoordinate.join(","))).size,
    roadAddressRows: 0, parcelAddressRows: 0, roadNameRows: 0, matchedRows: 0,
    highRows: 0, mediumRows: 0, lowRows: 0, unmatchedRows: 0,
    matchedGroups: 0, matchedClusterCount: 0, unmatchedClusterCount: 0,
    unmatchedGroups: [], distantSameName: [], addressConflicts: [], groupsOver50: [],
    matchedRoadOver50: [], byParcelDong: {}, representativeAddressDiversity: {},
    clusterLinks: [], disconnectedNearby: [], outsideCorridorNearby: [],
    disconnectedPropagation: [], farSegments: [], overlongAnchors: [], duplicateClusterOnRoad: [],
  };
  const byParcelDong = new Map();
  const addressGroups = new Map();
  for (const cluster of clusters) {
    const { clusterId, managedUnitCount: count, representativeCoordinate: coordinates } = cluster;
    const [lon, lat] = coordinates;
    const representative = point(coordinates);
    diagnostics.recordCount += count;
    diagnostics.roadAddressRows += cluster.roadAddressManagedUnitCount ?? (cluster.roadAddresses.length ? count : 0);
    diagnostics.parcelAddressRows += cluster.parcelAddressManagedUnitCount ?? (cluster.parcelAddresses.length ? count : 0);
    const dong = cluster.parcelAddresses[0]?.match(/^([가-힣]+(?:\d+가)?)/)?.[1] || "미확인";
    const area = byParcelDong.get(dong) || { records: 0, representativePoints: 0 };
    area.records += count; area.representativePoints++;
    byParcelDong.set(dong, area);
    const diversity = `${cluster.roadAddresses.length} road / ${cluster.parcelAddresses.length} parcel / 1 prefix`;
    diagnostics.representativeAddressDiversity[diversity] = (diagnostics.representativeAddressDiversity[diversity] || 0) + 1;
    if (count >= 50) diagnostics.groupsOver50.push({ clusterId, coordinate: coordinates, managedUnitCount: count });

    const names = [...new Set(cluster.roadAddresses.map(roadNameFromAddress).filter(Boolean))];
    if (names.length) diagnostics.roadNameRows += cluster.roadAddressManagedUnitCount ?? count;
    let nearest;
    let graph;
    if (names.length === 1) {
      graph = byName.get(names[0]);
      if (graph) {
        for (const segment of graph.segments) {
          const candidate = closest(representative, segment);
          if (!nearest || candidate.meters < nearest.meters) nearest = candidate;
        }
        if (nearest.meters > NAME_RADIUS) {
          diagnostics.distantSameName.push({ clusterId, address: cluster.roadAddresses[0],
            coordinate: coordinates, nearestMeters: Math.round(nearest.meters) });
          nearest = undefined;
        }
      }
    } else if (names.length > 1) {
      diagnostics.addressConflicts.push({ clusterId, coordinate: coordinates, names });
    } else if (cluster.parcelAddresses.length) {
      const boundary = boundaries.features.find((b) => booleanPointInPolygon(representative, b));
      const adminDong = boundary?.properties.adm_nm?.split(" ").at(-1);
      const dx = PARCEL_RADIUS / (111000 * Math.cos(lat * Math.PI / 180));
      const dy = PARCEL_RADIUS / 111000;
      const local = tree.search([lon - dx, lat - dy, lon + dx, lat + dy]).features
        .filter((r) => r.properties.adminDong === adminDong && r.properties.roadNameSource === "LT_L_SPRD")
        .map((r) => closest(representative, { road: r, meters: length(r, { units: "kilometers" }) * 1000,
          keys: [endpointKey(r.geometry.coordinates[0]), endpointKey(r.geometry.coordinates.at(-1))] }))
        .filter((candidate) => candidate.meters <= PARCEL_RADIUS);
      const localNames = new Set(local.map((item) => normalizeRoadName(item.segment.road.properties.name)));
      if (localNames.size === 1) {
        graph = byName.get([...localNames][0]);
        nearest = local.reduce((a, b) => !a || b.meters < a.meters ? b : a, undefined);
        // 동일한 원본 segment 객체를 graph 내에서 재사용한다.
        nearest.segment = graph.segments.find((s) => s.road.properties.id === nearest.segment.road.properties.id);
      }
    }
    if (!nearest) {
      diagnostics.unmatchedRows += count;
      diagnostics.unmatchedGroups.push({ clusterId, coordinate: coordinates,
        roadAddress: cluster.roadAddresses[0] || "", parcelAddress: cluster.parcelAddresses[0] || "",
        managedUnitCount: count });
      continue;
    }

    const confidence = names.length ? nearest.meters <= HIGH_RADIUS ? 1 : 0.8 : 0.6;
    const method = confidence === 1 ? "road_name_and_coordinate" : confidence === 0.8 ? "road_name" : "parcel_and_coordinate";
    const totalMeters = Math.min(confidence === 0.6 ? 150 : 500,
      corridorLength(count, corridorModel, fixedCorridorMeters));
    const segments = traceCorridor(graph, nearest.segment, nearest.snapped.properties.location * 1000, totalMeters);
    const component = connectedComponent(graph, nearest.segment);
    if (nearest.segment.meters > totalMeters) diagnostics.overlongAnchors.push({
      clusterId, anchorRoadId: nearest.segment.road.properties.id, lengthMeters: Math.round(nearest.segment.meters) });
    diagnostics.matchedGroups++; diagnostics.matchedRows += count;
    if (confidence === 1) diagnostics.highRows += count;
    else if (confidence === 0.8) diagnostics.mediumRows += count;
    else diagnostics.lowRows += count;
    diagnostics.clusterLinks.push({ clusterId, managedUnitCount: count, anchorRoadId: nearest.segment.road.properties.id,
      anchorMeters: Math.round(nearest.meters), corridorLengthMeters: Math.round(totalMeters),
      linkedRoadCount: segments.length, method });
    const linked = new Set(segments.map((item) => item.segment.road.properties.id));
    const nearbySameName = graph.segments.filter((segment) =>
      !linked.has(segment.road.properties.id) && closest(representative, segment).meters <= NAME_RADIUS);
    const disconnected = nearbySameName.filter((segment) => !component.has(segment));
    if (disconnected.length) diagnostics.disconnectedNearby.push({ clusterId,
      nearbyButExcluded: disconnected.length, sampleRoadIds: disconnected.slice(0, 5).map((s) => s.road.properties.id) });
    const outside = nearbySameName.length - disconnected.length;
    if (outside) diagnostics.outsideCorridorNearby.push({ clusterId, nearbyButExcluded: outside });
    for (const { segment, corridorDistanceMeters } of segments) {
      const roadId = segment.road.properties.id;
      const entries = perRoad.get(roadId) || new Map();
      if (entries.has(clusterId)) diagnostics.duplicateClusterOnRoad.push({ clusterId, roadId });
      entries.set(clusterId, { clusterId, managedUnitCount: count, representativeCoordinate: coordinates,
        matchConfidence: confidence, matchMethod: method, anchorMeters: nearest.meters,
        corridorDistanceMeters, corridorLengthMeters: totalMeters });
      perRoad.set(roadId, entries);
      if (!component.has(segment)) diagnostics.disconnectedPropagation.push({ clusterId, roadId });
      const metersFromRepresentative = closest(representative, segment).meters;
      if (metersFromRepresentative > NAME_RADIUS) diagnostics.farSegments.push({ clusterId, roadId,
        metersFromRepresentative: Math.round(metersFromRepresentative) });
    }
    for (const address of [...cluster.roadAddresses, ...cluster.parcelAddresses]) {
      const entries = addressGroups.get(address) || [];
      entries.push({ coordinate: coordinates, roadIds: [...linked] });
      addressGroups.set(address, entries);
    }
  }

  diagnostics.sameAddressDistantRoads = [];
  for (const [address, entries] of addressGroups) {
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const meters = distance(point(entries[i].coordinate), point(entries[j].coordinate), { units: "kilometers" }) * 1000;
      if (meters >= 300 && !entries[i].roadIds.some((id) => entries[j].roadIds.includes(id))) {
        diagnostics.sameAddressDistantRoads.push({ address, coordinates: [entries[i].coordinate, entries[j].coordinate], meters: Math.round(meters) });
      }
    }
  }

  const roadsById = {};
  for (const [roadId, uniqueClusters] of perRoad) {
    const matches = [...uniqueClusters.values()];
    const best = matches.reduce((a, b) => a.matchConfidence >= b.matchConfidence ? a : b);
    const managedUnitCount = matches.reduce((sum, m) => sum + m.managedUnitCount, 0);
    const representatives = new Set(matches.map((m) => m.representativeCoordinate.join(",")));
    if (managedUnitCount >= 50) diagnostics.matchedRoadOver50.push({ roadId, managedUnitCount,
      representativePoints: representatives.size });
    let remaining = 1;
    for (const match of matches) {
      const strength = strengthModel === "A" ? 1 - Math.exp(-match.managedUnitCount / 15)
        : strengthModel === "B" ? Math.min(1, Math.log1p(match.managedUnitCount) / Math.log1p(30)) : 0.7;
      const consistency = match.anchorMeters > HIGH_RADIUS ? 0.6 : 1;
      const along = Math.max(0.6, 1 - 0.4 * match.corridorDistanceMeters / (match.corridorLengthMeters / 2));
      remaining *= 1 - match.matchConfidence * strength * consistency * along;
    }
    roadsById[roadId] = { source: "road_light_api", estimated: true,
      clusterIds: matches.map((m) => m.clusterId).sort(), managedUnitCount,
      representativePointCount: representatives.size,
      matchedRecordCount: managedUnitCount, uniqueRepresentativePointCount: representatives.size,
      matchConfidence: best.matchConfidence, matchMethod: best.matchMethod,
      distanceFromAnchorMeters: +Math.min(...matches.map((m) => m.anchorMeters)).toFixed(1),
      corridorDistanceMeters: +Math.min(...matches.map((m) => m.corridorDistanceMeters)).toFixed(1),
      roadLightingEvidence: +Math.min(1, 1 - remaining).toFixed(4) };
  }
  diagnostics.byParcelDong = Object.fromEntries([...byParcelDong].sort((a, b) => b[1].records - a[1].records));
  diagnostics.matchedClusterCount = diagnostics.matchedGroups;
  diagnostics.unmatchedClusterCount = clusters.length - diagnostics.matchedGroups;
  diagnostics.linkedRoadCount = Object.keys(roadsById).length;
  return { roads: roadsById, diagnostics };
}
