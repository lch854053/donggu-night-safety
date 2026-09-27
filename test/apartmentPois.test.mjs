import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { booleanPointInPolygon } from "@turf/turf";
import { buildApartmentPois } from "../scripts/update-apartment-pois.mjs";
import { INITIAL_LAYER_VISIBILITY, POINT_LAYER_KEYS } from "../config/mapLayers.ts";

const parcel = { type: "Polygon", coordinates: [[
  [126.92, 35.14], [126.921, 35.14], [126.921, 35.141], [126.92, 35.141], [126.92, 35.14],
]] };

test("단지마다 필지 내부 참고점 하나를 만들고 출입구·안전시설로 표시하지 않는다", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ pnu: String(i).padStart(19, "0"),
    complexNm: `공동주택 ${i}`, kind: "아파트", geometry: parcel, hhld: 180, source: "kapt" }));
  const result = buildApartmentPois(rows);
  assert.equal(result.features.length, rows.length);
  for (const feature of result.features) {
    assert.equal(feature.geometry.type, "Point");
    assert.ok(booleanPointInPolygon(feature, parcel));
    assert.equal(feature.properties.households, 180);
    assert.equal(feature.properties.type, undefined);
  }
  assert.throws(() => buildApartmentPois(rows.slice(0, 10)), /비정상적으로 적/);
  assert.throws(() => buildApartmentPois(rows.map((row) => ({ ...row, pnu: rows[0].pnu,
    complexNm: rows[0].complexNm }))), /중복/);
});

test("배포용 단지명 POI는 안전점수용 시설 컬렉션과 분리된다", () => {
  const pois = JSON.parse(readFileSync(new URL("../public/data/apartment-pois.geojson", import.meta.url)));
  const facilities = JSON.parse(readFileSync(new URL("../public/data/safety-features.geojson", import.meta.url)));
  assert.ok(pois.features.length >= 100);
  assert.equal(new Set(pois.features.map((feature) => feature.properties.id)).size, pois.features.length);
  assert.ok(pois.features.every((feature) => feature.geometry.type === "Point" &&
    feature.properties.name && feature.properties.pnu));
  assert.equal(facilities.features.some((feature) => feature.properties.type === "apartment_poi"), false);
  assert.equal(INITIAL_LAYER_VISIBILITY.apartment_poi, true);
  assert.equal(POINT_LAYER_KEYS.includes("apartment_poi"), false);
});
