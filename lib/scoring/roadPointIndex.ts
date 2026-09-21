import { geojsonRbush, length } from "@turf/turf";
import type { Feature, LineString, Point } from "geojson";
import { SAFETY_WEIGHTS } from "@/config/safetyWeights";
import type { SafetyDataset, SafetyFeatureProperties } from "@/types/safety";

/** Conservative candidate envelope; the shared scorer still measures exact Turf distances. */
export function createRoadPointIndex(dataset: SafetyDataset) {
  const tree = geojsonRbush<Point, SafetyFeatureProperties>();
  // rbush adds bbox fields; do not mutate the dataset used by other consumers.
  tree.load({ ...dataset.features, features: dataset.features.features.map((f) => ({ ...f })) });
  const radius = Math.max(
    ...[SAFETY_WEIGHTS.lighting, SAFETY_WEIGHTS.cctv, SAFETY_WEIGHTS.emergencyBell,
      SAFETY_WEIGHTS.convenienceStore, SAFETY_WEIGHTS.cpted, SAFETY_WEIGHTS.oldBuilding]
      .map((weight) => weight.radiusMeters),
  );
  return (road: Feature<LineString>): Feature<Point, SafetyFeatureProperties>[] => {
    // Any point near the line is at most (line length + radius) from its first
    // vertex. 110km/degree is conservative in this Korean regional dataset.
    const [lon, lat] = road.geometry.coordinates[0];
    const deltaLat = (length(road, { units: "kilometers" }) * 1000 + radius + 1) / 110000;
    if (Math.abs(lat) + deltaLat >= 80) throw new Error("Road index is for regional, non-polar data");
    const deltaLon = deltaLat / Math.cos((Math.abs(lat) + deltaLat) * Math.PI / 180);
    return tree.search([lon - deltaLon, lat - deltaLat, lon + deltaLon, lat + deltaLat])
      .features;
  };
}
