import { readFileSync, writeFileSync } from "node:fs";
import { combineDimensionScores } from "../lib/scoring/weightedAverage";
import { estimatedRoadLightingModels } from "../lib/scoring/estimatedRoadLighting";
import { compareLightingModels } from "../lib/scoring/lightingCombination";
import { buildRoadLightingEvidence } from "./road-light-evidence.mjs";
import type { RoadLightEvidenceOptions } from "./road-light-evidence.mjs";
import type { RoadSegmentProperties, SafetyDataset } from "../types/safety";

type Estimate = NonNullable<SafetyDataset["roadLightingEvidenceByRoad"]>[string];
type Road = { properties: RoadSegmentProperties };
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const scored = readJson("public/data/road-segments.geojson");
const evidence = readJson("public/data/road-light-evidence.json");
const clusters = readJson("public/data/road-light-clusters.json").clusters;
const sourceRoads = readJson("scripts/data/road-segments.geojson");
const boundaries = readJson("scripts/data/donggu-admin-boundaries.geojson");
const corridors = readJson("public/data/road-light-corridors.geojson");
const previousArg = process.argv.find((arg) => arg.startsWith("--previous="));
const previous = previousArg ? new Map<string, RoadSegmentProperties>(readJson(previousArg.slice(11))
  .features.map((r: Road) => [r.properties.id, r.properties])) : null;

const sizes = clusters.map((c: { managedUnitCount: number }) => c.managedUnitCount);
function percentile(sorted: number[], p: number) { return sorted[Math.floor((sorted.length - 1) * p)]; }
function summary(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2),
    median: percentile(sorted, .5), p10: percentile(sorted, .1), p25: percentile(sorted, .25),
    p75: percentile(sorted, .75), p90: percentile(sorted, .9), max: sorted.at(-1),
    le30: +(values.filter((x) => x <= 30).length / values.length * 100).toFixed(2),
    ge80: +(values.filter((x) => x >= 80).length / values.length * 100).toFixed(2) };
}
function changes(values: number[]) {
  return { ge5: +(values.filter((x) => x >= 5).length / values.length * 100).toFixed(2),
    ge10: +(values.filter((x) => x >= 10).length / values.length * 100).toFixed(2),
    ge15: +(values.filter((x) => x >= 15).length / values.length * 100).toFixed(2),
    ge20: +(values.filter((x) => x >= 20).length / values.length * 100).toFixed(2),
    maxIncrease: Math.max(...values) };
}
function safetyScore(p: RoadSegmentProperties, lighting: number) {
  return combineDimensionScores({ lighting, surveillance: p.surveillanceScore,
    activity: p.activityScore, environment: p.environmentScore, crime: p.crimeScore });
}
const scores: Record<string, number[]> = { security: [], OLD: [], MAX: [], UNION: [], previousDeployment: [] };
const v2: Record<string, number[]> = { security: [], OLD: [], MAX: [], UNION: [], previousDeployment: [] };
const deltas: Record<string, number[]> = { OLD: [], MAX: [], UNION: [] };
const safetyDeltas: Record<string, number[]> = { OLD: [], MAX: [], UNION: [] };
const roadScores: number[] = [], matchedRoadScores: number[] = [];
const previousLightingDeltas: number[] = [], previousSafetyDeltas: number[] = [];
const byDong: Record<string, { n: number; actual: number; applied: number; safetyActual: number; safetyApplied: number }> = {};
const singleClusterLargeIncrease: object[] = [];
const allLargeIncrease: object[] = [];
const examples: object[] = [];
const representativeRoads: Record<string, object[]> = Object.fromEntries(
  ["필문대로", "남문로", "무등로", "금남로"].map((name) => [name, []]));
