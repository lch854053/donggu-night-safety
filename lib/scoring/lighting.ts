import { along, length } from "@turf/turf";
import type { Feature, LineString, Point } from "geojson";

import type { LightingConfig } from "@/config/safetyWeights";
import type { SafetyFeatureProperties } from "@/types/safety";

function clamp0to100(value: number) {
  return Math.min(100, Math.max(0, value));
}

/** 한 개 조명 위치가 거리 d(미터)에 남기는 상대 영향(0~1]. 가우시안 거리 감쇠. */
export function lightInfluence(distanceMeters: number, sigmaMeters: number) {
  return Math.exp(-((distanceMeters / sigmaMeters) ** 2));
}

/**
 * 여러 조명 위치의 결합 영향. 합산 후 clamp하는 대신 곱 포화 1-∏(1-x)를 쓴다.
 * 각 등의 기여를 0~1의 독립 커버처럼 다루기 때문에 등이 몰려도 1을 넘지 않고,
 * clamp의 자르기 왜곡 없이 부드럽게 포화하며, 영향 순서와 무관하게 같은 값을 낸다.
 */
export function combinedInfluence(distances: number[], sigmaMeters: number) {
  let darkness = 1;
  for (const distance of distances) darkness *= 1 - lightInfluence(distance, sigmaMeters);
  return 1 - darkness;
}

/**
 * 최대 암구간 길이 → 점수. breakpoints([암구간 m, 점수], 오름차순) 구간 사이는
 * 선형 보간하고, 양끝 밖은 clamp한다.
 */
export function darkGapScore(
  gapMeters: number,
  breakpoints: readonly (readonly [gapMeters: number, score: number])[],
) {
  if (!breakpoints.length) return 0;
  const [firstGap, firstScore] = breakpoints[0];
  if (gapMeters <= firstGap) return firstScore;
  const [lastGap, lastScore] = breakpoints[breakpoints.length - 1];
  if (gapMeters >= lastGap) return lastScore;
  for (let i = 1; i < breakpoints.length; i++) {
    const [nextGap, nextScore] = breakpoints[i];
    const [prevGap, prevScore] = breakpoints[i - 1];
    if (gapMeters <= nextGap) {
      return prevScore + ((gapMeters - prevGap) / (nextGap - prevGap)) * (nextScore - prevScore);
    }
  }
  return lastScore;
}

/**
 * 가장 어두운 하위 darkShare 비율 샘플의 평균 영향을 0~100으로 환산한다.
 * 균일도라 부르지만 실질적으로는 "어두운 구간의 품질" 지표이며, 최솟값 하나가
 * 점수 전체를 흔들지 않도록 하위 구간 평균을 쓴다(count는 올림).
 */
export function darkSpanQuality(influences: number[], darkShare: number) {
  if (!influences.length) return 0;
  const sorted = [...influences].sort((a, b) => a - b);
  const count = Math.max(1, Math.ceil(sorted.length * darkShare));
  let sum = 0;
  for (let i = 0; i < count; i++) sum += sorted[i];
  return clamp0to100((sum / count) * 100);
}

export interface LightingMetrics {
  coverageScore: number;
  maxDarkGapMeters: number;
  darkGapScore: number;
  uniformityScore: number;
  lightingScore: number;
}

/**
 * 도로를 sampleIntervalMeters 간격으로 샘플링해 조명 환경 지표를 계산한다.
 * 실제 조도(lux)가 아닌 보안등·가로등 위치·거리 분포 기반의 상대적 추정값이다.
 *
 * 샘플×조명 위치 거리는 Turf distance(haversine) 대신 도로 시작점 기준
 * 등장투영 평면 미터로 계산한다. 전 구간에서 수십만 회 호출되는 전처리
 * 경로라서이고, 110m 이내 스케일에서 오차는 mm 수준이다. 샘플링과 후보
 * 탐색(roadPointIndex)은 여전히 Turf를 사용한다.
 */
export function computeLightingMetrics(
  road: Feature<LineString>,
  lightFeatures: Feature<Point, SafetyFeatureProperties>[],
  config: LightingConfig,
): LightingMetrics {
  const lengthMeters = length(road, { units: "kilometers" }) * 1000;
  const sampleCount = Math.max(2, Math.floor(lengthMeters / config.sampleIntervalMeters) + 1);
  const intervalKm = config.sampleIntervalMeters / 1000;
  const [originLon, originLat] = road.geometry.coordinates[0];
  const lonMeters = 111320 * Math.cos((originLat * Math.PI) / 180);
  const toLocalMeters = (position: readonly number[]): [number, number] =>
    [(position[0] - originLon) * lonMeters, (position[1] - originLat) * 111320];

  const samples: [number, number][] = [];
  for (let i = 0; i < sampleCount; i++) {
    const point = along(road, Math.min(i * intervalKm, lengthMeters / 1000)).geometry
      .coordinates as [number, number];
    samples.push(toLocalMeters(point));
  }
  const lights = lightFeatures.map((light) => {
    const [x, y] = toLocalMeters(light.geometry.coordinates);
    const kind = light.properties.type === "road_light" ? "road_light" : "security_light";
    const { sigmaMeters, cutoffMeters } = config.lightTypes[kind];
    return { x, y, sigmaMeters, cutoffSquared: cutoffMeters ** 2 };
  });

  const influences = samples.map(([x, y]) => {
    let darkness = 1;
    for (const light of lights) {
      const dx = x - light.x;
      const dy = y - light.y;
      const squared = dx * dx + dy * dy;
      if (squared <= light.cutoffSquared) {
        darkness *= 1 - lightInfluence(Math.sqrt(squared), light.sigmaMeters);
      }
    }
    return 1 - darkness;
  });

  let covered = 0;
  let longestDarkRun = 0;
  let currentDarkRun = 0;
  for (const influence of influences) {
    if (influence >= config.coverageThreshold) {
      covered += 1;
      currentDarkRun = 0;
    } else {
      currentDarkRun += 1;
      longestDarkRun = Math.max(longestDarkRun, currentDarkRun);
    }
  }
  // 각 샘플은 좌우 간격/2 구간을 대표한다는 근사로 연속 암샘플 수 × 간격.
  // 구간 끝에서 과대평가되지 않도록 도로 길이로 clamp한다.
  const maxDarkGapMeters = Math.min(longestDarkRun * config.sampleIntervalMeters, lengthMeters);

  const coverageScore = (covered / influences.length) * 100;
  const gapScore = darkGapScore(maxDarkGapMeters, config.darkGapBreakpoints);
  const uniformityScore = darkSpanQuality(influences, config.uniformityDarkShare);
  const lightingScore = Math.round(
    clamp0to100(
      coverageScore * config.weights.coverage +
        gapScore * config.weights.darkGap +
        uniformityScore * config.weights.uniformity,
    ),
  );

  return {
    coverageScore,
    maxDarkGapMeters,
    darkGapScore: gapScore,
    uniformityScore,
    lightingScore,
  };
}
