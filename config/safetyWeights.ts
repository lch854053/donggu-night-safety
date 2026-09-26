export { CCTV_PURPOSE_CONFIDENCE } from "./cctvPurpose.mjs";

export interface ProximityWeight {
  radiusMeters: number;
  points: number;
  maxOccurrences: number;
}

/** 여성밤길 치안안전(밤 시간대 범죄 밀도분석 WMS 샘플링) 설정. 실제 범죄 발생 확률이 아니다. */
export interface CrimeRiskConfig {
  /** 도로 LineString 따라 샘플링할 간격(미터). 최소 1개 샘플 보장. */
  sampleIntervalMeters: number;
  /** highRiskRatio 계산에 쓸 고위험 기준(생활안전지도 10등급 기준). */
  highRiskLevel: number;
  /** crimeRisk = mean*w + max*w + highRatio*w (0~1). */
  weights: { mean: number; max: number; high: number };
  /** crimeRisk 0~1을 0~5 감점 단계로 나눌 폭. */
  levelStep: number;
  /** 픽셀↔범례색 최근접 매칭 최대 유클리드 거리(안티앨리어싱 허용폭). */
  maxColorDistance: number;
}

/**
 * 실제 보안등 좌표 기반 상대적 조명 환경 설정. 가로등 대표좌표는 광원으로 쓰지 않는다.
 */
