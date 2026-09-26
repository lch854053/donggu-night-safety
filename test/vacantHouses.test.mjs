import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { collectVacantHouses, vacantHouseFeature } from "../scripts/vacant-houses.mjs";

test("동구 빈집 API의 위도(X)·경도(Y)를 EPSG:5174에서 지도 좌표로 변환한다", () => {
  const feature = vacantHouseFeature({
    "읍면동명": "대인동", "위도": "192083.0095", "경도": "183919.9701",
    "주택유형": "단독", "등급판정결과": "2등급",
  }, 1);
  assert.deepEqual(feature.geometry.coordinates, [126.913888, 35.154522]);
  assert.equal(feature.properties.name, "대인동 빈집");
  assert.equal(feature.properties.note, "단독 · 2등급");
  assert.equal(vacantHouseFeature({ "위도": "35.15", "경도": "126.91" }, 2), null);
  assert.deepEqual(vacantHouseFeature({ "위도": "192323.873", "경도": "184934.0517" }, 236).geometry.coordinates,
    [126.917706, 35.155223], "지번 일치 필지의 대표점을 사용한다");
  assert.equal(vacantHouseFeature({ "위도": "193304.5152", "경도": "183376.0437" }, 25), null,
    "주소·좌표를 검증할 수 없는 건은 지도에 표시하지 않는다");
});

test("인증키로 페이지를 수집하고 좌표 누락 시 전체 갱신을 중단한다", async () => {
  const row = { "위도": "192083.0095", "경도": "183919.9701", "데이터기준일자": "2025-07-16" };
  const getText = async (url) => {
    const request = new URL(url);
    assert.equal(request.searchParams.get("serviceKey"), "test-key");
    return JSON.stringify({ matchCount: 1, data: [row] });
  };
  const result = await collectVacantHouses("test-key", getText);
  assert.equal(result.features.length, 1);
  assert.equal(result.dataAsOf, "2025-07-16");
  assert.equal(result.excluded, 0);
  const reviewed = await collectVacantHouses("test-key", async () => JSON.stringify({ matchCount: 2, data: [row,
    { ...row, "위도": "193304.5152", "경도": "183376.0437" }] }));
  assert.equal(reviewed.features.length, 1);
  assert.equal(reviewed.excluded, 1);
  await assert.rejects(
    collectVacantHouses("test-key", async () => JSON.stringify({ matchCount: 1, data: [{ ...row, "위도": "" }] })),
    /좌표 검증 실패/,
  );
});

test("배포 좌표는 실제 주소 기반 검증 결과와 일치하고 미확인 5건을 제외한다", () => {
  const data = JSON.parse(readFileSync(new URL("../public/data/safety-features.geojson", import.meta.url)));
  const vacant = data.features.filter((feature) => feature.properties.type === "vacant_house");
  const byId = new Map(vacant.map((feature) => [feature.properties.id, feature.geometry.coordinates]));
  assert.equal(vacant.length, 643);
  assert.deepEqual(byId.get("vacant-1"), [126.913888, 35.154522]);
  assert.deepEqual(byId.get("vacant-236"), [126.917706, 35.155223]);
  for (const id of [4, 25, 70, 71, 530]) assert.equal(byId.has(`vacant-${id}`), false);
});
