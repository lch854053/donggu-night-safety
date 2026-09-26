import { geojsonRbush, length } from "@turf/turf";
import type { Feature, LineString, Point } from "geojson";
import { SAFETY_SCORES_V2, SAFETY_WEIGHTS } from "@/config/safetyWeights";
import type { ProximityWeight } from "@/config/safetyWeights";
import type { SafetyDataset, SafetyFeatureProperties } from "@/types/safety";

/** Conservative candidate envelope; the shared scorer still measures exact Turf distances. */
export function createRoadPointIndex(dataset: SafetyDataset) {
  const tree = geojsonRbush<Point, SafetyFeatureProperties>();
  // rbush adds bbox fields; do not mutate the dataset used by other consumers.
  tree.load({ ...dataset.features, features: dataset.features.features.map((f) => ({ ...f })) });
  const proximityWeights: ProximityWeight[] = [SAFETY_WEIGHTS.cctv, SAFETY_WEIGHTS.emergencyBell,
    SAFETY_WEIGHTS.convenienceStore, SAFETY_WEIGHTS.cpted, SAFETY_WEIGHTS.oldBuilding];
  // v2 차원 모듈이 쓰는 반경(경찰시설 1000m 포함)도 후보 봉투에 포함한다.
  const v2Radii = [
    SAFETY_SCORES_V2.surveillance.cctv.radiusMeters,
    SAFETY_SCORES_V2.surveillance.cpted.radiusMeters,
    SAFETY_SCORES_V2.surveillance.emergencyBell.radiusMeters,
    SAFETY_SCORES_V2.surveillance.police.radiusMeters,
    SAFETY_SCORES_V2.activity.nightActivity.radiusMeters,
    SAFETY_SCORES_V2.activity.transit.radiusMeters,
    SAFETY_SCORES_V2.activity.convenienceStore.radiusMeters,
    SAFETY_SCORES_V2.environment.vacancy.radiusMeters,
    SAFETY_SCORES_V2.environment.deterioration.radiusMeters,
  ];
  const radius = Math.max(
    SAFETY_WEIGHTS.lighting.lightTypes.security_light.cutoffMeters,
    SAFETY_WEIGHTS.lighting.countRadiusMeters,
    ...proximityWeights.map((weight) => weight.radiusMeters),
    ...v2Radii,
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