const underestimated: object[] = [];
for (const road of scored.features as Road[]) {
  const p = road.properties;
  const estimate = (evidence.roads as Record<string, Estimate>)[p.id];
  const actual = p.actualLightingScore;
  const models = compareLightingModels(actual, estimate, p.securityLightCount > 0);
  const baseSafety = safetyScore(p, actual);
  if (baseSafety === null) throw new Error(`도로 최종 점수 누락: ${p.id}`);
  scores.security.push(actual); v2.security.push(baseSafety);
  roadScores.push(estimate?.roadLightingScore ?? 0);
  if (estimate) matchedRoadScores.push(estimate.roadLightingScore ?? 0);
  for (const [model, lighting] of Object.entries(models)) {
    const safety = safetyScore(p, lighting);
    if (safety === null) throw new Error(`도로 ${p.id} ${model} 점수 누락`);
    scores[model].push(lighting); v2[model].push(safety);
    deltas[model].push(lighting - actual); safetyDeltas[model].push(safety - baseSafety);
  }
  const { OLD, MAX, UNION } = models;
  const unionSafety = v2.UNION.at(-1)!;
  if (p.lightingScore !== UNION || p.roadLightingScore !== (estimate?.roadLightingScore ?? 0)) {
    throw new Error(`도로 ${p.id} 배포 점수와 분석 모델 불일치`);
  }
  const dong = p.adminDong || "미확인";
  const area = byDong[dong] ||= { n: 0, actual: 0, applied: 0, safetyActual: 0, safetyApplied: 0 };
  area.n++; area.actual += actual; area.applied += UNION;
  area.safetyActual += baseSafety; area.safetyApplied += unionSafety;
  if (estimate && UNION - actual >= 20) {
    const outlier = { roadId: p.id, name: p.name, adminDong: dong,
      clusterIds: estimate.clusterIds, actual, applied: UNION, increase: UNION - actual };
    allLargeIncrease.push(outlier);
    if (estimate.clusterIds?.length === 1) singleClusterLargeIncrease.push(outlier);
  }
  if (estimate && UNION > actual) examples.push({ roadId: p.id, name: p.name, adminDong: dong,
    clusterIds: estimate.clusterIds, managedUnitCount: estimate.managedUnitCount,
    corridorDistanceMeters: estimate.corridorDistanceMeters, confidence: estimate.matchConfidence,
    actual, applied: UNION, increase: UNION - actual, safetyActual: baseSafety, safetyApplied: unionSafety });
  if (representativeRoads[p.name]) {
    const item = { roadId: p.id, roadName: p.name, adminDong: dong,
      securityLightingScore: actual, roadLightingEvidence: estimate?.roadLightingEvidence ?? 0,
      roadLightingScore: estimate?.roadLightingScore ?? 0,
      roadLightingContinuity: estimate?.roadLightingContinuity ?? 0,
      matchConfidence: estimate?.matchConfidence ?? null,
      OLD, MAX, UNION, safetyScoreV2: unionSafety };
    representativeRoads[p.name].push(item);
    if (actual <= 20 && UNION <= 40) underestimated.push(item);
  }
  const old = previous?.get(p.id);
  if (old) {
    scores.previousDeployment.push(old.lightingScore);
    previousLightingDeltas.push(UNION - old.lightingScore);
    if (old.safetyScoreV2 !== null) {
      v2.previousDeployment.push(old.safetyScoreV2);
      previousSafetyDeltas.push(unionSafety - old.safetyScoreV2);
    }
  }
}

