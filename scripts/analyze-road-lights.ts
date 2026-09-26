import { readFileSync, writeFileSync } from "node:fs";
import { combineDimensionScores } from "../lib/scoring/weightedAverage";
import { estimatedRoadLightingModels } from "../lib/scoring/estimatedRoadLighting";
import type { RoadSegmentProperties, SafetyDataset } from "../types/safety";

type Estimate = NonNullable<SafetyDataset["roadLightingEvidenceByRoad"]>[string];
const scored = JSON.parse(readFileSync("public/data/road-segments.geojson", "utf8"));
const evidence = JSON.parse(readFileSync("public/data/road-light-evidence.json", "utf8"));
const previousArg = process.argv.find((arg) => arg.startsWith("--previous="));
const previous = previousArg ? new Map<string, number>(JSON.parse(readFileSync(previousArg.slice(11), "utf8"))
  .features.map((r: { properties: RoadSegmentProperties }) => [r.properties.id, r.properties.lightingScore])) : null;
const scores: Record<string, number[]> = { actual: [], A: [], B: [], previousDirectPoint: [] };
const v2: Record<string, number[]> = { actual: [], A: [], B: [] };
const deltas: Record<string, number[]> = { A: [], B: [] };
const safetyDeltas: Record<string, number[]> = { A: [], B: [] };
const anomalies: { roadId: string; name: string; adminDong?: string; recordCount: number;
  evidence: number; actual: number; A: number; B: number }[] = [];
const byDong: Record<string, { n: number; actual: number; A: number; B: number }> = {};
for (const road of scored.features as { properties: RoadSegmentProperties }[]) {
  const p = road.properties;
  const estimate = (evidence.roads as Record<string, Estimate>)[p.id];
  const actual = p.actualLightingScore;
  const { A, B } = estimatedRoadLightingModels(actual, estimate, p.securityLightCount > 0);
  scores.actual.push(actual); scores.A.push(A); scores.B.push(B);
  if (previous?.has(p.id)) scores.previousDirectPoint.push(previous.get(p.id)!);
  for (const [name, lighting] of Object.entries({ actual, A, B })) {
    const result = combineDimensionScores({ lighting, surveillance: p.surveillanceScore,
      activity: p.activityScore, environment: p.environmentScore, crime: p.crimeScore });
    if (result !== null) v2[name].push(result);
  }
  deltas.A.push(A - actual); deltas.B.push(B - actual);
  safetyDeltas.A.push(v2.A.at(-1)! - v2.actual.at(-1)!);
  safetyDeltas.B.push(v2.B.at(-1)! - v2.actual.at(-1)!);
  const dong = p.adminDong || "미확인";
  const row = byDong[dong] ||= { n: 0, actual: 0, A: 0, B: 0 };
  row.n++; row.actual += actual; row.A += A; row.B += B;
  if (estimate && (estimate.matchedRecordCount >= 50 || A - actual >= 30 || B - actual >= 30)) {
    anomalies.push({ roadId: p.id, name: p.name, adminDong: p.adminDong,
      recordCount: estimate.matchedRecordCount, evidence: estimate.roadLightingEvidence, actual, A, B });
  }
}
function summary(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return { count: values.length, mean: +avg.toFixed(2), median: sorted[Math.floor(values.length * .5)],
    p10: sorted[Math.floor(values.length * .1)], p25: sorted[Math.floor(values.length * .25)],
    p75: sorted[Math.floor(values.length * .75)], p90: sorted[Math.floor(values.length * .9)],
    le30: +(values.filter((x) => x <= 30).length / values.length * 100).toFixed(2),
    ge80: +(values.filter((x) => x >= 80).length / values.length * 100).toFixed(2) };
}
const analysis = {
  source: "odcloud:15113447", model: "comparison-only",
  matching: evidence.diagnostics,
  lighting: Object.fromEntries(Object.entries(scores).map(([key, values]) => [key, summary(values)])),
  safetyV2: Object.fromEntries(Object.entries(v2).map(([key, values]) => [key, summary(values)])),
  changes: Object.fromEntries(Object.entries(deltas).map(([key, values]) => [key, {
    ge10: +(values.filter((x) => x >= 10).length / values.length * 100).toFixed(2),
    ge20: +(values.filter((x) => x >= 20).length / values.length * 100).toFixed(2),
    ge30: +(values.filter((x) => x >= 30).length / values.length * 100).toFixed(2),
  }])),
  safetyChanges: Object.fromEntries(Object.entries(safetyDeltas).map(([key, values]) => [key, {
    ge10: +(values.filter((x) => x >= 10).length / values.length * 100).toFixed(2),
    ge20: +(values.filter((x) => x >= 20).length / values.length * 100).toFixed(2),
    maxIncrease: Math.max(...values),
  }])),
  byDong: Object.fromEntries(Object.entries(byDong).map(([dong, row]) => [dong, {
    n: row.n, actual: +(row.actual / row.n).toFixed(1), A: +(row.A / row.n).toFixed(1),
    B: +(row.B / row.n).toFixed(1),
  }])),
  anomalies,
};
writeFileSync("public/data/road-light-analysis.json", JSON.stringify(analysis, null, 2) + "\n");
console.log(JSON.stringify({ lighting: analysis.lighting, safetyV2: analysis.safetyV2,
  changes: analysis.changes, safetyChanges: analysis.safetyChanges, matching: { ...evidence.diagnostics,
    unmatchedGroups: evidence.diagnostics.unmatchedGroups.length },
  anomalies: anomalies.length, topAnomalies: anomalies.slice(0, 15) }, null, 2));
