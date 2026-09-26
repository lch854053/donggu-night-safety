import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { featureCollection, lineString, polygon, length } from "@turf/turf";
import { buildRoadLightingEvidence, corridorLength, roadNameFromAddress } from "../scripts/road-light-evidence.mjs";
import { buildRoadLightCorridors } from "../scripts/road-light-corridors.mjs";

const road = (id, name, start = 126.92, end = start + .0001, y = 35.12) =>
  lineString([[start, y], [end, y]], { id, name, roadNameSource: "LT_L_SPRD", adminDong: "지원1동" });
const boundaries = featureCollection([polygon([[[126.9, 35.1], [126.95, 35.1],
  [126.95, 35.15], [126.9, 35.15], [126.9, 35.1]]], { adm_nm: "전남광주통합특별시 동구 지원1동" })]);
const cluster = (roadAddresses = ["화산로205"], coord = [126.92, 35.12], managedUnitCount = 33) => ({
  clusterId: "동구-01", roadAddresses, parcelAddresses: ["용산동 634-1"],
  representativeCoordinate: coord, managedUnitCount, dataAsOf: "2024-04-15",
});

test("도로명 파서는 번길·안길과 본도로를 구분한다", () => {
  assert.equal(roadNameFromAddress("광주광역시 동구 필문대로 123"), "필문대로");
  assert.equal(roadNameFromAddress("화산로205"), "화산로");
  assert.equal(roadNameFromAddress("제봉로213번길8-27"), "제봉로213번길");
});

test("anchor에서 연결된 도로만 퍼지고 같은 이름의 단절 구간은 제외한다", () => {
  const roads = featureCollection([
    road("anchor", "화산로"), road("linked", "화산로", 126.9201),
    road("disconnected", "화산로", 126.9202, 126.9203, 35.1202),
    road("other", "다른길", 126.9202),
  ]);
  const result = buildRoadLightingEvidence([cluster()], roads, boundaries);
  assert.equal(result.diagnostics.matchedRows, 33);
  assert.equal(result.roads.anchor.matchMethod, "road_name_and_coordinate");
  assert.deepEqual(result.roads.anchor.clusterIds, ["동구-01"]);
  assert.equal(result.roads.anchor.managedUnitCount, 33);
  assert.ok(result.roads.linked && !result.roads.disconnected && !result.roads.other);
  assert.ok(result.diagnostics.disconnectedNearby.some((x) => x.sampleRoadIds.includes("disconnected")));
  assert.deepEqual(result.diagnostics.disconnectedPropagation, []);
  const lines = buildRoadLightCorridors([cluster()], roads, result);
  assert.equal(lines.features.length, 1);
  assert.equal(lines.features[0].geometry.type, "MultiLineString");
  assert.equal(lines.features[0].geometry.coordinates.length, 2);
  assert.deepEqual(lines.features[0].geometry.coordinates[0], roads.features[0].geometry.coordinates,
    "추정선은 실제 도로 중심선 도형을 그대로 사용한다");
  assert.equal(lines.features[0].properties.estimated, true);
});

test("corridor 길이 밖 구간과 원거리 동일 도로명은 매칭하지 않는다", () => {
  const segments = Array.from({ length: 28 }, (_, i) =>
    road(`part-${i}`, "화산로", +(126.92 + i * .0001).toFixed(6), +(126.92 + (i + 1) * .0001).toFixed(6)));
  const result = buildRoadLightingEvidence([cluster()], featureCollection(segments), boundaries);
  assert.ok(result.roads["part-0"] && result.roads["part-7"]);
  assert.equal(result.roads["part-25"], undefined);
  assert.ok(result.diagnostics.clusterLinks[0].linkedRoadCount <= 20);
  assert.equal(corridorLength(1, "C2") < corridorLength(33, "C2"), true);
  assert.equal(corridorLength(100000, "C2"), 500);
});

test("갈림길의 여러 가지와 긴 segment도 관리그룹당 도형 총 길이 상한을 넘지 않는다", () => {
  const roads = featureCollection([
    road("anchor", "화산로", 126.9200, 126.9205),
    road("east", "화산로", 126.9205, 126.9220),
    lineString([[126.9205, 35.12], [126.9205, 35.1215]],
      { id: "north", name: "화산로", roadNameSource: "LT_L_SPRD", adminDong: "지원1동" }),
    lineString([[126.9205, 35.12], [126.9205, 35.1185]],
      { id: "south", name: "화산로", roadNameSource: "LT_L_SPRD", adminDong: "지원1동" }),
  ]);
  const result = buildRoadLightingEvidence([cluster(["화산로205"], [126.9204, 35.12])], roads, boundaries);
  const line = buildRoadLightCorridors([cluster(["화산로205"], [126.9204, 35.12])], roads, result).features[0];
  assert.ok(line.properties.corridorLengthMeters <= 200);
  const realLength = length(line, { units: "kilometers" }) * 1000;
  assert.ok(realLength <= 201, `실제 도형 ${realLength.toFixed(1)}m`);
  assert.equal(line.geometry.coordinates.length, result.diagnostics.clusterLinks[0].linkedRoadCount);
});

