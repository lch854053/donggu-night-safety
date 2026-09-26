import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { destination, featureCollection, length, lineString, point } from "@turf/turf";
import { calculateRoadSafety } from "../lib/scoring/calculateRoadSafety";
import { createRoadPointIndex } from "../lib/scoring/roadPointIndex";
import { validateScoredRoads } from "../lib/data/validateScoredRoads";
import { StaticSafetyDataSource } from "../lib/data/staticSafetyDataSource";
import { SAFETY_WEIGHTS } from "../config/safetyWeights";
import type { SafetyDataset, SafetyFeatureType, ScoredRoadFile } from "../types/safety";

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const roads: ScoredRoadFile = readJson("public/data/road-segments.geojson");
const crimeFile = existsSync("public/data/crime-risk.json") ? readJson("public/data/crime-risk.json") : null;
const dataset: SafetyDataset = {
  roadSegments: readJson("scripts/data/road-segments.geojson"),
  features: readJson("public/data/safety-features.geojson"),
  riskZones: readJson("public/data/risk-zones.geojson"),
  metadata: { sourceKind: "static", scoreKind: "client", updatedAt: "" },
  crimeRiskByRoad: crimeFile?.roads,
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
    // crimeScore null = WMS 미커버(미수집), 숫자 = 샘플링 결과. 둘은 다른 의미다.
    assert.ok(road.properties.crimeScore === null || Number.isFinite(road.properties.crimeScore));
    assert.equal(road.properties.crimeScore === null, road.properties.crimeSampleCount === null,
      `${road.properties.id}: crimeScore와 샘플 수의 null 여부가 일치해야 한다`);
    if (road.properties.crimeSampleCount !== null) {
      assert.ok(road.properties.crimeSampleCount >= 1);
    }
    assert.equal(road.properties.riskLevel, 0);
    assert.match(road.properties.source, /국토지리정보원/);
  }
});

test("demolished Gyerim roads stay out of the input, shipped scores, and crime data", () => {
  const retired: { segmentIds: string[] } = readJson("config/retiredRoadSegments.json");
  const ids = new Set(retired.segmentIds);
  assert.equal(ids.size, 9);
  assert.ok(ids.has("ngii-56ba9e6d73460148-2"), "same demolished alignment's middle section");
  for (const collection of [dataset.roadSegments, roads]) {
    assert.ok(collection.features.every((f) => !ids.has(f.properties.id)));
  }
  assert.equal(readJson("public/data/roads-meta.json").excluded.demolished_segments, ids.size);
  if (crimeFile) {
    assert.ok(retired.segmentIds.every((id) => !(id in crimeFile.roads)));
    assert.equal(crimeFile.summary.roads, roads.features.length);
    assert.equal(crimeFile.roadSegmentsSha256, createHash("sha256")
      .update(readFileSync("scripts/data/road-segments.geojson")).digest("hex").slice(0, 16));
  }
});

test("shipped crime risk matches the WMS sampling report", () => {
  if (!crimeFile) return; // WMS 데이터 없이 배포하는 경우: crimeScore 전체 null은 위 테스트가 검증
  const byId = new Map(roads.features.map((f) => [f.properties.id, f]));
  let withCrime = 0;
  for (const [id, entry] of Object.entries(crimeFile.roads)) {
    const road = byId.get(id);
    assert.ok(road, `${id}: crime-risk.json의 도로가 배포 데이터에 없다`);
    assert.equal(road.properties.crimeScore === null, false);
    assert.ok(Number.isFinite((entry as { crimeRisk: number }).crimeRisk));
    withCrime++;
  }
  assert.equal(withCrime, crimeFile.summary.withData);
  assert.ok(crimeFile.legend.length === 10, "생활안전지도 10등급 범례를 그대로 보존해야 한다");
  assert.match(String(crimeFile.legendWarning), /경찰청/);
});

test("shipped CPTED sites match geocoding metadata and activate surveillance scoring", () => {
  const meta = readJson("public/data/cpted-meta.json");
  const cache = readJson("public/data/cpted-geocodes.json");
  const sites = dataset.features.features.filter((f) => f.properties.type === "cpted");
  assert.ok(sites.length > 0);
  assert.equal(sites.length, meta.count);
  assert.equal(new Set(sites.map((f) => f.properties.id)).size, sites.length);
  for (const site of sites) {
    const properties = site.properties as typeof site.properties & {
      status: string; addressType: string; geocodedAddress: string; locationAccuracy: string;
    };
    assert.equal(properties.status, "완료");
    assert.equal(properties.source, "safemap:IF_0023");
    assert.equal(properties.locationAccuracy, "address");
    const geocode = cache[`${properties.addressType}:${properties.geocodedAddress}`];
    assert.equal(geocode.crs, "EPSG:4326");
    assert.deepEqual(site.geometry.coordinates, geocode.coordinates.map((n: number) => +n.toFixed(6)));
  }
  assert.ok(roads.features.every((road) => road.properties.cptedScore !== null));
  assert.ok(roads.features.some((road) => (road.properties.cptedScore ?? 0) > 0));
  assert.equal(readJson("public/data/meta.json").pending.cpted, undefined);
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
  const types: SafetyFeatureType[] = ["security_light", "road_light", "cctv", "emergency_bell", "convenience_store", "cpted", "old_building"];
  const features = types.flatMap((type) => [49.9, 50, 50.1, 84.9, 85, 85.1, 99.9, 100, 100.1, 200].flatMap((meters) =>
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

test("sidewalk penalty applies only to segments without adjacent sidewalks", () => {
  const base = dataset.roadSegments.features[0];
  const withAccess = (access: "yes" | "partial" | "no") => calculateRoadSafety({ ...dataset,
    roadSegments: featureCollection([
      { ...base, properties: { ...base.properties, pedestrianAccess: access } }]) });
  const missing = withAccess("no").features[0].properties;
  const present = withAccess("yes").features[0].properties;
  const partial = withAccess("partial").features[0].properties;
  assert.equal(missing.sidewalkContribution, SAFETY_WEIGHTS.sidewalk.missingPenalty);
  assert.equal(present.sidewalkContribution, 0);
  assert.equal(partial.sidewalkContribution, 0);
  assert.equal(missing.safetyScore, present.safetyScore + SAFETY_WEIGHTS.sidewalk.missingPenalty);
});

test("shipped segments carry sidewalk attributes matching the import report", () => {
  const meta = readJson("public/data/sidewalks-meta.json");
  const distribution = { yes: 0, partial: 0, no: 0 };
  const byId = new Map(roads.features.map((f) => [f.properties.id, f]));
  for (const segment of dataset.roadSegments.features) {
    const access = segment.properties.pedestrianAccess;
    if (access !== "yes" && access !== "partial" && access !== "no") {
      assert.fail(`${segment.properties.id}: pedestrianAccess=${String(access)}`);
    }
    distribution[access] += 1;
    const scored = byId.get(segment.properties.id);
    assert.ok(scored, segment.properties.id);
    assert.equal(scored.properties.pedestrianAccess, access);
    assert.equal(scored.properties.sidewalkContribution,
      access === "no" ? SAFETY_WEIGHTS.sidewalk.missingPenalty : 0);
    const width = segment.properties.sidewalkWidthMeters;
    assert.ok(width == null || (width > 0 && width < 30), `${segment.properties.id}: ${width}`);
  }
  assert.deepEqual(meta.access, distribution);
  assert.ok(distribution.yes + distribution.partial > 0, "no sidewalk-aware segments at all");
});
