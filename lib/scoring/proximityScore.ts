import { distance, nearestPointOnLine } from "@turf/turf";
import type { Feature, LineString, Point } from "geojson";

import type { SafetyFeatureProperties, SafetyFeatureType } from "@/types/safety";

/**
 * 도로 주변 type 후보점들의 도로까지 거리(m) 목록. 반경 밖은 제외, 오름차순.
 * lighting.ts의 보안등 전용 감쇠와 달리 시설 점수용 공통 헬퍼다.
 */
export function pointDistancesToRoad(
  road: Feature<LineString>,
  candidates: Feature<Point, SafetyFeatureProperties>[],
  type: SafetyFeatureType,
  radiusMeters: number,
): number[] {
  const distances: number[] = [];
  for (const candidate of candidates) {
    if (candidate.properties.type !== type) continue;
    const meters =
      distance(candidate, nearestPointOnLine(road, candidate), { units: "kilometers" }) * 1000;
    if (meters <= radiusMeters) distances.push(meters);
  }
  return distances.sort((a, b) => a - b);
}

/** [기준값, 점수] 오름차순 구간 사이 선형 보간. 범위 밖은 끝값. */
export function interpolatedBandScore(
  value: number,
  breakpoints: readonly (readonly [value: number, score: number])[],
): number {
  if (!breakpoints.length) return 0;
  const [firstValue, firstScore] = breakpoints[0];
  if (value <= firstValue) return firstScore;
  const [lastValue, lastScore] = breakpoints[breakpoints.length - 1];
  if (value >= lastValue) return lastScore;
  for (let i = 1; i < breakpoints.length; i++) {
    const [nextValue, nextScore] = breakpoints[i];
    const [prevValue, prevScore] = breakpoints[i - 1];
    if (value <= nextValue) {
      return prevScore + ((value - prevValue) / (nextValue - prevValue)) * (nextScore - prevScore);
    }
  }
  return lastScore;
}

/**
 * [임계값, 점수] 단계형. value 이상 임계값 중 가장 큰 것의 점수.
 * 첫 임계값 미만은 0(예: 개수 0개 → 0점).
 */
export function stepScore(
  value: number,
  steps: readonly (readonly [threshold: number, score: number])[],
): number {
  let score = 0;
  for (const [threshold, bandScore] of steps) {
    if (value >= threshold) score = bandScore;
  }
  return score;
}

/** 여러 대일 때의 포화형 보너스. 1대=1배, 2대=two, 3대 이상=threePlus. 선형 비례 금지. */
export function countBonusFactor(count: number, bonus: { two: number; threePlus: number }) {
  if (count < 2) return 1;
  return count === 2 ? bonus.two : bonus.threePlus;
}
