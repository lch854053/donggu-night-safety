import assert from "node:assert/strict";
import test from "node:test";
import { featureCollection, length, lineString } from "@turf/turf";
import { calculateRoadSafety } from "../lib/scoring/calculateRoadSafety";
import { combineCrimeLevels, lonLatToWebMercator, nearestLegendLevel,
  sampleRoadPoints, webMercatorToLonLat } from "../lib/scoring/crimeRisk";
import { SAFETY_WEIGHTS } from "../config/safetyWeights";
import type { CrimeRiskSummary, SafetyDataset } from "../types/safety";

const legend = [
  { level: 1, color: "#ffffb2" },
  { level: 5, color: "#fd9b43" },
  { level: 10, color: "#bd0026" },
];

test("legend matching uses nearest color with an anti-aliasing tolerance", () => {
  assert.equal(nearestLegendLevel({ r: 255, g: 255, b: 178 }, legend, 30), 1);
  assert.equal(nearestLegendLevel({ r: 253, g: 155, b: 67 }, legend, 30), 5);
  assert.equal(nearestLegendLevel({ r: 255, g: 232, b: 139 }, [
    { level: 1, color: "#ffffb2" }, { level: 2, color: "#fee88b" }], 30), 2,
    "안티앨리어싱 혼색은 가장 가까운 범례색으로 찾는다");
  assert.equal(nearestLegendLevel({ r: 0, g: 0, b: 0 }, legend, 30), null,
    "범례에서 벗어난 색은 noData(null)다");
});

test("web mercator conversion round-trips Gwangju coordinates", () => {
  const lonLat: [number, number] = [126.9232, 35.1461];
  const mercator = lonLatToWebMercator(lonLat);
  assert.ok(mercator[0] > 14_000_000 && mercator[0] < 14_200_000);
  const roundTrip = webMercatorToLonLat(mercator);
  assert.ok(Math.abs(roundTrip[0] - lonLat[0]) < 1e-7);
  assert.ok(Math.abs(roundTrip[1] - lonLat[1]) < 1e-7);
});

test("road sampling follows the interval and keeps at least one sample", () => {
  const road = lineString([[126.9232, 35.1461], [126.9282, 35.1461]]); // 약 454m
  const points = sampleRoadPoints(road, 20);
  const meters = length(road, { units: "kilometers" }) * 1000;
  assert.equal(points.length, Math.floor(meters / 20) + 1);
  assert.deepEqual(points[0], [126.9232, 35.1461]);
  const short = lineString([[126.9232, 35.1461], [126.9236, 35.1461]]); // 약 36m
  assert.equal(sampleRoadPoints(short, 20).length, 2);
  const tiny = lineString([[126.9232, 35.1461], [126.92325, 35.1461]]);
  assert.ok(sampleRoadPoints(tiny, 20).length >= 1);
});

test("crime stats combine mean, max, and high-risk ratio then normalize to 0-5", () => {
  const config = SAFETY_WEIGHTS.crime;
  assert.equal(combineCrimeLevels([], config, 10), null);
  assert.equal(combineCrimeLevels([null, null], config, 10), null, "noData뿐이면 데이터 없음이다");

  const low = combineCrimeLevels([1, 1, 1], config, 10)!;
  assert.equal(low.sampleCount, 3);
  assert.ok(Math.abs(low.meanRisk - 0.1) < 1e-9);
  assert.equal(low.highRiskRatio, 0);
  assert.equal(low.crimeLevel, 0, "최저 등급만 있는 구간은 감점 단계 0이다");

  const severe = combineCrimeLevels([10, 10], config, 10)!;
  assert.ok(Math.abs(severe.crimeRisk - 1) < 1e-9);
  assert.equal(severe.crimeLevel, 5);

  const mixed = combineCrimeLevels([5, 10], config, 10)!;
  assert.equal(mixed.meanRisk, 0.75);
  assert.equal(mixed.maxRisk, 1);
  assert.equal(mixed.highRiskRatio, 0.5);
  assert.ok(Math.abs(mixed.crimeRisk - 0.725) < 1e-9);
  assert.equal(mixed.crimeLevel, 3);

  const withGaps = combineCrimeLevels([5, null], config, 10)!;
  assert.equal(withGaps.sampleCount, 2, "noData 샘플도 표본 수에는 포함된다");
  assert.equal(withGaps.meanRisk, 0.5, "noData는 통계에서 제외된다 (위험도 0이 아님)");
});

const base: SafetyDataset = {
  features: featureCollection([]),
  riskZones: featureCollection([]),
  roadSegments: featureCollection([]),
  metadata: { sourceKind: "static", scoreKind: "client", updatedAt: "" },
};
const road = lineString([[126.9232, 35.1461], [126.9282, 35.1461]],
  { id: "test-road", name: "test", source: "test" });
const entry: CrimeRiskSummary = {
  crimeRisk: 0, level: 0, mean: 0, max: 0, highRiskRatio: 0, sampleCount: 3, noDataRatio: 0,
};

test("crimeScore=null (미수집)과 crimeScore=100 (데이터상 낮음)은 구별된다", () => {
  const scored = (crimeRiskByRoad?: SafetyDataset["crimeRiskByRoad"]) =>
    calculateRoadSafety({ ...base, roadSegments: featureCollection([road]), crimeRiskByRoad }).features[0].properties;

  const sampled = scored({ "test-road": entry });
  assert.equal(sampled.crimeScore, 100);
  assert.equal(sampled.crimeSampleCount, 3);

  const unsampled = scored(undefined);
  assert.equal(unsampled.crimeScore, null);
  assert.equal(unsampled.crimeSampleCount, null);
  assert.ok(sampled.safetyScore === unsampled.safetyScore,
    "최저 등급 감점은 0이므로 점수는 같지만 데이터 유무 표기는 다르다");
});

test("WMS sampling level maps to the existing crimeRisk penalty table", () => {
  const calm = calculateRoadSafety({ ...base, roadSegments: featureCollection([road]),
    crimeRiskByRoad: { testRoad: entry } }).features[0].properties;
  const risky = calculateRoadSafety({ ...base, roadSegments: featureCollection([road]),
    crimeRiskByRoad: { "test-road": { ...entry, crimeRisk: 0.72, level: 3 } } }).features[0].properties;
  assert.equal(risky.crimeScore, 52); // 100 - (12/25)×100 — 기존 3단계 감점표
  assert.equal(risky.safetyScore, calm.safetyScore - 12);
});
