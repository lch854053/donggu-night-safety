import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { collectRoadLights } from "../scripts/road-lights.mjs";

const row = (id, lon = "126.9181691", lat = "35.11586050") => ({
  "관리번호": id, "경도": lon, "위도": lat, "데이터기준일자": "2024-04-15",
  "소재지도로명주소": "화산로205", "소재지지번주소": "용산동 634-1",
});

test("동일 좌표의 여러 관리행을 하나의 추정 근거로 묶고 광원 Point를 생성하지 않는다", async () => {
  const rows = [...Array.from({ length: 20 }, (_, i) => row(`동구-01-${i + 1}`)),
    row("동구-02", "126.92", "35.12")];
  const result = await collectRoadLights("test-key", async (url) => {
    const params = new URL(url).searchParams;
    assert.equal(params.get("serviceKey"), "test-key");
    assert.equal(params.get("page"), "1");
    return JSON.stringify({ matchCount: rows.length, data: rows });
  });
  assert.equal(result.total, 21);
  assert.equal(result.groups.length, 2);
  assert.equal(result.dataAsOf, "2024-04-15");
  assert.deepEqual(result.groups[0].representativeCoordinates, [126.918169, 35.11586]);
  assert.equal(result.groups[0].recordCount, 20);
  assert.deepEqual(result.groups[0].roadAddresses, ["화산로205"]);
  assert.equal(result.groups[0].geometry, undefined);
});

test("범위 밖·누락·잘못된 좌표는 제외하고 유효 위치만 수집한다", async () => {
  const rows = [row("ok"), row("bad", "126.5"), row("missing", ""), row("nan", "oops")];
  const result = await collectRoadLights("test-key", async () => JSON.stringify({ matchCount: rows.length, data: rows }));
  assert.equal(result.groups.length, 1);
  assert.equal(result.invalid, 3);
});

test("인증 오류·누락 페이지·전체 무효 좌표면 갱신이 중단되어 이전 파일을 보존한다", async () => {
  const shipped = readFileSync(new URL("../public/data/road-light-evidence.json", import.meta.url), "utf8");
  await assert.rejects(collectRoadLights("test-key", async () => { throw new Error("HTTP 401"); }), /401/);
  await assert.rejects(collectRoadLights("test-key", async () => JSON.stringify({ matchCount: 3, data: [row("one")] })), /페이지 누락/);
  await assert.rejects(collectRoadLights("test-key", async () => JSON.stringify({ matchCount: 1, data: [row("bad", "0")] })), /좌표 또는 기준일자 없음/);
  assert.equal(readFileSync(new URL("../public/data/road-light-evidence.json", import.meta.url), "utf8"), shipped);
});
