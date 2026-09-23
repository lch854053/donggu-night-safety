import assert from "node:assert/strict";
import test from "node:test";
import { destination, featureCollection, lineString, point } from "@turf/turf";

import { calculateRoadSafety } from "../lib/scoring/calculateRoadSafety";
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

interface NightFacilityOptions {
  meters: number;
  nightScore?: number;
  category?: string;
  openingHours?: string;
}

/** 도로 시작점에서 bearing 0(북쪽 직각)으로 meters 떨어진 야간 운영시설. */
function nightFacility({
  meters,
  nightScore = 1,
  category = "convenience_store",
  openingHours = "24/7",
}: NightFacilityOptions): Feature<Point, SafetyFeatureProperties> {
  return point(destination(ROAD_START, meters / 1000, 0).geometry.coordinates, {
    id: `night-${meters}-${nightScore}-${category}`,
    type: "night_activity",
    name: "야간 시설",
    source: "openstreetmap",
    category,
    openingHours,
    nightScore,
    confidence: 0.9,
    nightTier: nightScore === 1 ? "24h" : nightScore === 0.15 ? "unknown" : "02",
    nightOpen22: true,
    nightOpen00: true,
    nightOpen02: true,
  }) as Feature<Point, SafetyFeatureProperties>;
}

function scored(features: Feature<Point, SafetyFeatureProperties>[]) {
  return calculateRoadSafety({
    features: featureCollection(features),
    riskZones: featureCollection([]),
    roadSegments: featureCollection([road]),
    metadata: { sourceKind: "static", scoreKind: "client", updatedAt: "" },
  }).features[0].properties;
}

test("night facilities near the road raise nightActivityScore", () => {
  const baseline = scored([]);
  const withFacility = scored([nightFacility({ meters: 10 })]);
  assert.equal(baseline.nightActivityScore, undefined, "미수집이면 필드 자체가 없다");
  assert.ok((withFacility.nightActivityScore ?? 0) > 0);
  // 하나의 24시간 편의점: 감쇠 1 × night 1 × 유형 1 = 1 → 25×log2(2)=25점.
  assert.equal(withFacility.nightActivityScore, 25);
  // 시설이 충분하면(7개 = sum 7 → 75점) 활동 차원 점수도 baseline(폭원 proxy만, 40점)보다 올라간다.
  const withMany = scored(
    Array.from({ length: 7 }, (_, i) => nightFacility({ meters: 10 + i * 5 })),
  );
  assert.ok(withMany.activityScore! > baseline.activityScore!);
});

test("distance decay: closer facilities contribute more", () => {
  const close = scored([nightFacility({ meters: 10 })]);
  const mid = scored([nightFacility({ meters: 40 })]);
  const far = scored([nightFacility({ meters: 80 })]);
  const beyond = scored([nightFacility({ meters: 150 })]);
  assert.ok(close.nightActivityScore! > mid.nightActivityScore!);
  assert.ok(mid.nightActivityScore! > far.nightActivityScore!);
  assert.equal(beyond.nightActivityScore, 0, "100m 반경 밖은 기여 없음");
});

test("saturation: 20 facilities never beat 2 facilities by 10x", () => {
  const two = scored([nightFacility({ meters: 10 }), nightFacility({ meters: 15 })]);
  const twenty = scored(
    Array.from({ length: 20 }, (_, i) => nightFacility({ meters: 5 + i * 2 })),
  );
  assert.ok(twenty.nightActivityScore! > two.nightActivityScore!, "많으면 더 높다");
  const ratio = twenty.nightActivityScore! / two.nightActivityScore!;
  assert.ok(ratio < 10, `포화 비율 ${ratio.toFixed(2)} < 10 — 시설 20개가 2개의 10배가 되지 않는다`);
  assert.ok(twenty.nightActivityScore! <= 100, "100점 상한");
});

test("night score and category weights both apply", () => {
  const round = (n: number) => Math.round(n);
  const full24 = scored([nightFacility({ meters: 10, nightScore: 1 })]);
  const unknownHours = scored([nightFacility({ meters: 10, nightScore: 0.15 })]);
  const dayOnly = scored([nightFacility({ meters: 10, nightScore: 0 })]);
  const pharmacy = scored([nightFacility({ meters: 10, nightScore: 1, category: "pharmacy" })]);
  const restaurant = scored([nightFacility({ meters: 10, nightScore: 1, category: "restaurant" })]);

  assert.ok(full24.nightActivityScore! > unknownHours.nightActivityScore!, "영업시간 미확인은 기여가 약하다");
  assert.equal(dayOnly.nightActivityScore, 0, "주간 전용은 기여 없음");
  assert.ok(
    round(pharmacy.nightActivityScore!) > round(restaurant.nightActivityScore!),
    "유형 가중치(pharmacy 1.0 > restaurant 0.6)가 적용된다",
  );
});
