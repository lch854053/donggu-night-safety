import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { destination, featureCollection, lineString, point } from "@turf/turf";
import { calculateRoadSafety } from "../lib/scoring/calculateRoadSafety";
import { combinedInfluence, computeLightingMetrics, darkGapScore, darkSpanQuality,
  lightInfluence } from "../lib/scoring/lighting";
import { SAFETY_WEIGHTS } from "../config/safetyWeights";
import { estimatedRoadLightingModels } from "../lib/scoring/estimatedRoadLighting";
import { compareLightingModels, saturatingLightingUnion } from "../lib/scoring/lightingCombination";
import type { SafetyDataset, SafetyFeatureType } from "../types/safety";

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const dataset: SafetyDataset = {
  roadSegments: readJson("scripts/data/road-segments.geojson"),
  features: readJson("public/data/safety-features.geojson"),
  riskZones: readJson("public/data/risk-zones.geojson"),
  metadata: { sourceKind: "static", scoreKind: "client", updatedAt: "" },
};

const CENTER = [126.9232, 35.1461] as [number, number];
const config = SAFETY_WEIGHTS.lighting;

function testRoad(lengthMeters: number) {
  const end = destination(CENTER, lengthMeters / 1000, 90).geometry.coordinates;
  return lineString([CENTER, end], { id: "test-road", name: "test", source: "test" });
}

function streetlight(metersAlong: number, id: string, type: SafetyFeatureType = "security_light") {
  return point(destination(CENTER, metersAlong / 1000, 90).geometry.coordinates, {
    id, type, name: "test light", source: "test",
  });
}

test("light influence follows gaussian decay with distance", () => {
  assert.equal(lightInfluence(0, 20), 1);
  assert.ok(Math.abs(lightInfluence(20, 20) - Math.exp(-1)) < 1e-12);
  assert.ok(lightInfluence(10, 20) > lightInfluence(20, 20));
  assert.ok(lightInfluence(60, 20) < 0.011, "cutoff 3σ 이상에서는 영향이 1% 미만이어야 한다");
});

test("combined influence saturates toward 1 without exceeding it", () => {
  assert.equal(combinedInfluence([], 20), 0);
  assert.equal(combinedInfluence([0, 0], 20), 1);
  const pair = combinedInfluence([20, 20], 20);
  const single = combinedInfluence([20], 20);
  assert.ok(pair > single, "추가 보안등은 영향을 높여야 한다");
  assert.ok(pair <= 1);
  assert.ok(combinedInfluence([10, 10, 10, 10, 10, 10], 20) > 0.99, "몰린 등도 포화 상한을 넘지 않는다");
});

test("dark gap score interpolates linearly between breakpoints and clamps outside", () => {
  const breakpoints = config.darkGapBreakpoints;
  assert.equal(darkGapScore(0, breakpoints), 100);
  assert.equal(darkGapScore(10, breakpoints), 90);
  assert.equal(darkGapScore(50, breakpoints), 0);
  assert.ok(Math.abs(darkGapScore(15, breakpoints) - 80) < 1e-9);
  assert.ok(Math.abs(darkGapScore(25, breakpoints) - 57.5) < 1e-9);
  assert.equal(darkGapScore(60, breakpoints), 0);
  assert.equal(darkGapScore(-5, breakpoints), 100);
});

test("dark span quality resists single extreme dark samples", () => {
  const elevenSamples = [0, ...Array(10).fill(0.8)];
  const quality = darkSpanQuality(elevenSamples, 0.2);
  // 최솟값 기준이면 0점이지만 하위 20%(올림 3개) 평균은 약 53점.
  assert.ok(quality > 50 && quality < 56, `quality=${quality}`);
  assert.equal(darkSpanQuality([], 0.2), 0);
});

test("case A: two lights spread to both ends score high", () => {
  const metrics = computeLightingMetrics(testRoad(50), [streetlight(0, "a1"), streetlight(50, "a2")], config);
  assert.equal(metrics.coverageScore, 100);
  assert.equal(metrics.maxDarkGapMeters, 0);
  assert.ok(metrics.lightingScore >= 80, `case A score=${metrics.lightingScore}`);
});

