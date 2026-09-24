/** Compare a saved pre-refresh road file with the current scored roads and CCTV locations.
 * Usage: npx tsx scripts/analyze-cctv-sensitivity.ts <old-roads.geojson> <old-features.geojson>
 */
import { readFileSync } from "node:fs";
import { geojsonRbush, distance, length, nearestPointOnLine } from "@turf/turf";
import type { FeatureCollection, LineString, Point, Feature } from "geojson";
import { getSafetyBand } from "../config/safetyWeights";
import type { RoadSegmentProperties, SafetyFeatureProperties } from "../types/safety";

const [oldRoadsPath, oldFeaturesPath] = process.argv.slice(2);
if (!oldRoadsPath || !oldFeaturesPath) throw new Error("이전 도로 점수 및 시설 GeoJSON 경로가 필요합니다.");
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const previous = read(oldRoadsPath) as FeatureCollection<LineString, RoadSegmentProperties>;
const current = read("public/data/road-segments.geojson") as FeatureCollection<LineString, RoadSegmentProperties>;
const oldFeatures = read(oldFeaturesPath) as FeatureCollection<Point, SafetyFeatureProperties>;
const newFeatures = read("public/data/safety-features.geojson") as FeatureCollection<Point, SafetyFeatureProperties>;
const beforeById = new Map(previous.features.map((road) => [road.properties.id, road.properties]));
if (beforeById.size !== current.features.length) throw new Error("도로 ID 수가 변경되어 비교할 수 없습니다.");

const round = (n: number) => +n.toFixed(3);
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.floor((sorted.length - 1) * p)];
  return { count: values.length, mean: round(values.reduce((a, b) => a + b, 0) / values.length),
    median: percentile(0.5), quantiles: Object.fromEntries([10, 25, 50, 75, 90].map((p) => [p, percentile(p / 100)])) };
}
const props = current.features.map((road) => road.properties);
const past = current.features.map((road) => {
  const original = beforeById.get(road.properties.id);
  if (!original) throw new Error(`이전 도로 없음: ${road.properties.id}`);
  return original;
});

function distances(roads: Feature<LineString, RoadSegmentProperties>[], facilities: Feature<Point, SafetyFeatureProperties>[]) {
  const cctv = facilities.filter((item) => item.properties.type === "cctv");
  const tree = geojsonRbush<Point, SafetyFeatureProperties>();
  tree.load({ type: "FeatureCollection", features: cctv.map((item) => ({ ...item })) });
  const bins = { "0–25m": 0, "25–50m": 0, "50–100m": 0, "100–150m": 0, "150–200m": 0, "200m 이상": 0 };
  for (const road of roads) {
    const [lon, lat] = road.geometry.coordinates[0];
    const deltaLat = (length(road, { units: "kilometers" }) * 1000 + 201) / 110000;
    const deltaLon = deltaLat / Math.cos((Math.abs(lat) + deltaLat) * Math.PI / 180);
    const candidates = tree.search([lon - deltaLon, lat - deltaLat, lon + deltaLon, lat + deltaLat]).features;
    let nearest = Infinity;
    for (const item of candidates) {
      const meters = distance(item, nearestPointOnLine(road, item), { units: "kilometers" }) * 1000;
      if (meters < nearest) nearest = meters;
    }
    if (nearest < 25) bins["0–25m"]++;
    else if (nearest < 50) bins["25–50m"]++;
    else if (nearest < 100) bins["50–100m"]++;
    else if (nearest < 150) bins["100–150m"]++;
    else if (nearest < 200) bins["150–200m"]++;
    else bins["200m 이상"]++;
  }
  return bins;
}

const n = props.length;
const changed = (limit: number) => props.filter((item, i) =>
  Math.abs((item.safetyScoreV2 ?? 0) - (past[i].safetyScoreV2 ?? 0)) >= limit).length;
const bandChanged = props.filter((item, i) => getSafetyBand(item.safetyScoreV2 ?? 0).label !==
  getSafetyBand(past[i].safetyScoreV2 ?? 0).label).length;
const positive = (items: RoadSegmentProperties[]) => items.filter((item) => (item.cctvScore ?? 0) > 0).length;
const oldBins = distances(previous.features, oldFeatures.features);
const newBins = distances(current.features, newFeatures.features);
const coverage = (bins: typeof oldBins) => {
  const values = Object.values(bins);
  return { within50Pct: round(100 * (values[0] + values[1]) / n),
    within100Pct: round(100 * (values[0] + values[1] + values[2]) / n),
    within200Pct: round(100 * (n - values[5]) / n) };
};
console.log(JSON.stringify({ roadCount: n,
  before: { cctvAvailableRoads: past.filter((item) => item.cctvScore != null).length,
    cctvPositiveRoads: positive(past), cctvScore: summary(past.map((item) => item.cctvScore ?? 0)),
    surveillanceScore: summary(past.map((item) => item.surveillanceScore ?? 0)),
    safetyScoreV2: summary(past.map((item) => item.safetyScoreV2 ?? 0)),
    nearestCctvMeters: oldBins, coveragePct: coverage(oldBins) },
  after: { cctvAvailableRoads: props.filter((item) => item.cctvScore != null).length,
    cctvPositiveRoads: positive(props), cctvScore: summary(props.map((item) => item.cctvScore ?? 0)),
    surveillanceScore: summary(props.map((item) => item.surveillanceScore ?? 0)),
    safetyScoreV2: summary(props.map((item) => item.safetyScoreV2 ?? 0)),
    nearestCctvMeters: newBins, coveragePct: coverage(newBins) },
  changes: { atLeast5: changed(5), atLeast5Pct: round(100 * changed(5) / n),
    atLeast10: changed(10), atLeast10Pct: round(100 * changed(10) / n),
    bandChanged, bandChangedPct: round(100 * bandChanged / n) },
}, null, 2));
