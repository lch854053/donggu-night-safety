import type { Feature, LineString, Point } from "geojson";

import type { ActivityConfig } from "@/config/safetyWeights";
import { SAFETY_SCORES_V2 } from "@/config/safetyWeights";
import type { RoadSegmentInputProperties, SafetyFeatureProperties, SafetyFeatureType } from "@/types/safety";
import {
  interpolatedBandScore,
  pointDistancesToRoad,
  pointsWithDistanceToRoad,
  stepScore,
} from "./proximityScore";
import { weightedAverageAvailable } from "./weightedAverage";

export interface ActivityResult {
  score: number | null;
  nightActivityScore: number | null;
  transitScore: number | null;
  roadActivityScore: number | null;
  convenienceStoreScore: number | null;
}

/**
 * 야간 운영시설(night_activity)의 기여도 합계 → 포화 점수(0~100).
 * 개수 합산이 아니라 시설별 기여도(거리 감쇠 × 야간 운영 수준 × 유형 가중치)의
 * 합에 로그 포화를 적용해 상가 밀집 지역이 무한히 유리해지지 않게 한다.
 * 야간시설 많음 = 안전이 아니라 활동성·자연감시 가능성의 proxy다.
 */
export function computeNightActivityScore(
  road: Feature<LineString>,
  candidates: Feature<Point, SafetyFeatureProperties>[],
  config: ActivityConfig,
): number {
  let weightedSum = 0;
  for (const { feature, meters } of pointsWithDistanceToRoad(
    road, candidates, "night_activity", config.nightActivity.radiusMeters,
  )) {
    const props = feature.properties;
    const distanceWeight = interpolatedBandScore(meters, config.nightActivity.distanceBreakpoints);
    // opening_hours 미확인은 unknownNightScore(약한 기여), 주간 전용은 기여 0.
    const nightScore = props.nightScore ?? config.nightActivity.unknownNightScore;
    const categoryWeight =
      config.nightActivity.categoryWeights[props.category ?? ""] ??
      config.nightActivity.defaultCategoryWeight;
    weightedSum += distanceWeight * nightScore * categoryWeight;
  }
  return Math.min(100, config.nightActivity.saturationScale * Math.log2(1 + weightedSum));
}

/**
 * 야간활동·자연감시 점수(0~100). 야간 운영시설 40% · 대중교통 25% ·
 * 도로 활성도 proxy 20% · 편의점/안심거점 15%.
 * 좌표 데이터가 수집된 항목만 계산하고 나머지는 재정규화로 제외한다(가짜값 금지).
 */
export function computeActivityScore(
  road: Feature<LineString, RoadSegmentInputProperties>,
  candidates: Feature<Point, SafetyFeatureProperties>[],
  availableTypes: ReadonlySet<SafetyFeatureType>,
  config: ActivityConfig = SAFETY_SCORES_V2.activity,
): ActivityResult {
  const nightActivityScore = availableTypes.has("night_activity")
    ? Math.round(computeNightActivityScore(road, candidates, config))
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

  // 도로가 크다는 이유만으로 안전 가점을 주지 않는다. 폭원 기반의 약한 proxy로
  // activityScore의 20%에만 반영한다. 폭원 속성이 없으면 임의 추정하지 않고 null.
  const widthMeters = road.properties.widthMeters;
  const roadActivityScore =
    widthMeters != null && widthMeters > 0
      ? stepScore(widthMeters, config.roadActivityWidthSteps)
      : null;

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
