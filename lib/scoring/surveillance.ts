import type { Feature, LineString, Point } from "geojson";

import type { BandScoreConfig, SurveillanceConfig } from "@/config/safetyWeights";
import { SAFETY_SCORES_V2 } from "@/config/safetyWeights";
import type { SafetyFeatureProperties, SafetyFeatureType } from "@/types/safety";
import { countBonusFactor, interpolatedBandScore, pointDistancesToRoad } from "./proximityScore";
import { weightedAverageAvailable } from "./weightedAverage";

export interface SurveillanceResult {
  score: number | null;
  cctvScore: number | null;
  emergencyBellScore: number | null;
  cptedScore: number | null;
  policeScore: number | null;
}

/**
 * 감시·긴급대응 점수(0~100). CCTV 50% · CPTED 25% · 비상벨 15% · 경찰시설 10%.
 * 좌표 데이터가 수집된 항목만 계산하고 미수집 항목은 weightedAverageAvailable이
 * 재정규화해 제외한다(0점 처리 금지). 전부 미수집이면 null.
 */
export function computeSurveillanceScore(
  road: Feature<LineString>,
  candidates: Feature<Point, SafetyFeatureProperties>[],
  availableTypes: ReadonlySet<SafetyFeatureType>,
  config: SurveillanceConfig = SAFETY_SCORES_V2.surveillance,
): SurveillanceResult {
  // 데이터 타입이 수집돼 있을 때만 계산한다. 반경 내 시설이 없으면 데이터는 있지만
  // 가까운 시설이 없는 것이므로 이때만 0점이 맞다.
  const bandScore = (type: SafetyFeatureType, band: BandScoreConfig) => {
    if (!availableTypes.has(type)) return null;
    const distances = pointDistancesToRoad(road, candidates, type, band.radiusMeters);
    const distance = distances.length ? distances[0] : band.radiusMeters;
    return Math.round(interpolatedBandScore(distance, band.breakpoints));
  };

  const cctvDistances = availableTypes.has("cctv")
    ? pointDistancesToRoad(road, candidates, "cctv", config.cctv.radiusMeters)
    : null;
  const cctvBase = cctvDistances
    ? interpolatedBandScore(
        cctvDistances.length ? cctvDistances[0] : config.cctv.radiusMeters,
        config.cctv.breakpoints,
      )
    : null;
  // CCTV 여러 대는 포화형 보너스만 받는다(개수에 선형 비례하지 않음).
  const cctvScore =
    cctvBase === null
      ? null
      : Math.round(Math.min(100, cctvBase * countBonusFactor(cctvDistances!.length, config.cctv.countBonus)));

  const cptedScore = bandScore("cpted", config.cpted);
  const emergencyBellScore = bandScore("emergency_bell", config.emergencyBell);
  const policeScore = bandScore("police_station", config.police);

  const score = weightedAverageAvailable([
    { value: cctvScore, weight: config.weights.cctv },
    { value: cptedScore, weight: config.weights.cpted },
    { value: emergencyBellScore, weight: config.weights.emergencyBell },
    { value: policeScore, weight: config.weights.police },
  ]);

  return {
    score: score === null ? null : Math.round(score),
    cctvScore,
    emergencyBellScore,
    cptedScore,
    policeScore,
  };
}
