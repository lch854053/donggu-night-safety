import type { ScoredRoadFile } from "@/types/safety";

/** Fail visibly instead of accidentally doing millions of distance checks on the client. */
export function validateScoredRoads(value: ScoredRoadFile): ScoredRoadFile {
  const numericFields = ["lengthMeters", "lightingScore", "lightingCoverage", "maxDarkGapMeters",
    "lightingUniformityScore", "safetyScore", "streetlightCount", "securityLightCount", "roadLightCount", "cctvCount", "emergencyBellCount",
    "convenienceStoreCount", "cptedCount", "oldBuildingCount", "riskLevel",
    "sidewalkContribution"] as const;
  // v2 차원·세부 점수는 미수집(null)이 허용된다. 숫자인데 유한하지 않으면 오류.
  const nullableScoreFields = ["safetyScoreV2", "surveillanceScore", "activityScore",
    "environmentScore", "cctvScore", "emergencyBellScore", "cptedScore", "policeScore",
    "nightActivityScore", "transitScore", "roadActivityScore", "convenienceStoreScore",
    "vacancyScore", "deteriorationScore", "sidewalkScore", "spatialStructureScore"] as const;
  if (value?.type !== "FeatureCollection" || value.scoreMetadata?.kind !== "precomputed" ||
      !Array.isArray(value.features) || !value.features.length ||
      value.features.some((f) => !f.properties || f.geometry?.type !== "LineString" ||
        !f.properties.id || numericFields.some((key) => !Number.isFinite(f.properties[key])) ||
        (f.properties.crimeScore !== null && !Number.isFinite(f.properties.crimeScore)) ||
        (f.properties.crimeSampleCount !== null && !Number.isFinite(f.properties.crimeSampleCount)) ||
        nullableScoreFields.some((key) => {
          const score = f.properties[key];
          return score !== undefined && score !== null && !Number.isFinite(score);
        }))) {
    throw new Error("도로 점수 데이터가 준비되지 않았습니다. score-roads를 실행해 주세요.");
  }
  return value;
}