test("case B: two lights clustered at one end score clearly lower than case A", () => {
  const clustered = computeLightingMetrics(testRoad(50), [streetlight(0, "b1"), streetlight(0, "b2")], config);
  const spread = computeLightingMetrics(testRoad(50), [streetlight(0, "a1"), streetlight(50, "a2")], config);
  assert.ok(clustered.coverageScore < spread.coverageScore);
  assert.ok(clustered.maxDarkGapMeters >= 20, "몰린 배치는 구간 끝에 긴 암구간을 남긴다");
  assert.ok(spread.lightingScore - clustered.lightingScore >= 25,
    `A=${spread.lightingScore}, B=${clustered.lightingScore}`);
});

test("case C: single light at the middle scores at least mid-range", () => {
  const metrics = computeLightingMetrics(testRoad(50), [streetlight(25, "c1")], config);
  assert.ok(metrics.lightingScore >= 70, `case C score=${metrics.lightingScore}`);
  assert.ok(metrics.maxDarkGapMeters <= 5, "중앙 등 하나면 암구간은 양끝 5m 수준이다");
});

test("case D: no streetlights at all score nearly zero", () => {
  const metrics = computeLightingMetrics(testRoad(50), [], config);
  assert.equal(metrics.coverageScore, 0);
  assert.equal(metrics.lightingScore, 0);
});

test("case E: long dark gap lowers the score even with decent coverage", () => {
  const longRoad = computeLightingMetrics(testRoad(100), [streetlight(0, "e1"), streetlight(100, "e2")], config);
  assert.ok(longRoad.coverageScore >= 40, `coverage=${longRoad.coverageScore}`);
  assert.ok(longRoad.maxDarkGapMeters >= 50, `gap=${longRoad.maxDarkGapMeters}`);
  assert.ok(longRoad.lightingScore <= 40, `case E score=${longRoad.lightingScore}`);
});

test("가로등 대표좌표 Point는 보안등 커버리지와 암구간에 영향을 주지 않는다", () => {
  const road = testRoad(80);
  const security = computeLightingMetrics(road, [streetlight(0, "s")], config);
  const both = computeLightingMetrics(road, [streetlight(0, "s"), streetlight(0, "r", "road_light")], config);
  const scored = calculateRoadSafety({ ...dataset, roadSegments: featureCollection([road]),
    features: featureCollection([streetlight(0, "s"), streetlight(0, "r", "road_light")]) }).features[0].properties;
  assert.equal(scored.lightingScore, security.lightingScore);
  assert.equal(scored.maxDarkGapMeters, Math.round(security.maxDarkGapMeters));
  assert.deepEqual(both, security, "직접 호출에도 가로등 대표 Point는 무시한다");
});

test("관리행 20건의 추정치로도 긴 보안등 암구간은 사라지지 않는다", () => {
  const road = testRoad(250);
  const metrics = computeLightingMetrics(road, [streetlight(0, "s")], config);
  const estimate = { source: "road_light_api" as const, estimated: true as const, matchedRecordCount: 20,
    uniqueRepresentativePointCount: 1, matchConfidence: 1, matchMethod: "road_name_and_coordinate" as const,
    roadLightingEvidence: 0.7, roadLightingScore: 55, roadLightingContinuity: 0.4,
    roadLightingCoverageEstimated: 0.25, roadLightingRunMeters: 120, roadLightingClusterCount: 1 };
  const scored = calculateRoadSafety({ ...dataset, roadSegments: featureCollection([road]),
    features: featureCollection([streetlight(0, "s")]),
    roadLightingEvidenceByRoad: { "test-road": estimate } }).features[0].properties;
  const withoutEstimate = calculateRoadSafety({ ...dataset, roadSegments: featureCollection([road]),
    features: featureCollection([streetlight(0, "s")]), roadLightingEvidenceByRoad: {} }).features[0].properties;
  assert.ok(metrics.maxDarkGapMeters >= 100);
  assert.equal(metrics.darkGapScore, 0);
  assert.equal(scored.maxDarkGapMeters, Math.round(metrics.maxDarkGapMeters));
  for (const key of ["lightingCoverage", "maxDarkGapMeters", "lightingUniformityScore", "securityLightingScore", "actualLightingScore"] as const) {
    assert.equal(scored[key], withoutEstimate[key], `${key}는 실제 보안등 좌표만 사용`);
  }
  assert.ok(scored.lightingScore > withoutEstimate.lightingScore);
  const models = estimatedRoadLightingModels(metrics.lightingScore, estimate, false);
  assert.ok(models.A <= 60 && models.B <= 60);
  assert.ok(models.A < 100 && models.B < 100);
  assert.equal(scored.roadLightingScore, 55);
  assert.equal(scored.lightingScore, saturatingLightingUnion(metrics.lightingScore, 55));
  assert.equal(scored.roadLightingRecordCount, 20);
});

