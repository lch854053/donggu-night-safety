import {
  booleanIntersects,
  distance,
  length,
  nearestPointOnLine,
} from "@turf/turf";
import type { Feature, LineString, Point } from "geojson";

import { SAFETY_WEIGHTS, type ProximityWeight } from "@/config/safetyWeights";
import { computeLightingMetrics } from "@/lib/scoring/lighting";
import { computeActivityScore } from "@/lib/scoring/activity";
import { computeEnvironmentScore } from "@/lib/scoring/environment";
import { computeSurveillanceScore, nearbyCctvSites } from "@/lib/scoring/surveillance";
import { combineDimensionScores } from "@/lib/scoring/weightedAverage";
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

export function calculateRoadSafety(
  dataset: SafetyDataset,
  candidatesForRoad?: (road: Feature<LineString>) => Feature<Point, SafetyFeatureProperties>[],
): ScoredRoadSegments {
  const pointFeatures = dataset.features.features;
  const maximumCrimePenalty = Math.abs(SAFETY_WEIGHTS.crimeRisk[5]);
  // 데이터셋에 좌표가 하나라도 있는 시설 타입만 점수에 반영한다. 아예 수집되지
  // 않은 타입은 0점이 아니라 미수집(null)으로 재정규화 대상이 된다.
  const availableTypes = new Set<SafetyFeatureType>(
    pointFeatures.map((feature) => feature.properties.type),
  );

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
      const nearbyCctv = nearbyCctvSites(road, candidates, SAFETY_WEIGHTS.cctv.radiusMeters);
      const cctvCount = nearbyCctv.length;
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

      const cctvContribution = cctvCount
        ? SAFETY_WEIGHTS.cctv.points * Math.max(...nearbyCctv.map((site) => site.confidence))
        : 0;
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

      // ── v2: 개념별 5차원. 기존 crimeScore(0~100)·조명 점수를 그대로 재사용한다.
      const surveillance = computeSurveillanceScore(road, candidates, availableTypes);
      const activity = computeActivityScore(road, candidates, availableTypes);
      const environment = computeEnvironmentScore(road, candidates, availableTypes);
      const crimeScore = crimeEntry || dataset.riskZones.features.length > 0 ? Math.round(
        clamp(100 - (Math.abs(crimeContribution) / maximumCrimePenalty) * 100),
      ) : null;
      const safetyScoreV2 = combineDimensionScores({
        lighting: lighting.lightingScore,
        surveillance: surveillance.score,
        activity: activity.score,
        environment: environment.score,
        crime: crimeScore,
      });

      // v2 세부 점수는 수집된 것(숫자)만 결과에 남기고 미수집(null)은 생략해
      // 데이터 파일 크기를 억제한다. UI는 없는 필드를 "데이터 없음"으로 표시한다.
      const detailScores = {
        cctvScore: surveillance.cctvScore,
        emergencyBellScore: surveillance.emergencyBellScore,
        cptedScore: surveillance.cptedScore,
        policeScore: surveillance.policeScore,
        nightActivityScore: activity.nightActivityScore,
        transitScore: activity.transitScore,
        roadActivityScore: activity.roadActivityScore,
        convenienceStoreScore: activity.convenienceStoreScore,
        vacancyScore: environment.vacancyScore,
        deteriorationScore: environment.deteriorationScore,
        sidewalkScore: environment.sidewalkScore,
        spatialStructureScore: environment.spatialStructureScore,
      };
      const details = Object.fromEntries(
        Object.entries(detailScores).filter(([, value]) => value !== null),
      ) as Partial<RoadSegmentProperties>;

      const properties: RoadSegmentProperties = {
        ...road.properties,
        lengthMeters: Math.round(length(road, { units: "kilometers" }) * 1000),
        lightingScore: lighting.lightingScore,
        lightingCoverage: Math.round(lighting.coverageScore),
        maxDarkGapMeters: Math.round(lighting.maxDarkGapMeters),
        lightingUniformityScore: Math.round(lighting.uniformityScore),
        surveillanceScore: surveillance.score,
        activityScore: activity.score,
        environmentScore: environment.score,
        crimeScore,
        crimeSampleCount: crimeEntry?.sampleCount ?? null,
        sidewalkContribution,
        safetyScoreV2,
        safetyScore,
        streetlightCount,
        cctvCount,
        emergencyBellCount,
        convenienceStoreCount,
        cptedCount,
        oldBuildingCount,
        riskLevel,
        ...details,
      };

      return { ...road, properties };
    }),
  };
}
