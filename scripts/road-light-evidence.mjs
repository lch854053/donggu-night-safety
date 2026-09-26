import { booleanPointInPolygon, geojsonRbush, nearestPointOnLine, point, distance } from "@turf/turf";

const HIGH_RADIUS = 150;
const NAME_RADIUS = 300;
const PARCEL_RADIUS = 40;

// 도로명 접미어는 그대로 보존한다. '필문대로'와 '필문대로123번길'은 다른 도로다.
export function normalizeRoadName(text) {
  return String(text || "").replace(/\([^)]*\)/g, "").replace(/\s/g, "").trim();
}

export function roadNameFromAddress(address) {
  const text = String(address || "").replace(/\([^)]*\)/g, "");
  const tokens = text.match(/[가-힣]+(?:대로|로)(?:\d+번?(?:안)?길)?|[가-힣]+(?:\d+번)?(?:안)?길/g) || [];
  return normalizeRoadName(tokens.at(-1));
}

function nearby(pointFeature, road) {
  const nearest = nearestPointOnLine(road, pointFeature);
  return distance(pointFeature, nearest, { units: "kilometers" }) * 1000;
}

/** 좌표는 후보 도로 식별에만 사용한다. 도로 위에 광원 좌표를 생성하지 않는다. */
export function buildRoadLightingEvidence(groups, roads, boundaries) {
  const byName = new Map();
  const tree = geojsonRbush();
  tree.load({ type: "FeatureCollection", features: roads.features.map((r) => ({ ...r })) });
  for (const road of roads.features) {
    const name = road.properties.roadNameSource === "LT_L_SPRD" ? normalizeRoadName(road.properties.name) : "";
    if (name) {
      const list = byName.get(name) || [];
      list.push(road);
      byName.set(name, list);
    }
  }
  const perRoad = new Map();
  const addressGroups = new Map();
  const byParcelDong = new Map();
  const diagnostics = { recordCount: 0, representativePointCount: groups.length, roadNameRows: 0,
    matchedRows: 0, highRows: 0, mediumRows: 0, lowRows: 0, unmatchedRows: 0,
    matchedGroups: 0, unmatchedGroups: [], distantSameName: [], addressConflicts: [],
    groupsOver50: [], sameAddressDistantRoads: [], matchedRoadOver50: [], byParcelDong: {},
    representativeAddressDiversity: {} };

  for (const group of groups) {
    const [lon, lat] = group.representativeCoordinates;
    const representative = point([lon, lat]);
    const dong = group.parcelAddresses[0]?.match(/^([가-힣]+(?:\d+가)?)/)?.[1] || "미확인";
    const area = byParcelDong.get(dong) || { records: 0, representativePoints: 0 };
    area.records += group.recordCount;
    area.representativePoints++;
    byParcelDong.set(dong, area);
    const diversity = `${group.roadAddresses.length} road / ${group.parcelAddresses.length} parcel / ${group.managementPrefixes?.length ?? 0} prefix`;
    diagnostics.representativeAddressDiversity[diversity] = (diagnostics.representativeAddressDiversity[diversity] || 0) + 1;
    if (group.recordCount >= 50) diagnostics.groupsOver50.push({
      coordinate: group.representativeCoordinates, recordCount: group.recordCount });
    const names = [...new Set(group.roadAddresses.map(roadNameFromAddress).filter(Boolean))];
    diagnostics.recordCount += group.recordCount;
    if (names.length) diagnostics.roadNameRows += group.recordCount;
    let matches = [];
    if (names.length === 1) {
      const candidates = byName.get(names[0]) || [];
      matches = candidates.map((road) => ({ road, meters: nearby(representative, road) }))
        .filter(({ meters }) => meters <= NAME_RADIUS)
        .map(({ road, meters }) => ({ road, meters,
          method: meters <= HIGH_RADIUS ? "road_name_and_coordinate" : "road_name",
          confidence: meters <= HIGH_RADIUS ? 1 : 0.8 }));
      if (!matches.length && candidates.length) diagnostics.distantSameName.push({
        address: group.roadAddresses[0], coordinate: group.representativeCoordinates,
        nearestMeters: Math.round(Math.min(...candidates.map((r) => nearby(representative, r)))),
      });
    } else if (names.length > 1) {
      diagnostics.addressConflicts.push({ coordinate: group.representativeCoordinates, names });
    }
    if (!matches.length && !names.length && group.parcelAddresses.length) {
      const boundary = boundaries.features.find((b) => booleanPointInPolygon(representative, b));
      const adminDong = boundary?.properties.adm_nm?.split(" ").at(-1);
      const dx = PARCEL_RADIUS / (111000 * Math.cos(lat * Math.PI / 180));
      const dy = PARCEL_RADIUS / 111000;
      const local = tree.search([lon - dx, lat - dy, lon + dx, lat + dy]).features
        .filter((road) => road.properties.adminDong === adminDong && road.properties.roadNameSource === "LT_L_SPRD")
        .map((road) => ({ road, meters: nearby(representative, road) }))
        .filter(({ meters }) => meters <= PARCEL_RADIUS);
      const localNames = new Set(local.map(({ road }) => normalizeRoadName(road.properties.name)));
      if (localNames.size === 1) matches = local.map(({ road, meters }) => ({
        road, meters, method: "parcel_and_coordinate", confidence: 0.6,
      }));
    }
    if (!matches.length) {
      diagnostics.unmatchedRows += group.recordCount;
      diagnostics.unmatchedGroups.push({ coordinate: group.representativeCoordinates,
        roadAddress: group.roadAddresses[0] || "", parcelAddress: group.parcelAddresses[0] || "",
        recordCount: group.recordCount });
      continue;
    }
    diagnostics.matchedGroups++;
    diagnostics.matchedRows += group.recordCount;
    const highest = Math.max(...matches.map((m) => m.confidence));
    if (highest >= 0.8 && highest === 1) diagnostics.highRows += group.recordCount;
    else if (highest >= 0.8) diagnostics.mediumRows += group.recordCount;
    else diagnostics.lowRows += group.recordCount;
    for (const match of matches) {
      const id = match.road.properties.id;
      const entry = perRoad.get(id) || [];
      entry.push({ ...match, recordCount: group.recordCount,
        coordinate: group.representativeCoordinates.join(",") });
      perRoad.set(id, entry);
    }
    for (const address of [...group.roadAddresses, ...group.parcelAddresses]) {
      const entries = addressGroups.get(address) || [];
      entries.push({ coordinate: group.representativeCoordinates, roadIds: matches.map((m) => m.road.properties.id) });
      addressGroups.set(address, entries);
    }
  }

  for (const [address, entries] of addressGroups) {
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const meters = distance(point(entries[i].coordinate), point(entries[j].coordinate), { units: "kilometers" }) * 1000;
      if (meters >= 300 && !entries[i].roadIds.some((id) => entries[j].roadIds.includes(id))) {
        diagnostics.sameAddressDistantRoads.push({ address, coordinates: [entries[i].coordinate, entries[j].coordinate],
          meters: Math.round(meters) });
      }
    }
  }

  const roadsById = {};
  for (const [roadId, matches] of perRoad) {
    const representatives = new Set(matches.map((m) => m.coordinate));
    const recordCount = matches.reduce((sum, m) => sum + m.recordCount, 0);
    if (recordCount >= 50) diagnostics.matchedRoadOver50.push({ roadId, recordCount,
      representativePoints: representatives.size });
    const best = matches.reduce((a, b) => a.confidence >= b.confidence ? a : b);
    const consistency = matches.some((m) => m.meters > HIGH_RADIUS) ? 0.4 : representatives.size > 1 ? 1 : 0.7;
    // 관리행 수는 실제 광원 수가 아니다. 동일 대표좌표의 행은 포화형 근거만 제공한다.
    const strength = 1 - Math.exp(-recordCount / 5);
    roadsById[roadId] = { source: "road_light_api", estimated: true,
      matchedRecordCount: recordCount, uniqueRepresentativePointCount: representatives.size,
      matchConfidence: best.confidence, matchMethod: best.method,
      roadLightingEvidence: +Math.min(1, best.confidence * strength * consistency).toFixed(4) };
  }
  diagnostics.byParcelDong = Object.fromEntries([...byParcelDong].sort((a, b) => b[1].records - a[1].records));
  return { roads: roadsById, diagnostics: { ...diagnostics, linkedRoadCount: Object.keys(roadsById).length } };
}
