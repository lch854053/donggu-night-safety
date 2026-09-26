import type { SafetyDataset } from "@/types/safety";
import { estimatedRoadLightingModels } from "@/lib/scoring/estimatedRoadLighting";

type Estimate = NonNullable<SafetyDataset["roadLightingEvidenceByRoad"]>[string];
const bound = (score: number) => Math.max(0, Math.min(100, score));

/** 서로 다른 수준의 두 근거를 0~100에서 포화 결합한다. 물리적 조도(lux) 합산이 아니다. */
export function saturatingLightingUnion(securityLightingScore: number, roadLightingScore: number) {
  const security = bound(securityLightingScore) / 100;
  const road = bound(roadLightingScore) / 100;
  return Math.round(100 * (1 - (1 - security) * (1 - road)));
}

export function compareLightingModels(securityLightingScore: number, estimate?: Estimate, hasSecurityLight = true) {
  const roadLightingScore = estimate?.roadLightingScore ?? 0;
  return {
    OLD: estimatedRoadLightingModels(securityLightingScore, estimate, hasSecurityLight).B,
    MAX: Math.max(securityLightingScore, roadLightingScore),
    UNION: saturatingLightingUnion(securityLightingScore, roadLightingScore),
  };
}
