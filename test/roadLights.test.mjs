import assert from "node:assert/strict";
import test from "node:test";
import { collectRoadLights } from "../scripts/road-lights.mjs";

const row = (id, lon = "126.9181691", lat = "35.11586050") => ({
  "관리번호": id, "경도": lon, "위도": lat, "데이터기준일자": "2024-04-15",
  "소재지도로명주소": "화산로205", "소재지지번주소": "용산동 634-1",
});

test("동일 좌표의 서로 다른 관리번호를 한 위치로 합치고 실제 API 필드만 보존한다", async () => {
  const rows = [row("동구-01-1"), row("동구-01-2"), row("동구-02", "126.92", "35.12")];
  const result = await collectRoadLights("test-key", async (url) => {
    const params = new URL(url).searchParams;
    assert.equal(params.get("serviceKey"), "test-key");
    assert.equal(params.get("page"), "1");
    return JSON.stringify({ matchCount: rows.length, data: rows });
  });
  assert.equal(result.total, 3);
  assert.equal(result.features.length, 2);
  assert.equal(result.dataAsOf, "2024-04-15");
  assert.deepEqual(result.features[0].geometry.coordinates, [126.918169, 35.11586]);
  assert.equal(result.features[0].properties.type, "road_light");
  assert.equal(result.features[0].properties.id, "road-light-126.918169-35.115860");
  assert.equal(result.features[0].properties.roadName, "화산로205");
  assert.equal(result.features[0].properties.powerW, undefined);
});

test("범위 밖·누락·잘못된 좌표는 제외하고 유효 위치만 수집한다", async () => {
  const rows = [row("ok"), row("bad", "126.5"), row("missing", ""), row("nan", "oops")];
  const result = await collectRoadLights("test-key", async () => JSON.stringify({ matchCount: rows.length, data: rows }));
  assert.equal(result.features.length, 1);
  assert.equal(result.invalid, 3);
});

test("인증 오류·누락 페이지·전체 무효 좌표면 갱신이 중단되어 이전 파일을 보존한다", async () => {
  await assert.rejects(collectRoadLights("test-key", async () => { throw new Error("HTTP 401"); }), /401/);
  await assert.rejects(collectRoadLights("test-key", async () => JSON.stringify({ matchCount: 3, data: [row("one")] })), /페이지 누락/);
  await assert.rejects(collectRoadLights("test-key", async () => JSON.stringify({ matchCount: 1, data: [row("bad", "0")] })), /좌표 또는 기준일자 없음/);
});
