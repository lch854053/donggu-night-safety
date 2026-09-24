import type { Feature, LineString, Point } from "geojson";

import type { ActivityConfig } from "@/config/safetyWeights";
import { SAFETY_SCORES_V2 } from "@/config/safetyWeights";
import type { RoadSegmentInputProperties, SafetyFeatureProperties, SafetyFeatureType } from "@/types/safety";
import { interpolatedBandScore, pointDistancesToRoad, stepScore } from "./proximityScore";
import { weightedAverageAvailable } from "./weightedAverage";

export interface ActivityResult {
  score: number | null;
  nightActivityScore: number | null;
  transitScore: number | null;
  roadActivityScore: number | null;
  convenienceStoreScore: number | null;
}

/**
 * 야간활동·자연감시 점수(0~100). 야간 영업시설 40% · 대중교통 25% ·
 * 도로 활성도 proxy 20% · 편의점/안심거점 15%.
 * 실제 보행량 데이터가 없는 초기 구조이며, 좌표 데이터가 수집된 항목만
 * 계산하고 나머지는 재정규화로 제외한다(가짜값 금지).
 */
export function computeActivityScore(
  road: Feature<LineString, RoadSegmentInputProperties>,
  candidates: Feature<Point, SafetyFeatureProperties>[],
  availableTypes: ReadonlySet<SafetyFeatureType>,
  config: ActivityConfig = SAFETY_SCORES_V2.activity,
): ActivityResult {
  // TODO(night-activity): 음식점·카페·약국·PC방·숙박 등 야간 영업 POI를
  // night_activity 타입으로 수집하면 자동 반영된다. 현재 데이터 없음 → 항상 null.
  const nightActivityScore = availableTypes.has("night_activity")
    ? stepScore(
        pointDistancesToRoad(road, candidates, "night_activity", config.nightActivity.radiusMeters)
          .length,
        config.nightActivity.countSteps,
      )
    : null;

  // TODO(transit): bus_stop·subway_entrance 좌표 수집 후 자동 반영.
  const transitCandidates: SafetyFeatureType[] = ["bus_stop", "subway_entrance"];
  const transitTypes = transitCandidates.filter((type) => availableTypes.has(type));
  const transitScore = transitTypes.length
    ? Math.round(
        Math.min(
          ...transitTypes.map((type) => {
            const distances = pointDistancesToRoad(
              road, candidates, type, config.transit.radiusMeters);
            return interpolatedBandScore(
              distances.length ? distances[0] : config.transit.radiusMeters,
              config.transit.breakpoints,
            );
          }),
        ),
      )
    : null;

  // 계획상 규모는 실제 보행량이 아니다. 집행완료·단일 지정 구간에서만 폭원 점수와
  // 약하게 혼합한다. 별도 가점으로 중복 합산하지 않는다.
  const widthMeters = road.properties.widthMeters;
  const widthScore = widthMeters != null && widthMeters > 0
    ? stepScore(widthMeters, config.roadActivityWidthSteps) : null;
  const planningGrade = road.properties.planningRoadGrade;
  const roadActivityScore = widthScore === null ? null
    : planningGrade && road.properties.planningRoadStatus === "집행완료"
      ? Math.round(widthScore * (1 - config.roadActivityGradeShare)
        + config.roadActivityGradeScores[planningGrade] * config.roadActivityGradeShare)
      : widthScore;

  // 기존 +5 직접 가점을 폐기하고 안심거점 proxy로 이동. 단독 최종점수 가점 없음.
  const convenienceStoreScore = availableTypes.has("convenience_store")
    ? stepScore(
        pointDistancesToRoad(
          road, candidates, "convenience_store", config.convenienceStore.radiusMeters,
        ).length,
        config.convenienceStore.countSteps,
      )
    : null;

  const score = weightedAverageAvailable([
    { value: nightActivityScore, weight: config.weights.nightActivity },
    { value: transitScore, weight: config.weights.transit },
    { value: roadActivityScore, weight: config.weights.roadActivity },
    { value: convenienceStoreScore, weight: config.weights.convenienceStore },
  ]);

  return {
    score: score === null ? null : Math.round(score),
    nightActivityScore,
    transitScore,
    roadActivityScore,
    convenienceStoreScore,
  };
}
