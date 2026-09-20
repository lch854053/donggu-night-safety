export interface ProximityWeight {
  radiusMeters: number;
  points: number;
  maxOccurrences: number;
}

export const SAFETY_WEIGHTS = {
  baseScore: 50,
  lighting: {
    radiusMeters: 50,
    points: 8,
    maxOccurrences: 2,
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
  lighting: ProximityWeight;
  cctv: ProximityWeight;
  emergencyBell: ProximityWeight;
  convenienceStore: ProximityWeight;
  cpted: ProximityWeight;
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
