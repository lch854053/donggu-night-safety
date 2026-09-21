import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { destination, featureCollection, length, lineString, point } from "@turf/turf";
import { calculateRoadSafety } from "../lib/scoring/calculateRoadSafety";
import { createRoadPointIndex } from "../lib/scoring/roadPointIndex";
import { validateScoredRoads } from "../lib/data/validateScoredRoads";
import { StaticSafetyDataSource } from "../lib/data/staticSafetyDataSource";
import type { SafetyDataset, SafetyFeatureType, ScoredRoadFile } from "../types/safety";

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const roads: ScoredRoadFile = readJson("public/data/road-segments.geojson");
const dataset: SafetyDataset = {
  roadSegments: readJson("scripts/data/road-segments.geojson"),
  features: readJson("public/data/safety-features.geojson"),
  riskZones: readJson("public/data/risk-zones.geojson"),
  metadata: { sourceKind: "static", scoreKind: "client", updatedAt: "" },
};

test("shipped roads are current, unique, valid-length real segments with no sample risk penalties", () => {
  assert.equal(validateScoredRoads(roads), roads);
  assert.equal(roads.features.length, dataset.roadSegments.features.length);
  assert.ok(roads.features.length > 1000);
  assert.equal(new Set(roads.features.map((f) => f.properties.id)).size, roads.features.length);
  assert.equal(dataset.riskZones.features.length, 0);
  for (const [path, hash] of Object.entries(roads.scoreMetadata.inputHashes)) {
    assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), hash, `Stale scores: ${path}`);
  }
  for (const road of roads.features) {
    const meters = length(road, { units: "kilometers" }) * 1000;
    assert.ok(meters > 0 && meters < 50.3, `${road.properties.id}: ${meters}m`);
    assert.ok(road.properties.safetyScore >= 0 && road.properties.safetyScore <= 100);
    assert.equal(road.properties.crimeScore, null);
    assert.equal(road.properties.riskLevel, 0);
    assert.match(road.properties.source, /국토지리정보원/);
  }
});

test("indexed and shipped scores equal brute-force Turf on spatially distributed real roads", () => {
  const sample = { ...dataset, roadSegments: { ...dataset.roadSegments,
    features: dataset.roadSegments.features.filter((_, i) => i % 53 === 0) } };
  const expected = calculateRoadSafety(sample);
  assert.deepEqual(calculateRoadSafety(sample, createRoadPointIndex(dataset)), expected);
  const byId = new Map(roads.features.map((f) => [f.properties.id, f]));
  for (const road of expected.features) assert.deepEqual(byId.get(road.properties.id), road);
});

test("candidate index preserves both sides, endpoints, curves, and exact distance thresholds", () => {
  const center = [126.9232, 35.1461];
  const end = destination(center, 0.05, 90).geometry.coordinates;
  const midpoint = destination(center, 0.025, 90).geometry.coordinates;
  const types: SafetyFeatureType[] = ["streetlight", "cctv", "emergency_bell", "convenience_store", "cpted", "old_building"];
  const features = types.flatMap((type) => [49.9, 50, 50.1, 99.9, 100, 100.1, 200].flatMap((meters) =>
    [0, 90, 180, 270].flatMap((bearing) => [center, end, midpoint].map((origin, i) =>
      point(destination(origin, meters / 1000, bearing).geometry.coordinates, {
        id: `${type}-${meters}-${bearing}-${i}`, type, name: "threshold fixture", source: "test",
      })))));
  const synthetic: SafetyDataset = { ...dataset, features: featureCollection(features),
    roadSegments: featureCollection([
      lineString([center, end], { id: "straight", name: "test", source: "test" }),
      lineString([end, center], { id: "reverse", name: "test", source: "test" }),
      lineString([center, destination(midpoint, 0.03, 0).geometry.coordinates, end],
        { id: "curve", name: "test", source: "test" }),
    ]) };
  assert.deepEqual(calculateRoadSafety(synthetic, createRoadPointIndex(synthetic)), calculateRoadSafety(synthetic));
  assert.equal(synthetic.features.features[0].bbox, undefined, "index must not mutate inputs");
});

test("unscored/malformed data fails visibly rather than activating client scoring", () => {
  assert.throws(() => validateScoredRoads(dataset.roadSegments as ScoredRoadFile));
  const broken = structuredClone(roads);
  broken.features[0].properties.safetyScore = NaN;
  assert.throws(() => validateScoredRoads(broken));
});

test("static provider uses the shipped precomputed collection", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) =>
    new Response(readFileSync(`public${url}`), { status: 200 }));
  const loaded = await new StaticSafetyDataSource().load();
  assert.equal(loaded.metadata.scoreKind, "precomputed");
  assert.equal(loaded.roadSegments.features.length, roads.features.length);
  assert.deepEqual(loaded.roadSegments.features[0], roads.features[0]);
});
