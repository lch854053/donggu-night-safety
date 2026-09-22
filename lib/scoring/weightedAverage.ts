import { SAFETY_SCORES_V2 } from "@/config/safetyWeights";

export interface WeightedEntry {
  /** 미수집 하위지표는 0이 아니라 null. 0점과 완전히 다른 의미다. */
  value: number | null;
  weight: number;
}

export function clampScore(value: number) {
  return Math.min(100, Math.max(0, value));
}

/**
 * 사용 가능한(value != null) 하위지표끼리 가중치를 재정규화해 평균낸다.
 * 데이터 미수집 항목을 0점으로 넣으면 부당한 감점이 생기므로 제외하고
 * 남은 weight 합으로 나눈다. 전부 null이면 결과도 null — 0과 다른 의미다.
 */
export function weightedAverageAvailable(entries: readonly WeightedEntry[]): number | null {
  let sum = 0;
  let weightSum = 0;
  for (const entry of entries) {
    if (entry.value === null || !Number.isFinite(entry.value)) continue;
    sum += entry.value * entry.weight;
    weightSum += entry.weight;
  }
  return weightSum > 0 ? sum / weightSum : null;
}

/**
 * v2 최종 점수: 5개 상위 차원의 가중 평균. 미수집 차원(crime 미커버 구간 등)은
 * 재정규화로 제외되고, 하나라도 있으면 항상 0~100 값을 낸다.
 */
export function combineDimensionScores(dimensions: {
  lighting: number;
  surveillance: number | null;
  activity: number | null;
  environment: number | null;
  crime: number | null;
}): number | null {
  const weights = SAFETY_SCORES_V2.dimensionWeights;
  const score = weightedAverageAvailable([
    { value: dimensions.lighting, weight: weights.lighting },
    { value: dimensions.surveillance, weight: weights.surveillance },
    { value: dimensions.activity, weight: weights.activity },
    { value: dimensions.environment, weight: weights.environment },
    { value: dimensions.crime, weight: weights.crime },
  ]);
  return score === null ? null : Math.round(clampScore(score));
}
