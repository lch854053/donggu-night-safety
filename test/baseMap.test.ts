import assert from "node:assert/strict";
import test from "node:test";
import type { StyleSpecification } from "maplibre-gl";

import { BASEMAP_ATTRIBUTION, isOsmPoiLayer, simplifyBaseMapStyle } from "../config/baseMap";

const style = {
  version: 8,
  sprite: [{ id: "base", url: "https://example.org/sprites/base" }],
  sources: { "versatiles-shortbread": { type: "vector", url: "https://example.org/planet" } },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#fff" } },
    { id: "land-park", type: "fill", source: "versatiles-shortbread", "source-layer": "land" },
    { id: "building", type: "fill", source: "versatiles-shortbread", "source-layer": "buildings" },
    { id: "street-minor", type: "line", source: "versatiles-shortbread", "source-layer": "streets" },
    { id: "transport-rail", type: "line", source: "versatiles-shortbread", "source-layer": "streets" },
    { id: "label-place-quarter", type: "symbol", source: "versatiles-shortbread", "source-layer": "place_labels",
      layout: { "text-field": ["get", "name"], "icon-image": "old_icon" } },
    { id: "poi-amenity", type: "symbol", source: "versatiles-shortbread", "source-layer": "pois",
      layout: { "icon-image": "base:icon-cafe", "text-field": ["get", "name"] } },
    { id: "unfamiliar_id", type: "symbol", source: "versatiles-shortbread", "source-layer": "pois" },
    { id: "poi-shop", type: "symbol", source: "versatiles-shortbread", "source-layer": "pois" },
    { id: "label-street", type: "symbol", source: "versatiles-shortbread", "source-layer": "street_labels" },
    { id: "symbol-transit-bus", type: "symbol", source: "versatiles-shortbread", "source-layer": "public_transport" },
  ],
} as StyleSpecification;

test("muted geography and OSM POI symbols survive while unrelated symbols stay excluded", () => {
  const simplified = simplifyBaseMapStyle(style);
  assert.deepEqual(simplified.layers.map((layer) => layer.id), [
    "background", "land-park", "building", "street-minor", "transport-rail",
    "label-place-quarter", "poi-amenity", "unfamiliar_id", "poi-shop",
  ]);
  const source = simplified.sources["versatiles-shortbread"];
  assert.equal(source.type, "vector");
  if (source.type === "vector") assert.equal(source.attribution, BASEMAP_ATTRIBUTION);
  assert.deepEqual(simplified.sprite, style.sprite, "POI icons require the original sprite");
  assert.deepEqual(simplified.layers.filter(isOsmPoiLayer).map((layer) => layer.id),
    ["poi-amenity", "unfamiliar_id", "poi-shop"]);
  const poi = simplified.layers.find((layer) => layer.id === "poi-amenity");
  assert.equal(poi?.type, "symbol");
  if (poi?.type === "symbol") {
    assert.equal(poi.layout?.["icon-image"], "base:icon-cafe");
    assert.deepEqual(poi.paint?.["icon-opacity"],
      ["interpolate", ["linear"], ["zoom"], 14, 0.45, 16, 0.55, 18, 0.65]);
  }
  const label = simplified.layers.find((layer) => layer.id === "label-place-quarter");
  assert.equal(label?.type, "symbol");
  if (label?.type === "symbol") {
    assert.equal(label.layout?.["icon-image"], "");
    assert.deepEqual(label.filter, ["all", ["match", ["get", "kind"], [
      "city", "town", "village", "suburb", "neighbourhood", "quarter",
      "hamlet", "state", "country", "continent",
    ], true, false]]);
  }
  assert.equal(style.layers.length, 11, "upstream style is not mutated");
});

test("a style with no building or no road fails before showing a misleading blank map", () => {
  assert.throws(() => simplifyBaseMapStyle({ ...style, layers: style.layers.filter((l) => l.id !== "building") }), /건물/);
  assert.throws(() => simplifyBaseMapStyle({ ...style, sources: {} }), /벡터 소스/);
});
