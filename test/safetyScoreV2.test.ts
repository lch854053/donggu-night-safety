import assert from "node:assert/strict";
import test from "node:test";
import { destination, featureCollection, lineString, point } from "@turf/turf";

import { calculateRoadSafety } from "../lib/scoring/calculateRoadSafety";
import { interpolatedBandScore, stepScore } from "../lib/scoring/proximityScore";
import { combineDimensionScores, weightedAverageAvailable } from "../lib/scoring/weightedAverage";
import type { Feature, LineString, Point } from "geojson";
import type {
  RoadSegmentProperties,
  SafetyDataset,
  SafetyFeatureProperties,
  SafetyFeatureType,
} from "../types/safety";

const ROAD_START: [number, number] = [126.9232, 35.1461];
const road = lineString(
  [ROAD_START, destination(ROAD_START, 0.3, 90).geometry.coordinates],
  { id: "test-road", name: "테스트 도로", source: "test", pedestrianAccess: "yes", widthMeters: 8 },
) as Feature<LineString, RoadSegmentProperties>;

function facility(
  type: SafetyFeatureType,
  meters: number,
  bearing = 0,
  index = 0,
): Feature<Point, SafetyFeatureProperties> {
  // bearing 0(북쪽 직각)이면 도로 시작점에서 정확히 meters 떨어진 최근접 거리가 된다.
  return point(destination(ROAD_START, meters / 1000, bearing).geometry.coordinates, {
    id: `${type}-${meters}-${bearing}-${index}`,
    type,
    name: type,
    source: "test",
  }) as Feature<Point, SafetyFeatureProperties>;
}

function dataset(features: Feature<Point, SafetyFeatureProperties>[], crimeRiskByRoad?: SafetyDataset["crimeRiskByRoad"]): SafetyDataset {
  return {
    features: featureCollection(features),
    riskZones: featureCollection([]),
    roadSegments: featureCollection([road]),
    metadata: { sourceKind: "static", scoreKind: "client", updatedAt: "" },
    ...(crimeRiskByRoad ? { crimeRiskByRoad } : {}),
  };
}

function scored(features: Feature<Point, SafetyFeatureProperties>[], crimeRiskByRoad?: SafetyDataset["crimeRiskByRoad"]) {
  return calculateRoadSafety(dataset(features, crimeRiskByRoad)).features[0].properties;
}

test("weightedAverageAvailable renormalizes available weights and null collapses to null", () => {
  assert.equal(
    weightedAverageAvailable([
      { value: 100, weight: 0.5 },
      { value: null, weight: 0.25 },
      { value: 100, weight: 0.15 },
      { value: null, weight: 0.1 },
    ]),
    100,
  );
  assert.equal(
    weightedAverageAvailable([
      { value: 100, weight: 0.5 },
      { value: 0, weight: 0.5 },
    ]),
    50,
  );
  assert.equal(
    weightedAverageAvailable([{ value: null, weight: 1 }]),
    null,
    "전부 null이면 결과도 null — 0과 다른 의미다",
  );
});

test("band and step helpers follow their declared shapes", () => {
  const cctvBands = [[0, 100], [50, 80], [100, 50], [150, 20], [200, 0]] as const;
  assert.equal(interpolatedBandScore(0, cctvBands), 100);
  assert.equal(interpolatedBandScore(50, cctvBands), 80);
  assert.equal(interpolatedBandScore(75, cctvBands), 65);
  assert.equal(interpolatedBandScore(300, cctvBands), 0);
  const nightSteps = [[0, 0], [1, 30], [2, 60], [4, 80], [7, 100]] as const;
  assert.equal(stepScore(0, nightSteps), 0);
  assert.equal(stepScore(1, nightSteps), 30);
  assert.equal(stepScore(3, nightSteps), 60);
  assert.equal(stepScore(10, nightSteps), 100);
});

