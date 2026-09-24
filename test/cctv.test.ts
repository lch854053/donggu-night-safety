import assert from "node:assert/strict";
import test from "node:test";
import { destination, lineString, point, polygon } from "@turf/turf";
import { buildMunicipalCctv, fetchCctvSnapshot } from "../scripts/cctv.mjs";
import { CCTV_PURPOSE_CONFIDENCE } from "../config/cctvPurpose.mjs";
import { computeSurveillanceScore } from "../lib/scoring/surveillance";
import { calculateRoadSafety } from "../lib/scoring/calculateRoadSafety";
import type { SafetyFeatureProperties, SafetyFeatureType } from "../types/safety";
import type { Feature, Point } from "geojson";

const center: [number, number] = [126.92, 35.14];
const boundary = polygon([[[126.91, 35.13], [126.93, 35.13], [126.93, 35.15], [126.91, 35.15], [126.91, 35.13]]]);
const row = (x: number | null, y: number | null, address = "동구 중앙로 1", cameras = 1) => ({
  경도: x == null ? null : String(x), 위도: y == null ? null : String(y),
  소재지도로명주소: address, 소재지지번주소: "", 카메라대수: cameras,
});

test("실제 동구 경계·주소를 모두 확인하고 동일 설치지점의 여러 카메라를 병합한다", () => {
  const records = [row(...center, "동구 중앙로 1", 2), row(...center, "동구 중앙로 1", 1),
    row(126.92001, 35.14001, "동구 중앙로 1", 1),
    row(126.92, 35.14, "서구 중앙로 1"), row(126.92, 35.14, "부산광역시 동구 중앙로 1"),
    row(126.94, 35.14), row(null, 35.14)];
  const { features, stats } = buildMunicipalCctv(records, [
    { 소재지도로명주소: "광주광역시 동구 중앙로 1", 설치목적구분: "생활방범" },
  ], [boundary]);
  assert.equal(features.length, 1);
  assert.equal(features[0].properties.cameraCount, 4);
  assert.equal(features[0].properties.purpose, "crime_prevention");
  assert.equal(features[0].properties.purposeSource, "historical");
  assert.equal(stats.excludedDuplicateRows, 2);
  assert.equal(stats.excludedAddressCoordinateMismatch, 3);
  assert.equal(stats.excludedInvalidCoordinate, 1);
});

test("모호한 역사 목적은 미확인으로 두고 빈·실패 API 응답은 거부한다", async () => {
  const { features } = buildMunicipalCctv([row(...center)], [
    { 소재지도로명주소: "동구 중앙로 1", 설치목적구분: "생활방범" },
    { 소재지도로명주소: "동구 중앙로 1", 설치목적구분: "쓰레기단속" },
  ], [boundary]);
  assert.equal(features[0].properties.purpose, "unknown");
  assert.equal(features[0].properties.confidence, CCTV_PURPOSE_CONFIDENCE.unknown);
  assert.throws(() => buildMunicipalCctv([row(126.94, 35.14)], [], [boundary]));
  await assert.rejects(fetchCctvSnapshot("sample", "key", async () =>
    ({ ok: false, status: 401 } as Response)));
  await assert.rejects(fetchCctvSnapshot("sample", "key", async () =>
    ({ ok: true, json: async () => ({ totalCount: 2, data: [row(...center)] }) } as Response)),
  /수집 누락/);
});

test("과거 주소 자료가 없을 때 같은 주소·근접 좌표의 기존 CCTV 목적을 참고한다", () => {
  const legacy = point([126.92001, 35.14001], { id: "legacy", type: "cctv",
    name: "기존", source: "mois:cctv_info", address: "광주광역시 동구 중앙로 1",
    purpose: "waste", confidence: CCTV_PURPOSE_CONFIDENCE.waste }) as Feature<Point, SafetyFeatureProperties>;
  const result = buildMunicipalCctv([row(...center)], [], [boundary], [legacy]);
  const municipal = result.features.find((feature) => feature.properties.id.startsWith("cctv-municipal"));
  assert.equal(municipal?.properties.purpose, "waste");
  assert.equal(municipal?.properties.purposeSource, "current");
  assert.equal(result.stats.excludedLegacyOverlaps, 1);
  assert.equal(result.features.length, 1);
  const outsideLegacy = point([126.94, 35.14], { ...legacy.properties, id: "neighbor" }) as Feature<Point, SafetyFeatureProperties>;
  assert.equal(buildMunicipalCctv([row(...center)], [], [boundary], [legacy, outsideLegacy]).features.length, 2,
    "동구 인접 지역의 기존 시설은 유지한다");
});

const road = lineString([center, destination(center, 0.01, 90).geometry.coordinates]);
function cctv(meters: number, confidence: number, coordinates?: number[]): Feature<Point, SafetyFeatureProperties> {
  return point(coordinates ?? destination(center, meters / 1000, 0).geometry.coordinates, {
    id: `cctv-${meters}`, type: "cctv", name: "CCTV", source: "test", confidence,
  }) as Feature<Point, SafetyFeatureProperties>;
}
const score = (items: Feature<Point, SafetyFeatureProperties>[]) =>
  computeSurveillanceScore(road, items, new Set<SafetyFeatureType>(items.map((item) => item.properties.type)));

test("먼 생활방범이 가까운 쓰레기단속보다 유효점수가 높고 쓰레기단속도 0점이 아니다", () => {
  const crime = cctv(100, 1);
  const waste = cctv(20, 0.4);
  assert.equal(score([crime]).cctvScore, 50);
  assert.equal(score([waste]).cctvScore, 37);
  assert.equal(score([crime, waste]).cctvScore, 55);
  assert.equal(score([cctv(0, 0.5)]).cctvScore, 50);
});

test("동일 좌표 카메라 여러 대는 보너스가 없고 다른 지표·미수집 재정규화는 보존한다", () => {
  const site = cctv(50, 1);
  const duplicate = cctv(50, 1, site.geometry.coordinates);
  assert.equal(score([site]).cctvScore, score([site, duplicate]).cctvScore);
  assert.equal(score([]).cctvScore, null);
  assert.equal(score([]).score, null);
  const bell = point(destination(center, 0.02, 0).geometry.coordinates, {
    id: "bell", type: "emergency_bell", name: "비상벨", source: "test",
  }) as Feature<Point, SafetyFeatureProperties>;
  assert.equal(score([site, bell]).emergencyBellScore, score([site, duplicate, bell]).emergencyBellScore);
  assert.equal(score([bell]).cctvScore, null);
});

test("구버전 v1 CCTV 가점도 목적 신뢰계수와 한 설치지점을 따른다", () => {
  const calculate = (features: Feature<Point, SafetyFeatureProperties>[]) =>
    calculateRoadSafety({ features: { type: "FeatureCollection", features },
      roadSegments: { type: "FeatureCollection", features: [lineString(road.geometry.coordinates,
        { id: "road", name: "road", source: "test" })] },
      riskZones: { type: "FeatureCollection", features: [] },
      metadata: { sourceKind: "static", scoreKind: "client", updatedAt: "" },
    }).features[0].properties;
  const waste = cctv(20, 0.4);
  const crime = cctv(120, 1);
  assert.equal(calculate([waste]).safetyScore - calculate([]).safetyScore, 4);
  assert.equal(calculate([waste, waste]).cctvCount, 1);
  assert.equal(calculate([crime, waste]).safetyScore - calculate([]).safetyScore, 4,
    "v1은 100m 이내만 가산한다");
});