const corridorModes: [string, RoadLightEvidenceOptions][] = [
  ...[200, 300, 400, 500].map((meters): [string, RoadLightEvidenceOptions] =>
    [`C1-${meters}m`, { fixedCorridorMeters: meters }]),
  ["C2-log", { corridorModel: "C2" }],
];
const corridorComparison = Object.fromEntries(corridorModes.map(([name, options]) => {
  const result = buildRoadLightingEvidence(clusters, sourceRoads, boundaries, options);
  const counts = result.diagnostics.clusterLinks.map((x: { linkedRoadCount: number }) => x.linkedRoadCount);
  const lit = (scored.features as Road[]).map(({ properties: p }) =>
    estimatedRoadLightingModels(p.actualLightingScore, result.roads[p.id], p.securityLightCount > 0).B);
  const unionLit = (scored.features as Road[]).map(({ properties: p }) =>
    compareLightingModels(p.actualLightingScore, result.roads[p.id], p.securityLightCount > 0).UNION);
  return [name, { linkedRoadCount: result.diagnostics.linkedRoadCount,
    linkedPerCluster: summary(counts), clusterOver20: counts.filter((x: number) => x > 20).length,
    lightingMean: summary(lit)?.mean, unionLightingMean: summary(unionLit)?.mean }];
}));
const strengthComparison = Object.fromEntries((["A", "B", "C"] as const).map((strengthModel) => {
  const result = buildRoadLightingEvidence(clusters, sourceRoads, boundaries,
    { fixedCorridorMeters: 200, strengthModel });
  const lit = (scored.features as Road[]).map(({ properties: p }) =>
    estimatedRoadLightingModels(p.actualLightingScore, result.roads[p.id], p.securityLightCount > 0).B);
  const unionLit = (scored.features as Road[]).map(({ properties: p }) =>
    compareLightingModels(p.actualLightingScore, result.roads[p.id], p.securityLightCount > 0).UNION);
  return [strengthModel, { lightingMean: summary(lit)?.mean, unionLightingMean: summary(unionLit)?.mean,
    ge20: changes(lit.map((value: number, i: number) => value - scores.security[i])).ge20 }];
}));
const links = evidence.diagnostics.clusterLinks;
const sortedLinks = links.map((c: { linkedRoadCount: number }) => c.linkedRoadCount);
const byDongSummary = Object.fromEntries(Object.entries(byDong).map(([dong, area]) => [dong, {
  roads: area.n, actual: +(area.actual / area.n).toFixed(2), applied: +(area.applied / area.n).toFixed(2),
  delta: +((area.applied - area.actual) / area.n).toFixed(2),
  safetyActual: +(area.safetyActual / area.n).toFixed(2), safetyApplied: +(area.safetyApplied / area.n).toFixed(2),
  safetyDelta: +((area.safetyApplied - area.safetyActual) / area.n).toFixed(2),
}]));
// 대표 사례는 동별로 한 도로씩 우선 선별하여 특정 밀집 동의 예시만 나열하지 않는다.
const seen = new Set<string>();
const actualExamples = [...examples].sort((a: any, b: any) => b.increase - a.increase)
  .filter((example: any) => !seen.has(example.adminDong) && !!seen.add(example.adminDong)).slice(0, 10);
