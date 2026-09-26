import assert from "node:assert/strict";
import test from "node:test";
import { estimatedRoadLightingModels } from "../lib/scoring/estimatedRoadLighting";
import type { SafetyDataset } from "../types/safety";

type Estimate = NonNullable<SafetyDataset["roadLightingEvidenceByRoad"]>[string];
const high: Estimate = { source: "road_light_api", estimated: true, matchedRecordCount: 20,
  uniqueRepresentativePointCount: 1, matchConfidence: 1, matchMethod: "road_name_and_coordinate",
  roadLightingEvidence: 0.8 };

test("A/B를 따로 비교하고 B는 보안등 점수를 낮추지 않는다", () => {
  assert.deepEqual(estimatedRoadLightingModels(40, high), { A: 48, B: 52 });
  assert.deepEqual(estimatedRoadLightingModels(90, high), { A: 88, B: 92 });
  assert.deepEqual(estimatedRoadLightingModels(40), { A: 40, B: 40 });
});

test("보안등이 없는 도로의 추정치는 최대 60점, 낮은 근거는 감쇠한다", () => {
  const none = estimatedRoadLightingModels(0, { ...high, roadLightingEvidence: 1 }, false);
  assert.ok(none.A <= 60 && none.B <= 60);
  assert.equal(estimatedRoadLightingModels(72, high, false).B >= 72, true);
  const low = estimatedRoadLightingModels(40, { ...high, matchConfidence: 0.6,
    matchMethod: "parcel_and_coordinate" });
  assert.ok(low.B < estimatedRoadLightingModels(40, high).B);
  const unmatched = estimatedRoadLightingModels(40, { ...high, matchConfidence: 0.4 });
  assert.deepEqual(unmatched, { A: 40, B: 40 });
});
