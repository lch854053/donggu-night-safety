import assert from "node:assert/strict";
import test from "node:test";
import { featureCollection, lineString, polygon } from "@turf/turf";
import { buildRoadLightingEvidence, roadNameFromAddress } from "../scripts/road-light-evidence.mjs";

const road = (id, name, lon = 126.92) => lineString([[lon - .001, 35.12], [lon + .001, 35.12]],
  { id, name, roadNameSource: "LT_L_SPRD", adminDong: "지원1동" });
const boundaries = featureCollection([polygon([[[126.9, 35.1], [126.95, 35.1],
  [126.95, 35.15], [126.9, 35.15], [126.9, 35.1]]], { adm_nm: "전남광주통합특별시 동구 지원1동" })]);
const group = (roadAddresses = ["화산로205"], coord = [126.92, 35.12], recordCount = 20) => ({
  roadAddresses, parcelAddresses: ["용산동 634-1"], representativeCoordinates: coord, recordCount,
});

test("도로명 파서는 번길·안길과 본도로를 구분한다", () => {
  assert.equal(roadNameFromAddress("광주광역시 동구 필문대로 123"), "필문대로");
  assert.equal(roadNameFromAddress("화산로205"), "화산로");
  assert.equal(roadNameFromAddress("제봉로213번길8-27"), "제봉로213번길");
});

test("같은 도로명과 가까운 대표좌표는 연속 구간에 연결되며 중복행은 포화된다", () => {
  const roads = featureCollection([road("a", "화산로"), road("b", "화산로", 126.921), road("side", "다른길")]);
  const result = buildRoadLightingEvidence([group()], roads, boundaries);
  assert.equal(result.diagnostics.matchedRows, 20);
  assert.equal(result.roads.a.matchMethod, "road_name_and_coordinate");
  assert.equal(result.roads.a.matchedRecordCount, 20);
  assert.ok(result.roads.b && !result.roads.side);
  assert.ok(result.roads.a.roadLightingEvidence <= 1);
  const single = buildRoadLightingEvidence([group(["화산로205"], [126.92, 35.12], 1)], roads, boundaries);
  assert.ok(result.roads.a.roadLightingEvidence > single.roads.a.roadLightingEvidence);
});

test("먼 동명 도로·주소 없는 좌표는 가장 가까운 도로에 강제 귀속하지 않는다", () => {
  const roads = featureCollection([road("far", "화산로", 126.935), road("other", "다른길")]);
  const result = buildRoadLightingEvidence([group(), { ...group([], [126.92, 35.12], 1), parcelAddresses: [] }], roads, boundaries);
  assert.deepEqual(result.roads, {});
  assert.equal(result.diagnostics.unmatchedRows, 21);
  assert.ok(result.diagnostics.distantSameName[0].nearestMeters >= 300);
});

test("지번만 있으면 행정동과 인접 도로명을 함께 확인한 낮은 근거로 기록한다", () => {
  const roads = featureCollection([road("parcel", "화산로")]);
  const result = buildRoadLightingEvidence([group([])], roads, boundaries);
  assert.equal(result.roads.parcel.matchMethod, "parcel_and_coordinate");
  assert.equal(result.roads.parcel.matchConfidence, 0.6);
});
