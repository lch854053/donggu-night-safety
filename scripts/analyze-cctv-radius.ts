/** Evaluate a 150m CCTV decay against the shipped 200m model without rewriting scores. */
import { readFileSync } from "node:fs";
import { SAFETY_SCORES_V2, getSafetyBand, type SurveillanceConfig } from "../config/safetyWeights";
import { createRoadPointIndex } from "../lib/scoring/roadPointIndex";
import { computeSurveillanceScore } from "../lib/scoring/surveillance";
import { combineDimensionScores } from "../lib/scoring/weightedAverage";
import type { SafetyDataset, SafetyFeatureType, ScoredRoadSegments } from "../types/safety";

const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const roads = read("public/data/road-segments.geojson") as ScoredRoadSegments;
const dataset: SafetyDataset = {
  roadSegments: read("scripts/data/road-segments.geojson"),
  features: read("public/data/safety-features.geojson"), riskZones: read("public/data/risk-zones.geojson"),
  metadata: { sourceKind: "static", scoreKind: "client", updatedAt: "" },
};
const candidatesForRoad = createRoadPointIndex(dataset);
const types = new Set<SafetyFeatureType>(dataset.features.features.map((feature) => feature.properties.type));
const config: SurveillanceConfig = {
  ...SAFETY_SCORES_V2.surveillance,
  cctv: { ...SAFETY_SCORES_V2.surveillance.cctv, radiusMeters: 150,
    breakpoints: [[0, 100], [30, 80], [60, 50], [100, 20], [150, 0]] },
};
const alternative: { cctv: number; surveillance: number; final: number }[] = [];
for (let i = 0; i < roads.features.length; i++) {
  const input = dataset.roadSegments.features[i];
  const p = roads.features[i].properties;
  if (input.properties.id !== p.id) throw new Error("도로 입력과 산출물의 순서가 다릅니다.");
  const s = computeSurveillanceScore(input, candidatesForRoad(input), types, config);
  const final = combineDimensionScores({ lighting: p.lightingScore, surveillance: s.score,
    activity: p.activityScore, environment: p.environmentScore, crime: p.crimeScore });
  alternative.push({ cctv: s.cctvScore ?? 0, surveillance: s.score ?? 0, final: final ?? 0 });
}
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2),
    median: sorted[Math.floor(sorted.length / 2)],
    p10: sorted[Math.floor(sorted.length * .1)], p90: sorted[Math.floor(sorted.length * .9)],
    positivePct: +(100 * values.filter((v) => v > 0).length / values.length).toFixed(2) };
};
const p = roads.features.map((road) => road.properties);
console.log(JSON.stringify({ roads: p.length,
  radius200: { cctv: stats(p.map((x) => x.cctvScore ?? 0)), surveillance: stats(p.map((x) => x.surveillanceScore ?? 0)), final: stats(p.map((x) => x.safetyScoreV2 ?? 0)) },
  radius150: { cctv: stats(alternative.map((x) => x.cctv)), surveillance: stats(alternative.map((x) => x.surveillance)), final: stats(alternative.map((x) => x.final)) },
  changedFinalBy5: p.filter((x, i) => Math.abs((x.safetyScoreV2 ?? 0) - alternative[i].final) >= 5).length,
  changedFinalBy10: p.filter((x, i) => Math.abs((x.safetyScoreV2 ?? 0) - alternative[i].final) >= 10).length,
  changedBands: p.filter((x, i) => getSafetyBand(x.safetyScoreV2 ?? 0).label !== getSafetyBand(alternative[i].final).label).length,
}, null, 2));