test("closer CCTV scores higher and CCTV beyond 200m has no influence", () => {
  const near = scored([facility("cctv", 30)]);
  const mid = scored([facility("cctv", 120)]);
  const far = scored([facility("cctv", 220)]);
  assert.ok(near.cctvScore! > mid.cctvScore!, `${near.cctvScore} > ${mid.cctvScore}`);
  assert.equal(near.cctvScore, 88, "0~50m 구간 선형 보간");
  assert.equal(mid.cctvScore, 38, "100~150m 구간 선형 보간");
  assert.equal(far.cctvScore, 0, "반경 밖 CCTV는 영향이 없다");
  assert.ok(near.surveillanceScore! > mid.surveillanceScore!);
});

test("서로 다른 CCTV 설치지점 개수 보너스는 3곳 이상 포화된다", () => {
  const one = scored([facility("cctv", 60)]);
  const separateSites = Array.from({ length: 10 }, (_, i) => {
    const site = facility("cctv", 60, 0, i);
    return { ...site, geometry: { ...site.geometry, coordinates:
      destination(site.geometry.coordinates, i / 1000, 90).geometry.coordinates } };
  });
  const three = scored(separateSites.slice(0, 3));
  const ten = scored(separateSites);
  assert.ok(three.cctvScore! > one.cctvScore!, "보너스는 존재한다");
  assert.equal(ten.cctvScore, three.cctvScore, "3대 이상 보너스는 포화된다");
  assert.ok(ten.cctvScore! <= 100);
});

test("closer vacant houses push environmentScore down", () => {
  const baseline = scored([facility("cctv", 20)]);
  const nearby = scored([facility("cctv", 20), facility("vacant_house", 10)]);
  const distant = scored([facility("cctv", 20), facility("vacant_house", 200)]);
  assert.equal(baseline.environmentScore, 100);
  assert.equal(distant.environmentScore, 100, "반경 밖 빈집은 데이터로 치지 않는다");
  assert.ok(nearby.environmentScore! < baseline.environmentScore!);
  assert.ok(nearby.safetyScoreV2! < baseline.safetyScoreV2!);
});

test("old buildings alone cannot cause an outsized penalty", () => {
  const baseline = scored([]);
  const aged = scored([1, 2, 3, 4, 5].map((i) => facility("old_building", 20, 0, i)));
  // 노후건축물이 5채여도 deterioration 40점(하한)까지만 떨어진다.
  assert.equal(aged.deteriorationScore, 40);
  assert.equal(baseline.environmentScore, 100);
  const drop = baseline.environmentScore! - aged.environmentScore!;
  assert.ok(drop > 0 && drop <= 60, `environmentScore 하락은 60점 상한(=60×40의 하한) 안: ${drop}`);
  // v2에서 environment 가중치는 0.15이므로 최종점수 타격은 구버전 -8 직접 감점보다 작거나 비슷하다.
  const v2Drop = baseline.safetyScoreV2! - aged.safetyScoreV2!;
  assert.ok(v2Drop >= 0 && v2Drop <= 30, `최종점수 타격 제한: ${v2Drop}`);
});

test("missing CPTED must not collapse surveillanceScore to zero", () => {
  const withFacilities = scored([facility("cctv", 20), facility("emergency_bell", 20)]);
  // CPTED·경찰시설은 데이터셋에 없으므로 재정규화 대상: CCTV·비상벨만으로 계산한다.
  assert.equal(withFacilities.cctvScore, 92);
  assert.equal(withFacilities.emergencyBellScore, 88);
  assert.equal(withFacilities.cptedScore, undefined, "미수집 항목 필드는 생략된다");
  assert.equal(withFacilities.policeScore, undefined);
  assert.equal(withFacilities.surveillanceScore, Math.round((92 * 0.5 + 88 * 0.15) / 0.65));
});

test("all-null sub-indicators make the whole dimension null", () => {
  const result = scored([facility("old_building", 20)]);
  assert.equal(result.surveillanceScore, null);
  // 활동 차원은 폭원 proxy(roadActivity) 하나만 있어도 계산된다(0점 아님).
  assert.equal(result.roadActivityScore, 40);
  assert.equal(result.activityScore, 40);
  // 환경 차원은 old_building(데이터 있음)+sidewalk(속성 있음)만으로 계산된다.
  assert.ok(result.environmentScore !== null);
});

