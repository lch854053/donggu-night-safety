import { length, lineSliceAlong } from "@turf/turf";

/** 관리그룹별로 실제 도로중심선 부분만 묶는다. 개별 등주 Point나 보간 도형을 만들지 않는다. */
export function buildRoadLightCorridors(clusters, roads, evidence) {
  const byId = new Map(roads.features.map((road) => [road.properties.id, road]));
  const byCluster = new Map();
  for (const [roadId, estimate] of Object.entries(evidence.roads)) {
    const road = byId.get(roadId);
    if (!road) throw new Error(`추정구간 도로 누락: ${roadId}`);
    for (const clusterId of estimate.clusterIds) {
      const items = byCluster.get(clusterId) || [];
      items.push({ road, estimate });
      byCluster.set(clusterId, items);
    }
  }
  const links = new Map(evidence.diagnostics.clusterLinks.map((link) => [link.clusterId, link]));
  return { type: "FeatureCollection", features: clusters.filter((c) => byCluster.has(c.clusterId)).map((cluster) => {
    const items = byCluster.get(cluster.clusterId);
    const link = links.get(cluster.clusterId);
    const parts = link.corridorParts.map(({ roadId, startMeters, endMeters }) => {
      const road = byId.get(roadId);
      if (!road) throw new Error(`추정구간 도로 누락: ${roadId}`);
      const coordinateLength = length(road, { units: "kilometers" }) * 1000;
      const start = Math.min(startMeters, coordinateLength);
      const end = Math.min(endMeters, coordinateLength);
      return { roadId, coordinates: start < 0.01 && end >= coordinateLength - 0.01
        ? road.geometry.coordinates : lineSliceAlong(road, start / 1000, end / 1000, { units: "kilometers" }).geometry.coordinates,
      meters: end - start };
    });
    const meters = items.map(({ road }) => parts.find((part) => part.roadId === road.properties.id)?.meters ?? 0);
    const total = meters.reduce((a, b) => a + b, 0);
    const weighted = (key) => Math.round(items.reduce((sum, item, i) => sum + item.estimate[key] * meters[i], 0) / total);
    const anchor = byId.get(link.anchorRoadId);
    return { type: "Feature", properties: {
      clusterId: cluster.clusterId, roadName: anchor.properties.name,
      managedUnitCount: cluster.managedUnitCount, matchConfidence: link.method === "road_name_and_coordinate" ? 1
        : link.method === "road_name" ? 0.8 : 0.6,
      matchMethod: link.method, estimated: true, source: "odcloud:15113447",
      dataAsOf: cluster.dataAsOf, linkedRoadCount: items.length,
      corridorLengthMeters: Math.round(total),
      roadLightingEvidence: +(items.reduce((sum, item, i) => sum + item.estimate.roadLightingEvidence * meters[i], 0) / total).toFixed(4),
      // 한 구간의 다른 고신뢰 cluster가 함께 만든 점수를 저신뢰 그룹에 귀속하지 않는다.
      roadLightingScore: Math.min(link.method === "parcel_and_coordinate" ? 55
        : link.method === "road_name" ? 65 : 85, weighted("roadLightingScore")),
    }, geometry: { type: "MultiLineString", coordinates: parts.map((part) => part.coordinates) } };
  }) };
}