const corridorLengths = corridors.features.map((f: { properties: { corridorLengthMeters: number } }) => f.properties.corridorLengthMeters);
if (corridors.features.length !== links.length) throw new Error("관리그룹과 추정 Line 피처 수 불일치");
const analysis = {
  source: "odcloud:15113447", model: "C1-200m + evidence-C + saturating UNION",
  raw: { recordCount: evidence.diagnostics.recordCount, clusterCount: clusters.length,
    uniqueManagedUnitCount: sizes.reduce((a: number, b: number) => a + b, 0),
    managedUnitCount: { mean: summary(sizes)?.mean, median: summary(sizes)?.median,
      p90: summary(sizes)?.p90, max: summary(sizes)?.max },
    roadAddressRows: evidence.diagnostics.roadAddressRows,
    roadAddressPercent: +(evidence.diagnostics.roadAddressRows / evidence.diagnostics.recordCount * 100).toFixed(2),
    parcelAddressRows: evidence.diagnostics.parcelAddressRows,
    parcelAddressPercent: +(evidence.diagnostics.parcelAddressRows / evidence.diagnostics.recordCount * 100).toFixed(2) },
  matching: evidence.diagnostics,
  confidenceClusters: {
    high: links.filter((x: { method: string }) => x.method === "road_name_and_coordinate").length,
    medium: links.filter((x: { method: string }) => x.method === "road_name").length,
    low: links.filter((x: { method: string }) => x.method === "parcel_and_coordinate").length,
    unmatched: clusters.length - links.length,
  },
  linkedPerCluster: summary(sortedLinks),
  corridors: { count: corridors.features.length, lengthsMeters: summary(corridorLengths),
    geometryMeaning: "connected original road-centerline geometry clipped to the cluster length budget; not individual fixture locations" },
  previousMatchingReference: { source: "PR #26 (2026-09-26)", matchedClusters: 192, linkedRoadCount: 2047 },
  corridorComparison, strengthComparison,
  roadLightingScore: { allRoads: summary(roadScores), matchedRoads: summary(matchedRoadScores) },
  lighting: Object.fromEntries(Object.entries(scores).map(([key, values]) => [key, summary(values)])),
  safetyV2: Object.fromEntries(Object.entries(v2).map(([key, values]) => [key, summary(values)])),
  changes: Object.fromEntries(Object.entries(deltas).map(([key, values]) => [key, changes(values)])),
  safetyChanges: Object.fromEntries(Object.entries(safetyDeltas).map(([key, values]) => [key, changes(values)])),
  previousToCurrent: previous ? {
    lighting: { ...changes(previousLightingDeltas), meanDelta: summary(previousLightingDeltas)?.mean,
      decreased5: previousLightingDeltas.filter((x) => x <= -5).length,
      minDelta: Math.min(...previousLightingDeltas) },
    safety: { ...changes(previousSafetyDeltas), meanDelta: summary(previousSafetyDeltas)?.mean,
      decreased5: previousSafetyDeltas.filter((x) => x <= -5).length,
      minDelta: Math.min(...previousSafetyDeltas) },
  } : null,
  byDong: byDongSummary,
  representativeRoads,
  underestimated,
  examples: actualExamples,
  anomalies: { clusterOver20: links.filter((x: { linkedRoadCount: number }) => x.linkedRoadCount > 20),
    farSegments: evidence.diagnostics.farSegments,
    disconnectedPropagation: evidence.diagnostics.disconnectedPropagation,
    duplicateClusterOnRoad: evidence.diagnostics.duplicateClusterOnRoad,
    singleClusterLargeIncrease, allLargeIncrease, overlongAnchors: evidence.diagnostics.overlongAnchors,
    safetyIncrease15: (scored.features as Road[]).flatMap((road, i) => safetyDeltas.UNION[i] >= 15
      ? [{ roadId: road.properties.id, name: road.properties.name, safetyIncrease: safetyDeltas.UNION[i] }] : []),
    safetyIncrease20: (scored.features as Road[]).flatMap((road, i) => safetyDeltas.UNION[i] >= 20
      ? [{ roadId: road.properties.id, name: road.properties.name, safetyIncrease: safetyDeltas.UNION[i] }] : []),
    disconnectedNearbyExcluded: evidence.diagnostics.disconnectedNearby },
};
writeFileSync("public/data/road-light-analysis.json", JSON.stringify(analysis, null, 2) + "\n");
console.log(JSON.stringify({ raw: analysis.raw, matching: { matchedClusterCount: evidence.diagnostics.matchedClusterCount,
  unmatchedClusterCount: evidence.diagnostics.unmatchedClusterCount, linkedRoadCount: evidence.diagnostics.linkedRoadCount,
  highRows: evidence.diagnostics.highRows, mediumRows: evidence.diagnostics.mediumRows, lowRows: evidence.diagnostics.lowRows },
  confidenceClusters: analysis.confidenceClusters, corridorComparison, strengthComparison,
  corridors: analysis.corridors, roadLightingScore: analysis.roadLightingScore,
  lighting: analysis.lighting, safetyV2: analysis.safetyV2,
  changes: analysis.changes, safetyChanges: analysis.safetyChanges, previousToCurrent: analysis.previousToCurrent,
  anomalies: Object.fromEntries(Object.entries(analysis.anomalies).map(([key, value]) => [key, value.length])) }, null, 2));