test("하나의 cluster가 여러 구간에 연결돼도 관리대상은 도로별 중복 가산하지 않는다", () => {
  const roads = featureCollection([road("a", "화산로"), road("b", "화산로", 126.9201)]);
  const result = buildRoadLightingEvidence([cluster()], roads, boundaries);
  assert.equal(result.roads.a.managedUnitCount, 33);
  assert.equal(result.roads.b.managedUnitCount, 33);
  assert.deepEqual(result.roads.a.clusterIds, result.roads.b.clusterIds);
  assert.ok(result.roads.b.roadLightingEvidence < result.roads.a.roadLightingEvidence);
  assert.equal(result.diagnostics.clusterLinks[0].managedUnitCount, 33);
  assert.deepEqual(result.diagnostics.duplicateClusterOnRoad, []);
  const one = buildRoadLightingEvidence([cluster(["화산로205"], [126.92, 35.12], 1)], roads, boundaries);
  assert.equal(result.roads.a.roadLightingEvidence, one.roads.a.roadLightingEvidence,
    "기본 C 모델은 관리대상 수로 밝기 강도를 올리지 않는다");
});

test("연속 cluster가 있는 도로구간은 단일 cluster보다 연속성 및 추정 점수가 높다", () => {
  const roads = featureCollection(Array.from({ length: 8 }, (_, i) =>
    road(`r${i}`, "화산로", +(126.92 + .0001 * i).toFixed(6), +(126.92 + .0001 * (i + 1)).toFixed(6))));
  const one = buildRoadLightingEvidence([cluster()], roads, boundaries);
  const two = buildRoadLightingEvidence([cluster(), { ...cluster(), clusterId: "동구-02",
    representativeCoordinate: [126.9206, 35.12] }], roads, boundaries);
  assert.ok(two.roads.r3.roadLightingContinuity > one.roads.r3.roadLightingContinuity);
  assert.ok(two.roads.r3.roadLightingScore > one.roads.r3.roadLightingScore);
});

test("먼 도로명·주소 없는 대표좌표는 가장 가까운 도로에 강제 귀속하지 않는다", () => {
  const roads = featureCollection([road("far", "화산로", 126.935), road("other", "다른길")]);
  const result = buildRoadLightingEvidence([cluster(), { ...cluster([], [126.92, 35.12], 1),
    clusterId: "동구-02", parcelAddresses: [] }], roads, boundaries);
  assert.deepEqual(result.roads, {});
  assert.equal(result.diagnostics.unmatchedRows, 34);
  assert.ok(result.diagnostics.distantSameName[0].nearestMeters >= 300);
});

test("지번만 있으면 같은 행정동의 인접 단일 도로명을 낮은 신뢰도로 매칭한다", () => {
  const result = buildRoadLightingEvidence([cluster([])], featureCollection([road("parcel", "화산로")]), boundaries);
  assert.equal(result.roads.parcel.matchMethod, "parcel_and_coordinate");
  assert.equal(result.roads.parcel.matchConfidence, 0.6);
});

test("배포용 도로 근거의 관리대상 합계는 고유 cluster만 세고 Point 광원은 없다", () => {
  const clusters = JSON.parse(readFileSync(new URL("../public/data/road-light-clusters.json", import.meta.url))).clusters;
  const evidence = JSON.parse(readFileSync(new URL("../public/data/road-light-evidence.json", import.meta.url)));
  const facilities = JSON.parse(readFileSync(new URL("../public/data/safety-features.geojson", import.meta.url)));
  const counts = new Map(clusters.map((c) => [c.clusterId, c.managedUnitCount]));
  assert.equal(evidence.diagnostics.recordCount, [...counts.values()].reduce((a, b) => a + b, 0));
  assert.equal(evidence.diagnostics.linkedRoadCount, Object.keys(evidence.roads).length);
  const lines = JSON.parse(readFileSync(new URL("../public/data/road-light-corridors.geojson", import.meta.url)));
  assert.equal(lines.features.length, evidence.diagnostics.matchedClusterCount);
  assert.ok(lines.features.every((feature) => feature.properties.estimated && feature.geometry.type === "MultiLineString"));
  assert.ok(lines.features.every((feature) => feature.properties.corridorLengthMeters <=
    (feature.properties.matchMethod === "parcel_and_coordinate" ? 150 : 200)));
  assert.ok(lines.features.every((feature) => length(feature, { units: "kilometers" }) * 1000 <=
    (feature.properties.matchMethod === "parcel_and_coordinate" ? 151 : 201)));
  assert.ok(lines.features.every((feature) => feature.properties.matchMethod !== "parcel_and_coordinate" ||
    feature.properties.roadLightingScore <= 55));
  assert.equal(facilities.features.some((f) => f.properties.type === "road_light"), false);
  for (const [id, road] of Object.entries(evidence.roads)) {
    assert.equal(new Set(road.clusterIds).size, road.clusterIds.length, id);
    assert.equal(road.managedUnitCount, road.clusterIds.reduce((sum, clusterId) => sum + counts.get(clusterId), 0), id);
    assert.equal(road.matchedRecordCount, road.managedUnitCount, id);
  }
});
