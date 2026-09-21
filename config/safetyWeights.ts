export interface ProximityWeight {
  radiusMeters: number;
  points: number;
  maxOccurrences: number;
}

/**
 * 보안등 위치 기반 상대적 조명 환경 설정. 실제 조도(lux) 데이터가 아니므로
 * 모든 값은 보안등 좌표와 거리 분포에서 나온 추정 기준값이다.
 */
export interface LightingConfig {
  sampleIntervalMeters: number;
  influenceSigmaMeters: number;
  /** 이 거리 밖 보안등은 영향이 1% 미만(≈3σ)이라 후보 탐색에서 제외한다. */
  influenceCutoffMeters: number;
  /** streetlightCount(UI 표시·디버깅용) 집계 반경. 기존 50m 기준을 유지한다. */
  countRadiusMeters: number;
  coverageThreshold: number;
  /** 기존 보안등 최대 가점(8점×2개)과 같은 수준을 유지하기 위한 상한. */
  contributionPoints: number;
  weights: { coverage: number; darkGap: number; uniformity: number };
  /** [암구간 길이(m), 점수] 오름차순 — 구간 사이는 선형 보간한다. */
  darkGapBreakpoints: readonly (readonly [gapMeters: number, score: number])[];
  /** 균일도 계산에 쓸 하위 샘플 비율(가장 어두운 쪽 대표값). */
  uniformityDarkShare: number;
}

export const SAFETY_WEIGHTS = {
  baseScore: 50,
  // 보안등은 개수가 아니라 구간 샘플별 감쇠 영향(위치·거리 분포)으로 조명 환경을 평가한다.
  lighting: {
    sampleIntervalMeters: 5,
    influenceSigmaMeters: 20,
    influenceCutoffMeters: 60,
    countRadiusMeters: 50,
    coverageThreshold: 0.25,
    contributionPoints: 16,
    weights: { coverage: 0.5, darkGap: 0.3, uniformity: 0.2 },
    darkGapBreakpoints: [[0, 100], [10, 90], [20, 70], [30, 45], [40, 20], [50, 0]],
    uniformityDarkShare: 0.2,
  },
  cctv: {
    radiusMeters: 100,
    points: 10,
    maxOccurrences: 1,
  },
  emergencyBell: {
    radiusMeters: 100,
    points: 8,
    maxOccurrences: 1,
  },
  convenienceStore: {
    radiusMeters: 100,
    points: 5,
    maxOccurrences: 1,
  },
  cpted: {
    radiusMeters: 100,
    points: 8,
    maxOccurrences: 1,
  },
  // 인도 인접 여부는 import-sidewalks.py가 구간별로 계산해 pedestrianAccess로 반영한다.
  // 미커버 구간은 실제 부재와 지형도 미작성이 섞여 있어 감점은 보수적으로 유지한다.
  sidewalk: {
    missingPenalty: -3,
  },
  crimeRisk: {
    0: 0,
    1: -3,
    2: -7,
    3: -12,
    4: -18,
    5: -25,
  },
  oldBuilding: {
    radiusMeters: 100,
    points: -2,
    maxOccurrences: 4,
  },
} as const satisfies {
  baseScore: number;
  lighting: LightingConfig;
  cctv: ProximityWeight;
  emergencyBell: ProximityWeight;
  convenienceStore: ProximityWeight;
  cpted: ProximityWeight;
  sidewalk: { missingPenalty: number };
  crimeRisk: Record<0 | 1 | 2 | 3 | 4 | 5, number>;
  oldBuilding: ProximityWeight;
};

export const SAFETY_SCORE_BANDS = [
  { min: 80, max: 100, label: "상대적 안심 높음", color: "#167663" },
  { min: 65, max: 79, label: "상대적 안심 양호", color: "#4e9862" },
  { min: 50, max: 64, label: "중간", color: "#d6a62f" },
  { min: 35, max: 49, label: "주의 참고", color: "#d77a35" },
  { min: 0, max: 34, label: "높은 주의 참고", color: "#bb3e3e" },
] as const;

export function getSafetyBand(score: number) {
  return SAFETY_SCORE_BANDS.find((band) => score >= band.min) ?? SAFETY_SCORE_BANDS.at(-1)!;
}
