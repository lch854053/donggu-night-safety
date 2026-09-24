import assert from "node:assert/strict";
import test from "node:test";

import { fetchPoliceRows, geocodePolice, normalizeAddress } from "../scripts/police-facilities.mjs";

const station = { 시도청: "광주청", 주소: "광주광역시 동구  양림로 119 번길 13", 경찰서: "광주동부", 관서명: "학서", 구분: "파출소", 연번: 497 };
const center = { 시도청: "광주청", 주소: "광주광역시 동구 충장로 64", 관서명: "금남", 치안센터명: "충장치안센터", 연번: 139 };

test("경찰청 두 API의 동구 자료만 페이지를 끝까지 수집한다", async () => {
  const calls: URL[] = [];
  const rows = await fetchPoliceRows("test-key", async (input) => {
    const url = input as URL;
    calls.push(url);
    const isCenter = url.pathname.includes("15076962");
    return { ok: true, json: async () => ({ totalCount: isCenter ? 1 : 501,
      data: isCenter ? [center] : url.searchParams.get("page") === "1"
        ? [station, ...Array.from({ length: 499 }, () => ({ ...station, 시도청: "서울청" }))]
        : [{ ...station, 주소: "광주광역시 서구 상무로 1" }] }) } as Response;
  });
  assert.equal(calls.length, 3);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((item) => item.kind), ["station", "center"]);
  assert.equal(normalizeAddress(station.주소), "광주광역시 동구 양림로119번길 13");
});

test("도로 중심점은 제외하고 주소·이름이 일치하는 경찰 POI만 사용한다", async () => {
  const request = async () => ({ ok: true, json: async () => [
    { type: "primary", display_name: "양림로119번길, 동구", lat: "35.1", lon: "126.9" },
    { type: "police", display_name: "학서파출소, 13, 양림로119번길, 동구", lat: "35.1408629", lon: "126.9199217" },
  ] }) as Response;
  assert.deepEqual(await geocodePolice(station, "station", undefined, request), [126.9199217, 35.1408629]);
  const roadOnly = async () => ({ ok: true, json: async () => [
    { type: "primary", display_name: "양림로119번길, 동구", lat: "35.1", lon: "126.9" },
  ] }) as Response;
  assert.equal(await geocodePolice(station, "station", undefined, roadOnly), null);
});

test("카카오 주소 검색도 도로명·건물번호와 행정구역이 일치할 때만 채택한다", async () => {
  const request = async (input: RequestInfo | URL) => {
    if (String(input).includes("nominatim")) return { ok: true, json: async () => [] } as Response;
    return { ok: true, json: async () => ({ documents: [
      { x: "126.9", y: "35.1", road_address: { region_1depth_name: "광주광역시", region_2depth_name: "동구", road_name: "양림로119번길", main_building_no: "12", sub_building_no: "" } },
      { x: "126.9199", y: "35.1408", road_address: { region_1depth_name: "광주광역시", region_2depth_name: "동구", road_name: "양림로119번길", main_building_no: "13", sub_building_no: "" } },
    ] }) } as Response;
  };
  assert.deepEqual(await geocodePolice(station, "station", "test-kakao-key", request), [126.9199, 35.1408]);
});
