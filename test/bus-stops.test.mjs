import assert from "node:assert/strict";
import test from "node:test";
import { polygon } from "@turf/turf";

import { buildBusStops, fetchBusStops } from "../scripts/bus-stops.mjs";

const boundary = polygon([[[126.9, 35.14], [126.93, 35.14], [126.93, 35.16],
  [126.9, 35.16], [126.9, 35.14]]]);
const rows = Array.from({ length: 1001 }, (_, i) => ({
  nodeid: `KJB${i + 1}`, nodenm: `정류장 ${i + 1}`,
  gpslati: i < 150 ? 35.15 : 35.3, gpslong: 126.92,
  ...(i % 2 ? {} : { nodeno: 1000 + i }),
}));

test("TAGO 광주 목록을 경계로 잘라 안정적인 ID와 이전 승하차 자료를 보존한다", () => {
const previous = [{ properties: { id: "bus-KJB1", type: "bus_stop",
    nightRidershipPeriod: "2026-04-01~2026-06-30", nightWeekdayBoarding: 3 } }];
  const result = buildBusStops(rows, [boundary], previous);
  assert.equal(result.insideCount, 150);
  assert.equal(result.features.length, 150);
  assert.equal(result.features[0].properties.nightWeekdayBoarding, 3);
  assert.equal(result.features[0].properties.arsNumber, "1000");
  assert.equal(result.features[1].properties.arsNumber, undefined);
  assert.deepEqual(result.features[0].geometry.coordinates, [126.92, 35.15]);
});

test("페이지 누락과 TAGO 오류 응답은 기존 좌표를 덮어쓰지 못한다", async () => {
  const response = { response: { header: { resultCode: "00" },
    body: { totalCount: 1002, items: { item: rows } } } };
  await assert.rejects(fetchBusStops("test", [boundary], [], async () => JSON.stringify(response)), /잘렸습니다/);
  response.response.header.resultCode = "99";
  await assert.rejects(fetchBusStops("test", [boundary], [], async () => JSON.stringify(response)), /응답 오류/);
});
