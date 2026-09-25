import assert from "node:assert/strict";
import test from "node:test";
import type { StyleSpecification } from "maplibre-gl";

import { BASEMAP_ATTRIBUTION, simplifyBaseMapStyle } from "../config/baseMap";

const style = {
  version: 8,
  sources: { "versatiles-shortbread": { type: "vector", url: "https://example.org/planet" } },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#fff" } },
    { id: "land-park", type: "fill", source: "versatiles-shortbread", "source-layer": "land" },
    { id: "building", type: "fill", source: "versatiles-shortbread", "source-layer": "buildings" },
    { id: "street-minor", type: "line", source: "versatiles-shortbread", "source-layer": "streets" },
    { id: "transport-rail", type: "line", source: "versatiles-shortbread", "source-layer": "streets" },
    { id: "label-place-quarter", type: "symbol", source: "versatiles-shortbread", "source-layer": "place_labels",
      layout: { "text-field": ["get", "name"], "icon-image": "old_icon" } },
    { id: "poi-amenity", type: "symbol", source: "versatiles-shortbread", "source-layer": "pois" },
    { id: "unfamiliar_id", type: "symbol", source: "versatiles-shortbread", "source-layer": "pois" },
    { id: "poi-shop", type: "symbol", source: "versatiles-shortbread", "source-layer": "pois" },
    { id: "label-street", type: "symbol", source: "versatiles-shortbread", "source-layer": "street_labels" },
    { id: "symbol-transit-bus", type: "symbol", source: "versatiles-shortbread", "source-layer": "public_transport" },
  ],
} as StyleSpecification;

test("only muted OSM geography and allowed place names survive, independent of POI layer IDs", () => {
  const simplified = simplifyBaseMapStyle(style);
  assert.deepEqual(simplified.layers.map((layer) => layer.id), [
    "background", "land-park", "building", "street-minor", "transport-rail", "label-place-quarter",
  ]);
  const source = simplified.sources["versatiles-shortbread"];
  assert.equal(source.type, "vector");
  if (source.type === "vector") assert.equal(source.attribution, BASEMAP_ATTRIBUTION);
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
