import { length } from "@turf/turf";

const endpoint = ([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`;

/** 같은 도로명·같은 종단점의 evidence만 한 연속구간으로 센다. 거리상 가까운 별개 도로는 합치지 않는다. */
export function addRoadLightingScores(evidence, roads) {
  const byId = new Map(roads.features.map((road) => [road.properties.id, road]));
  const names = new Map();
  for (const road of roads.features) {
    if (road.properties.roadNameSource !== "LT_L_SPRD") continue;
    const name = String(road.properties.name).replace(/\s/g, "");
    const group = names.get(name) || { roads: [], endpoints: new Map() };
    group.roads.push(road);
    for (const coordinate of [road.geometry.coordinates[0], road.geometry.coordinates.at(-1)]) {
      const key = endpoint(coordinate);
      const links = group.endpoints.get(key) || [];
      links.push(road);
      group.endpoints.set(key, links);
    }
    names.set(name, group);
  }
  const metrics = new Map();
  for (const group of names.values()) {
    const visited = new Set();
    const neighbors = (road) => [...new Set([road.geometry.coordinates[0], road.geometry.coordinates.at(-1)]
      .flatMap((coordinate) => group.endpoints.get(endpoint(coordinate)) || []))];
    for (const start of group.roads) {
      if (visited.has(start)) continue;
      const component = [start]; visited.add(start);
      for (let i = 0; i < component.length; i++) for (const neighbor of neighbors(component[i])) {
        if (!visited.has(neighbor)) { visited.add(neighbor); component.push(neighbor); }
      }
      const totalMeters = component.reduce((sum, road) => sum + length(road, { units: "kilometers" }) * 1000, 0);
      const covered = component.filter((road) => evidence.roads[road.properties.id]);
      const coveredMeters = covered.reduce((sum, road) => sum + evidence.roads[road.properties.id].roadLightingMatchedMeters, 0);
      const seen = new Set();
      for (const road of covered) {
        if (seen.has(road)) continue;
        const run = [road]; seen.add(road);
        for (let i = 0; i < run.length; i++) for (const neighbor of neighbors(run[i])) {
          if (evidence.roads[neighbor.properties.id] && !seen.has(neighbor)) { seen.add(neighbor); run.push(neighbor); }
        }
        const runMeters = run.reduce((sum, segment) => sum + evidence.roads[segment.properties.id].roadLightingMatchedMeters, 0);
        const clusters = new Set(run.flatMap((segment) => evidence.roads[segment.properties.id].clusterIds));
        const continuity = Math.min(1, runMeters / 350) * Math.min(1, clusters.size / 3);
        for (const segment of run) metrics.set(segment.properties.id, {
          roadLightingCoverageEstimated: +(coveredMeters / totalMeters).toFixed(4),
          roadLightingContinuity: +continuity.toFixed(4),
          roadLightingRunMeters: Math.round(runMeters), roadLightingClusterCount: clusters.size,
        });
      }
    }
  }
  for (const [roadId, estimate] of Object.entries(evidence.roads)) {
    const road = byId.get(roadId);
    const metric = metrics.get(roadId);
    if (!road || !metric) throw new Error(`가로등 도로 연결성 누락: ${roadId}`);
    const { roadLightingContinuity: continuity, roadLightingClusterCount: count } = metric;
    const context = estimate.matchConfidence >= 0.8 && count >= 2 && continuity >= 0.45
      ? road.properties.widthMeters >= 16 ? 4 : road.properties.widthMeters >= 10 ? 2 : 0 : 0;
    // 관리대상 수·폭만으로 점수를 주지 않는다. 대표좌표 기반 설치 근거, 실제 연결구간,
    // 다중 cluster가 모두 있을 때만 도로 폭을 최대 4점 보조한다. lux 환산값이 아니다.
    const limit = estimate.matchConfidence < 0.8 ? 55 : estimate.matchConfidence < 1 ? 65 : 85;
    const roadLightingScore = Math.min(limit, Math.round(
      20 + 50 * estimate.roadLightingEvidence + 15 * continuity + context));
    Object.assign(estimate, metric, { roadLightingScore });
  }
  return evidence;
}
