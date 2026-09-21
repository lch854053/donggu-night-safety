import {
  booleanIntersects,
  distance,
  length,
  nearestPointOnLine,
} from "@turf/turf";
import type { Feature, LineString, Point } from "geojson";

import { SAFETY_WEIGHTS, type ProximityWeight } from "@/config/safetyWeights";
import { computeLightingMetrics } from "@/lib/scoring/lighting";
import type {
  RoadSegmentProperties,
  SafetyDataset,
  SafetyFeatureProperties,
  SafetyFeatureType,
  ScoredRoadSegments,
} from "@/types/safety";

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function pointsNearRoad(
  road: Feature<LineString>,
  points: Feature<Point, SafetyFeatureProperties>[],
  type: SafetyFeatureType,
  radiusMeters: number,
) {
  return points.filter((candidate) => {
    if (candidate.properties.type !== type) return false;
    const nearest = nearestPointOnLine(road, candidate);
    return distance(candidate, nearest, { units: "kilometers" }) * 1000 <= radiusMeters;
  }).length;
}

function weightedContribution(count: number, weight: ProximityWeight) {
  return Math.min(count, weight.maxOccurrences) * weight.points;
}

function availabilityScore(count: number, maximum: number) {
  return Math.round(clamp((Math.min(count, maximum) / maximum) * 100));
}