test("UNION은 두 독립 점수의 최댓값 이상, 100 이하이며 0과 100 경계값을 보존한다", () => {
  assert.equal(saturatingLightingUnion(0, 0), 0);
  assert.equal(saturatingLightingUnion(100, 35), 100);
  assert.equal(saturatingLightingUnion(35, 100), 100);
  for (const security of [0, 10, 45, 90, 100]) for (const road of [0, 20, 55, 85, 100]) {
    const union = saturatingLightingUnion(security, road);
    assert.ok(union >= Math.max(security, road) && union <= 100);
  }
  const low = { source: "road_light_api" as const, estimated: true as const, matchedRecordCount: 1,
    uniqueRepresentativePointCount: 1, matchConfidence: 0.6, matchMethod: "parcel_and_coordinate" as const,
    roadLightingEvidence: 0.4, roadLightingScore: 40 };
  assert.ok(compareLightingModels(0, low, false).UNION <= 55);
});

test("실제 필문대로의 낮은 보안등 점수·높은 신뢰도 corridor에서는 OLD보다 UNION이 높다", () => {
  const roads = JSON.parse(readFileSync("public/data/road-segments.geojson", "utf8"));
  const matching = roads.features.filter((road: { properties: { name: string; securityLightingScore: number;
    roadLightingMatchMethod?: string } }) => road.properties.name === "필문대로" &&
    road.properties.securityLightingScore <= 20 &&
    road.properties.roadLightingMatchMethod === "road_name_and_coordinate");
  assert.ok(matching.length > 0, "실제 고신뢰 추정구간이 필요하다");
  for (const { properties: road } of matching) {
    const old = Math.round(road.securityLightingScore +
      (100 - road.securityLightingScore) * road.roadLightingEvidence * 0.25);
    assert.ok(road.lightingScore > old);
    assert.equal(road.actualLightingScore, road.securityLightingScore);
    assert.ok(road.roadLightingScore <= 85);
  }
});

test("calculateRoadSafety exposes lighting metrics while keeping streetlightCount", () => {
  const roadA = testRoad(50);
  const scored = calculateRoadSafety({ ...dataset,
    roadSegments: featureCollection([roadA]),
    features: featureCollection([streetlight(0, "a1"), streetlight(50, "a2")]) });
  const properties = scored.features[0].properties;
  const metrics = computeLightingMetrics(roadA, [streetlight(0, "a1"), streetlight(50, "a2")], config);
  assert.equal(properties.streetlightCount, 2);
  assert.equal(properties.securityLightCount, 2);
  assert.equal(properties.actualLightingScore, metrics.lightingScore);
  assert.equal(properties.securityLightingScore, metrics.lightingScore);
  assert.equal(properties.roadLightingScore, 0);
  assert.equal(properties.lightingScore, metrics.lightingScore);
  assert.equal(properties.lightingCoverage, Math.round(metrics.coverageScore));
  assert.equal(properties.maxDarkGapMeters, Math.round(metrics.maxDarkGapMeters));
  assert.equal(properties.lightingUniformityScore, Math.round(metrics.uniformityScore));
  // 조명 기여도는 기존 상한(contributionPoints)을 넘지 않는다.
  const darkRoad = calculateRoadSafety({ ...dataset,
    roadSegments: featureCollection([roadA]), features: featureCollection([]) }).features[0].properties;
  assert.equal(darkRoad.lightingScore, 0);
  assert.ok(properties.safetyScore - darkRoad.safetyScore <= config.contributionPoints);
});
