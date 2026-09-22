import type { Feature, LineString, Point } from "geojson";

import type { EnvironmentConfig } from "@/config/safetyWeights";
import { SAFETY_SCORES_V2 } from "@/config/safetyWeights";
import type {
  PedestrianAccess,
  RoadSegmentInputProperties,
  SafetyFeatureProperties,
  SafetyFeatureType,
} from "@/types/safety";
import { pointDistancesToRoad, stepScore } from "./proximityScore";
import { weightedAverageAvailable } from "./weightedAverage";

export interface EnvironmentResult {
  score: number | null;
  vacancyScore: number | null;
  deteriorationScore: number | null;
  sidewalkScore: number | null;
  spatialStructureScore: number | null;
}

/**
 * 공간환경·방치도 점수(0~100). 빈집 45% · 건축물 노후/방치 20% ·
 * 보행환경 20% · 공간구조 15%. 100점에서 취약요인이 확인될수록 감점한다.
 * 좌표 데이터가 수집된 항목만 반영하고 미수집은 재정규화로 제외한다.
 */
export function computeEnvironmentScore(
  road: Feature<LineString, RoadSegmentInputProperties>,
  candidates: Feature<Point, SafetyFeatureProperties>[],
  availableTypes: ReadonlySet<SafetyFeatureType>,
  config: EnvironmentConfig = SAFETY_SCORES_V2.environment,
): EnvironmentResult {
  // TODO(vacancy): 빈집 좌표를 확보하면 자동 반영된다. 데이터가 없어 항상 null.
  // 확보 후에는 개수 단계 대신 거리 가중(0~30m 1.0 / 30~60m 0.7 / 60~100m 0.3)으로 정밀화.
  const vacancyScore = availableTypes.has("vacant_house")
    ? stepScore(
        pointDistancesToRoad(road, candidates, "vacant_house", config.vacancy.radiusMeters).length,
        config.vacancy.countSteps,
      )
    : null;

  // 노후건축물은 약한 보조지표다. 기존 -8 직접 감점을 폐기했고 최종 영향은
  // environmentScore의 20% 안으로 제한된다. 오래된 건축연도를 빈집·폐가와
  // 동일하게 취급하지 않는다(빈집은 vacancy가 별도 강한 지표).
  const deteriorationScore = availableTypes.has("old_building")
    ? stepScore(
        pointDistancesToRoad(
          road, candidates, "old_building", config.deterioration.radiusMeters,
        ).length,
        config.deterioration.countSteps,
      )
    : null;

  // import-sidewalks.py가 매긴 구간 속성을 점수로 환산한다. 기존 no → -3 직접
  // 감점을 폐기하고 environmentScore 내부로 이동. 미검증(unverified)은 null.
  const access: PedestrianAccess | undefined = road.properties.pedestrianAccess;
  const sidewalkScore = access === "yes"
    ? config.sidewalkScores.yes
    : access === "partial"
      ? config.sidewalkScores.partial
      : access === "no"
        ? config.sidewalkScores.no
        : null;

  // TODO(spatial-structure): 막다른 골목·좁은 골목·옹벽·보행 단절·시야 차폐
  // 데이터는 미수집. 가짜 데이터를 만들지 않으므로 데이터가 생길 때까지 항상 null.
  const spatialStructureScore: number | null = null;

  const score = weightedAverageAvailable([
    { value: vacancyScore, weight: config.weights.vacancy },
    { value: deteriorationScore, weight: config.weights.deterioration },
    { value: sidewalkScore, weight: config.weights.sidewalk },
    { value: spatialStructureScore, weight: config.weights.spatialStructure },
  ]);

  return {
    score: score === null ? null : Math.round(score),
    vacancyScore,
    deteriorationScore,
    sidewalkScore,
    spatialStructureScore,
  };
}