export function calculateRoadSafety(
  dataset: SafetyDataset,
  candidatesForRoad?: (road: Feature<LineString>) => Feature<Point, SafetyFeatureProperties>[],
): ScoredRoadSegments {
  const pointFeatures = dataset.features.features;
  const maximumCrimePenalty = Math.abs(SAFETY_WEIGHTS.crimeRisk[5]);

  return {
    type: "FeatureCollection",
    features: dataset.roadSegments.features.map((road) => {
      const candidates = candidatesForRoad?.(road) ?? pointFeatures;
      const streetlightCount = pointsNearRoad(
        road,
        candidates,
        "streetlight",
        SAFETY_WEIGHTS.lighting.countRadiusMeters,
      );
      // 조명 환경은 개수가 아니라 구간 샘플별 감쇠 영향(위치·거리 분포)으로 산출한다.
      const streetlightFeatures = candidates.filter(
        (candidate) => candidate.properties.type === "streetlight",
      );
      const lighting = computeLightingMetrics(road, streetlightFeatures, SAFETY_WEIGHTS.lighting);
      const cctvCount = pointsNearRoad(
        road,
        candidates,
        "cctv",
        SAFETY_WEIGHTS.cctv.radiusMeters,
      );
      const emergencyBellCount = pointsNearRoad(
        road,
        candidates,
        "emergency_bell",
        SAFETY_WEIGHTS.emergencyBell.radiusMeters,
      );
      const convenienceStoreCount = pointsNearRoad(
        road,
        candidates,
        "convenience_store",
        SAFETY_WEIGHTS.convenienceStore.radiusMeters,
      );
      const cptedCount = pointsNearRoad(
        road,
        candidates,
        "cpted",
        SAFETY_WEIGHTS.cpted.radiusMeters,
      );
      const oldBuildingCount = pointsNearRoad(
        road,
        candidates,
        "old_building",
        SAFETY_WEIGHTS.oldBuilding.radiusMeters,
      );

      const intersectingRiskLevels = dataset.riskZones.features
        .filter((zone) => booleanIntersects(road, zone))
        .map((zone) => zone.properties.riskLevel);
      const riskLevel = Math.max(0, ...intersectingRiskLevels) as 0 | 1 | 2 | 3 | 4 | 5;

      // 상대적 주의도는 벡터 주의구간과 WMS 샘플링 결과를 합친다.
      // WMS 항목이 없는 구간은 미수집(null)이며 위험도 0과 다르게 취급한다.
      const crimeEntry = dataset.crimeRiskByRoad?.[road.properties.id];

      const cctvContribution = weightedContribution(cctvCount, SAFETY_WEIGHTS.cctv);
      const bellContribution = weightedContribution(emergencyBellCount, SAFETY_WEIGHTS.emergencyBell);
      const storeContribution = weightedContribution(
        convenienceStoreCount,
        SAFETY_WEIGHTS.convenienceStore,
      );
      const cptedContribution = weightedContribution(cptedCount, SAFETY_WEIGHTS.cpted);
      const oldBuildingContribution = weightedContribution(
        oldBuildingCount,
        SAFETY_WEIGHTS.oldBuilding,
      );
      const crimeContribution = SAFETY_WEIGHTS.crimeRisk[
        Math.max(riskLevel, crimeEntry?.level ?? 0) as 0 | 1 | 2 | 3 | 4 | 5
      ];
      // 기존 보안등 가점 상한(8점×2개=16점)을 유지하도록 조명 환경 점수를 정규화한다.
      const lightingContribution =
        (lighting.lightingScore / 100) * SAFETY_WEIGHTS.lighting.contributionPoints;
      // 인도는 점 시설과 달리 import-sidewalks.py가 미리 계산한 구간 속성을 읽는다.
      const sidewalkContribution =
        road.properties.pedestrianAccess === "no" ? SAFETY_WEIGHTS.sidewalk.missingPenalty : 0;

      const safetyScore = Math.round(
        clamp(
          SAFETY_WEIGHTS.baseScore +
            lightingContribution +
            cctvContribution +
            bellContribution +
            storeContribution +
            cptedContribution +
            oldBuildingContribution +
            sidewalkContribution +
            crimeContribution,
        ),
      );

      const surveillanceMaximum =
        SAFETY_WEIGHTS.cctv.maxOccurrences + SAFETY_WEIGHTS.emergencyBell.maxOccurrences;
      const environmentPositiveMaximum =
        SAFETY_WEIGHTS.convenienceStore.maxOccurrences + SAFETY_WEIGHTS.cpted.maxOccurrences;
      const oldBuildingRatio =
        Math.min(oldBuildingCount, SAFETY_WEIGHTS.oldBuilding.maxOccurrences) /
        SAFETY_WEIGHTS.oldBuilding.maxOccurrences;

      const properties: RoadSegmentProperties = {
        ...road.properties,
        lengthMeters: Math.round(length(road, { units: "kilometers" }) * 1000),
        lightingScore: lighting.lightingScore,
        lightingCoverage: Math.round(lighting.coverageScore),
        maxDarkGapMeters: Math.round(lighting.maxDarkGapMeters),
        lightingUniformityScore: Math.round(lighting.uniformityScore),
        surveillanceScore: availabilityScore(
          Math.min(cctvCount, SAFETY_WEIGHTS.cctv.maxOccurrences) +
            Math.min(emergencyBellCount, SAFETY_WEIGHTS.emergencyBell.maxOccurrences),
          surveillanceMaximum,
        ),
        crimeScore: crimeEntry || dataset.riskZones.features.length > 0 ? Math.round(
          clamp(100 - (Math.abs(crimeContribution) / maximumCrimePenalty) * 100),
        ) : null,
        crimeSampleCount: crimeEntry?.sampleCount ?? null,
        environmentScore: Math.round(
          clamp(
            50 +
              (50 *
                (Math.min(
                  convenienceStoreCount,
                  SAFETY_WEIGHTS.convenienceStore.maxOccurrences,
                ) + Math.min(cptedCount, SAFETY_WEIGHTS.cpted.maxOccurrences))) /
                environmentPositiveMaximum -
              oldBuildingRatio * 50,
          ),
        ),
        sidewalkContribution,
        safetyScore,
        streetlightCount,
        cctvCount,
        emergencyBellCount,
        convenienceStoreCount,
        cptedCount,
        oldBuildingCount,
        riskLevel,
      };

      return { ...road, properties };
    }),
  };
}
