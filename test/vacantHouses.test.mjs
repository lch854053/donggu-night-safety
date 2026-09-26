import assert from "node:assert/strict";
import test from "node:test";
import { collectVacantHouses, vacantHouseFeature } from "../scripts/vacant-houses.mjs";

test("동구 빈집 API의 위도(X)·경도(Y)를 EPSG:5181에서 지도 좌표로 변환한다", () => {
  const feature = vacantHouseFeature({
    "읍면동명": "대인동", "위도": "192083.0095", "경도": "183919.9701",
    "주택유형": "단독", "등급판정결과": "2등급",
  }, 1);
  assert.deepEqual(feature.geometry.coordinates, [126.913114, 35.151626]);
  assert.equal(feature.properties.name, "대인동 빈집");
  assert.equal(feature.properties.note, "단독 · 2등급");
  assert.equal(vacantHouseFeature({ "위도": "35.15", "경도": "126.91" }, 2), null);
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
  await assert.rejects(
    collectVacantHouses("test-key", async () => JSON.stringify({ matchCount: 1, data: [{ ...row, "위도": "" }] })),
    /좌표 검증 실패/,
  );
});