test("only a confirmed executed road grade modifies the existing width proxy", () => {
  const base = dataset([]);
  const evaluate = (grade?: RoadSegmentProperties["planningRoadGrade"], status?: string) => {
    const input = { ...base, roadSegments: featureCollection([lineString(road.geometry.coordinates, {
      ...road.properties, ...(grade ? { planningRoadGrade: grade, planningRoadStatus: status } : {}),
    }) as Feature<LineString, RoadSegmentProperties>]) };
    return calculateRoadSafety(input).features[0].properties;
  };
  const original = evaluate();
  assert.equal(original.roadActivityScore, 40);
  assert.equal(evaluate("대로", "미집행").roadActivityScore, 40);
  assert.equal(evaluate("중로", "부분집행").roadActivityScore, 40);
  assert.equal(evaluate("소로", "집행완료").roadActivityScore, 37);
  assert.equal(evaluate("중로", "집행완료").roadActivityScore, 43);
  assert.equal(evaluate("대로", "집행완료").roadActivityScore, 48);
  assert.equal(evaluate("광로", "집행완료").roadActivityScore, 50);
  assert.equal(evaluate("대로", "집행완료").safetyScore, original.safetyScore,
    "legacy v1 score stays unchanged");
});

test("crimeScore null and crimeScore 0 are treated differently", () => {
  const noData = scored([], undefined);
  const worst = scored([], {
    "test-road": {
      crimeRisk: 1, level: 5, mean: 1, max: 1, highRiskRatio: 1,
      sampleCount: 3, noDataRatio: 0,
    },
  });
  const best = scored([], {
    "test-road": {
      crimeRisk: 0, level: 0, mean: 0, max: 0, highRiskRatio: 0,
      sampleCount: 3, noDataRatio: 0,
    },
  });
  assert.equal(noData.crimeScore, null);
  assert.equal(worst.crimeScore, 0);
  assert.ok(best.safetyScoreV2! > worst.safetyScoreV2!, "0점은 실제 감점으로 작동한다");
  assert.ok(
    noData.safetyScoreV2! > worst.safetyScoreV2!,
    "미수집은 재정규화로 제외되어 위험구간(0점) 취급이 아니다",
  );
  assert.notEqual(noData.safetyScoreV2, worst.safetyScoreV2);
});

test("final v2 score follows the declared composite", () => {
  const weights = { lighting: 0.25, surveillance: 0.2, activity: 0.15, environment: 0.15, crime: 0.25 };
  assert.equal(combineDimensionScores(
    { lighting: 100, surveillance: 100, activity: 100, environment: 100, crime: 100 },
  ), 100);
  assert.equal(combineDimensionScores(
    { lighting: 0, surveillance: 0, activity: 0, environment: 0, crime: 0 },
  ), 0);
  assert.equal(combineDimensionScores(
    { lighting: 100, surveillance: 100, activity: 100, environment: 100, crime: 0 },
  ), Math.round(weights.lighting * 100 + weights.surveillance * 100 + weights.activity * 100 + weights.environment * 100));
  // 범죄 차원만 미수집이면 나머지 0.75로 재정규화된다.
  assert.equal(combineDimensionScores(
    { lighting: 100, surveillance: 100, activity: 100, environment: 100, crime: null },
  ), 100);
  assert.equal(combineDimensionScores(
    { lighting: 100, surveillance: null, activity: null, environment: null, crime: null },
  ), 100);
});

test("shipped data keeps legacy score alongside v2 dimensions", () => {
  const props = scored([facility("cctv", 20), facility("convenience_store", 30)]);
  assert.ok(Number.isFinite(props.safetyScore), "v1 점수는 그대로 계산·보존된다");
  assert.ok(Number.isFinite(props.safetyScoreV2!));
  assert.ok(props.safetyScoreV2! >= 0 && props.safetyScoreV2! <= 100);
  assert.ok(props.lightingScore >= 0 && props.lightingScore <= 100);
  // roadActivity(폭원 8m → 40점)와 편의점 1개(40점)로 activity가 재정규화된다.
  assert.equal(props.roadActivityScore, 40);
  assert.equal(props.convenienceStoreScore, 40);
  assert.equal(props.nightActivityScore, undefined, "야간활동 POI 미수집");
  assert.equal(props.vacancyScore, undefined, "빈집 미수집");
  assert.ok(props.activityScore! > 0);
});
