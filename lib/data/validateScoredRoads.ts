import type { ScoredRoadFile } from "@/types/safety";

/** Fail visibly instead of accidentally doing millions of distance checks on the client. */
export function validateScoredRoads(value: ScoredRoadFile): ScoredRoadFile {
  const numericFields = ["lengthMeters", "lightingScore", "lightingCoverage", "maxDarkGapMeters",
    "lightingUniformityScore", "surveillanceScore", "environmentScore",
    "safetyScore", "streetlightCount", "cctvCount", "emergencyBellCount", "convenienceStoreCount",
    "cptedCount", "oldBuildingCount", "riskLevel", "sidewalkContribution"] as const;
  if (value?.type !== "FeatureCollection" || value.scoreMetadata?.kind !== "precomputed" ||
      !Array.isArray(value.features) || !value.features.length ||
      value.features.some((f) => !f.properties || f.geometry?.type !== "LineString" ||
        !f.properties.id || numericFields.some((key) => !Number.isFinite(f.properties[key])) ||
        (f.properties.crimeScore !== null && !Number.isFinite(f.properties.crimeScore)) ||
        (f.properties.crimeSampleCount !== null && !Number.isFinite(f.properties.crimeSampleCount)))) {
    throw new Error("도로 점수 데이터가 준비되지 않았습니다. score-roads를 실행해 주세요.");
  }
  return value;
}
