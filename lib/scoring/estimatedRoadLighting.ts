import type { SafetyDataset } from "@/types/safety";

type Estimate = NonNullable<SafetyDataset["roadLightingEvidenceByRoad"]>[string];

/** 두 보정안은 비교용이다. 관리행은 광원 수가 아니며 신뢰도 낮은 근거는 감쇠한다. */
export function estimatedRoadLightingModels(actual: number, estimate?: Estimate, hasSecurityLight = true) {
  const confidence = estimate?.matchConfidence ?? 0;
  const evidence = (estimate?.roadLightingEvidence ?? 0) * (confidence < 0.6 ? 0 : confidence < 0.8 ? 0.5 : 1);
  if (evidence === 0) return { A: actual, B: actual };
  // 50m 표시용 개수에는 없지만 60m cutoff 안에 보안등이 있는 구간도 있다.
  // 추정치만으로 60점을 넘기지 않되 이미 산출된 실제 보안등 점수는 낮추지 않는다.
  const cap = hasSecurityLight ? 100 : Math.max(actual, 60);
  return {
    A: Math.min(cap, Math.round(actual * 0.8 + evidence * 100 * 0.2)),
    B: Math.min(cap, Math.round(actual + (100 - actual) * evidence * 0.25)),
  };
}