export interface LightingConfig {
  sampleIntervalMeters: number;
  lightTypes: Record<"security_light", { sigmaMeters: number; cutoffMeters: number }>;
  /** 도로 관리자료 추정치 결합. A/B 비교 후 실제 보안등 점수를 낮추지 않는 B를 채택. */
  estimatedRoadLightModel: "actual" | "A" | "B";
  /** 표시·디버깅용 위치 집계 반경. 기존 50m 기준을 유지한다. */
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
  // 개수가 아니라 구간 샘플별 감쇠 영향(위치·거리 분포)으로 평가한다. lux 측정치가 아니다.
  lighting: {
    sampleIntervalMeters: 5,
    lightTypes: {
      security_light: { sigmaMeters: 20, cutoffMeters: 60 },
    },
    estimatedRoadLightModel: "B" as LightingConfig["estimatedRoadLightModel"],
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
  // 여성밤길 치안안전은 생활안전지도(경찰청 밀도분석 10등급, 밤 시간대 20~24시)
  // WMS를 도로 주변에서 샘플링해 산출한다. 실제 범죄 발생 가능성을 예측하는 수치가 아니다.
  crime: {
    sampleIntervalMeters: 20,
    highRiskLevel: 6,
    weights: { mean: 0.5, max: 0.2, high: 0.3 },
    levelStep: 0.2,
    maxColorDistance: 30,
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
  crime: CrimeRiskConfig;
  oldBuilding: ProximityWeight;
};

/** 거리(m)에 따른 점수. breakpoints는 [거리, 점수] 오름차순, 구간 사이 선형 보간. */
export interface BandScoreConfig {
  radiusMeters: number;
  breakpoints: readonly (readonly [distanceMeters: number, score: number])[];
}

/** 개수에 따른 단계형 점수. countSteps는 [임계값, 점수] 오름차순, 첫 임계값 미만은 0. */
export interface CountScoreConfig {
  radiusMeters: number;
  countSteps: readonly (readonly [count: number, score: number])[];
}

/** v2 감시·긴급대응 설정. CCTV는 예방, 비상벨·경찰시설은 긴급대응 성격을 반영해 가중치를 나눈다. */
export interface SurveillanceConfig {
  weights: { cctv: number; cpted: number; emergencyBell: number; police: number };
  cctv: BandScoreConfig & { /** 포화형 보너스. 개수에 선형 비례하지 않는다. */ countBonus: { two: number; threePlus: number }; minBonusConfidence: number };
  cpted: BandScoreConfig;
  emergencyBell: BandScoreConfig;
  police: BandScoreConfig;
}

/** v2 야간활동·자연감시 설정. 실제 보행량 데이터가 없어 proxy 조합이다. */
export interface ActivityConfig {
  weights: { nightActivity: number; transit: number; roadActivity: number; convenienceStore: number };
  nightActivity: CountScoreConfig;
  transit: BandScoreConfig;
  /** 폭원(m) 기준 약한 활성도 proxy. RDD 도로등급 코드는 원본 그대로라 미해석한다. */
  roadActivityWidthSteps: readonly (readonly [widthMeters: number, score: number])[];
  /** 집행완료·단일 지정 구간만 폭원 proxy와 약하게 혼합한다. 실제 보행량이 아니다. */
  roadActivityGradeShare: number;
  roadActivityGradeScores: Readonly<Record<"소로" | "중로" | "대로" | "광로", number>>;
  convenienceStore: CountScoreConfig;
}

/** v2 공간환경·방치도 설정. 100점에서 취약요인이 확인될수록 감점한다. */
export interface EnvironmentConfig {
  weights: { vacancy: number; deterioration: number; sidewalk: number; spatialStructure: number };
  vacancy: CountScoreConfig;
  /** 노후건축물은 약한 보조지표. 빈집(별도 강한 지표)과 동일 취급하지 않는다. */
  deterioration: CountScoreConfig;
  sidewalkScores: { yes: number; partial: number; no: number };
}

/** v2 밤길 안전 참고지수 설정. 모든 하위 점수는 0~100, 미수집은 null(재정규화 대상). */
export const SAFETY_SCORES_V2 = {
  dimensionWeights: { lighting: 0.25, surveillance: 0.2, activity: 0.15, environment: 0.15, crime: 0.25 },
  surveillance: {
    weights: { cctv: 0.5, cpted: 0.25, emergencyBell: 0.15, police: 0.1 },
    cctv: {
      radiusMeters: 200,
      breakpoints: [[0, 100], [50, 80], [100, 50], [150, 20], [200, 0]],
      countBonus: { two: 1.1, threePlus: 1.15 },
      minBonusConfidence: 0.3,
    },
    cpted: {
      radiusMeters: 200,
      breakpoints: [[0, 100], [50, 80], [100, 50], [150, 20], [200, 0]],
    },
    emergencyBell: {
      radiusMeters: 150,
      breakpoints: [[0, 100], [50, 70], [100, 40], [150, 0]],
    },
    police: {
      radiusMeters: 1000,
      breakpoints: [[0, 100], [300, 70], [600, 30], [1000, 0]],
    },
  },
  activity: {
    weights: { nightActivity: 0.4, transit: 0.25, roadActivity: 0.2, convenienceStore: 0.15 },
    nightActivity: {
      radiusMeters: 100,
      countSteps: [[0, 0], [1, 30], [2, 60], [4, 80], [7, 100]],
    },
    transit: {
      radiusMeters: 500,
      breakpoints: [[0, 100], [100, 80], [300, 50], [500, 0]],
    },
    roadActivityWidthSteps: [[0, 20], [5.5, 40], [12, 70], [20, 100]],
    roadActivityGradeShare: 0.2,
    roadActivityGradeScores: { 소로: 25, 중로: 55, 대로: 80, 광로: 90 },
    convenienceStore: {
      radiusMeters: 100,
      countSteps: [[0, 0], [1, 40], [2, 70], [3, 100]],
    },
  },
  environment: {
    weights: { vacancy: 0.45, deterioration: 0.2, sidewalk: 0.2, spatialStructure: 0.15 },
    vacancy: {
      radiusMeters: 50,
      countSteps: [[0, 100], [1, 70], [2, 50], [3, 30]],
    },
    deterioration: {
      radiusMeters: 100,
      countSteps: [[0, 100], [1, 80], [2, 60], [4, 40]],
    },
    sidewalkScores: { yes: 100, partial: 60, no: 20 },
  },
} as const satisfies {
  dimensionWeights: { lighting: number; surveillance: number; activity: number; environment: number; crime: number };
  surveillance: SurveillanceConfig;
  activity: ActivityConfig;
  environment: EnvironmentConfig;
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
