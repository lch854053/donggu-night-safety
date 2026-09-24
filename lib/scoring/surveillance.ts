import type { Feature, LineString, Point } from "geojson";
import { distance, nearestPointOnLine } from "@turf/turf";

import type { BandScoreConfig, SurveillanceConfig } from "@/config/safetyWeights";
import { CCTV_PURPOSE_CONFIDENCE, SAFETY_SCORES_V2 } from "@/config/safetyWeights";
import type { SafetyFeatureProperties, SafetyFeatureType } from "@/types/safety";
import { countBonusFactor, interpolatedBandScore, pointDistancesToRoad } from "./proximityScore";
import { weightedAverageAvailable } from "./weightedAverage";

export function cctvConfidence(properties: SafetyFeatureProperties): number {
  if (properties.confidence !== undefined && Number.isFinite(properties.confidence)) {
    return Math.min(1, Math.max(0, properties.confidence));
  }
  // 구형 GeoJSON·테스트 픽스처에는 목적 정보가 없었다. 기존 점수와 호환한다.
  return properties.purpose ? CCTV_PURPOSE_CONFIDENCE[properties.purpose] : 1;
}

export function nearbyCctvSites(
  road: Feature<LineString>, candidates: Feature<Point, SafetyFeatureProperties>[], radiusMeters: number,
) {
  const sites = new Map<string, { meters: number; confidence: number }>();
  for (const candidate of candidates) {
    if (candidate.properties.type !== "cctv") continue;
    const meters = distance(candidate, nearestPointOnLine(road, candidate), { units: "kilometers" }) * 1000;
    if (meters > radiusMeters) continue;
    const key = candidate.geometry.coordinates.map((value) => value.toFixed(6)).join(",");
    const current = sites.get(key);
    const confidence = cctvConfidence(candidate.properties);
    if (!current || confidence > current.confidence) sites.set(key, { meters, confidence });
  }
  return [...sites.values()];
}

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

  const cctvSites = availableTypes.has("cctv")
    ? nearbyCctvSites(road, candidates, config.cctv.radiusMeters)
    : null;
  const cctvBase = cctvSites === null ? null : Math.max(0, ...cctvSites.map((site) =>
    interpolatedBandScore(site.meters, config.cctv.breakpoints) * site.confidence));
  // 서로 다른 CCTV 설치지점만 포화형 보너스에 반영한다(카메라 대수에는 비례하지 않음).
  const cctvScore =
    cctvBase === null
      ? null
      : Math.round(Math.min(100, cctvBase * countBonusFactor(
        cctvSites!.filter((site) => site.confidence >= config.cctv.minBonusConfidence).length,
        config.cctv.countBonus)));

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
