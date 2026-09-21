import { along, length } from "@turf/turf";
import type { Feature, LineString } from "geojson";

import type { CrimeRiskConfig } from "@/config/safetyWeights";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHexColor(hex: string): Rgb {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

export function colorDistance(a: Rgb, b: Rgb) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/**
 * 픽셀 RGB를 가장 가까운 범례 등급으로 변환한다.
 * WMS 렌더링에는 안티앨리어싱·경계 혼색이 있어 exact match 대신 최근접 색을 쓰고,
 * maxColorDistance를 넘거나 알파가 낮은 픽셀은 null(noData)로 둔다.
 * noData는 위험도 0이 아니라 "데이터 없음"이므로 호출부가 null로 구분해야 한다.
 */
export function nearestLegendLevel(
  rgb: Rgb,
  legend: readonly { level: number; color: string }[],
  maxColorDistance: number,
): number | null {
  let best: { level: number; distance: number } | null = null;
  for (const entry of legend) {
    const distance = colorDistance(rgb, parseHexColor(entry.color));
    if (!best || distance < best.distance) best = { level: entry.level, distance };
  }
  if (!best || best.distance > maxColorDistance) return null;
  return best.level;
}

const WEB_MERCATOR_RADIUS = 6378137;

/** EPSG:4326 → EPSG:3857. 단순 삼각함수라 proj4 같은 좌표계 의존성이 필요 없다. */
export function lonLatToWebMercator(lonLat: readonly number[]): [number, number] {
  const [lon, lat] = lonLat;
  return [
    WEB_MERCATOR_RADIUS * (lon * Math.PI) / 180,
    WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
  ];
}

export function webMercatorToLonLat(mercator: readonly number[]): [number, number] {
  const [x, y] = mercator;
  return [
    (x / WEB_MERCATOR_RADIUS) * 180 / Math.PI,
    ((Math.atan(Math.exp(y / WEB_MERCATOR_RADIUS)) - Math.PI / 4) * 360) / Math.PI,
  ];
}

/**
 * 도로를 intervalMeters 간격으로 샘플링한 WGS84 좌표 목록.
 * 아주 짧은 도로도 최소 1개 샘플을 갖는다.
 */
export function sampleRoadPoints(
  road: Feature<LineString>,
  intervalMeters: number,
): [number, number][] {
  const lengthKm = length(road, { units: "kilometers" });
  const count = Math.max(1, Math.floor((lengthKm * 1000) / intervalMeters) + 1);
  const points: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const point = along(road, Math.min(i * (intervalMeters / 1000), lengthKm)).geometry
      .coordinates as [number, number];
    points.push(point);
  }
  return points;
}

export interface CrimeStats {
  sampleCount: number;
  noDataCount: number;
  meanRisk: number;
  maxRisk: number;
  highRiskRatio: number;
  crimeRisk: number;
  crimeLevel: number;
}

/**
 * 샘플별 범례 등급(1~10)을 도로 단위 통계로 합친다.
 * - 등급은 10등급 만점으로 정규화(level/10)한다.
 * - meanRisk 50% + maxRisk 20% + highRiskRatio 30%:
 *   평균을 기본으로 하되 고위험 구간 비율과 최악 지점이 반영되도록 하는 조합.
 * - noData 샘플은 통계에서 제외되며(위험도 0이 아님), 전부 noData면 null을
 *   반환해 호출부가 "데이터 없음"으로 기록하게 한다.
 */
export function combineCrimeLevels(
  levels: readonly (number | null)[],
  config: CrimeRiskConfig,
  legendMaxLevel: number,
): CrimeStats | null {
  const matched = levels.filter((level): level is number => level !== null);
  if (!matched.length) return null;
  const normalized = matched.map((level) => level / legendMaxLevel);
  const meanRisk = normalized.reduce((sum, value) => sum + value, 0) / normalized.length;
  const maxRisk = Math.max(...normalized);
  const highRiskRatio =
    matched.filter((level) => level >= config.highRiskLevel).length / matched.length;
  const crimeRisk =
    meanRisk * config.weights.mean +
    maxRisk * config.weights.max +
    highRiskRatio * config.weights.high;
  const crimeLevel = Math.min(5, Math.floor(crimeRisk / config.levelStep + 1e-9));
  return {
    sampleCount: levels.length,
    noDataCount: levels.length - matched.length,
    meanRisk,
    maxRisk,
    highRiskRatio,
    crimeRisk,
    crimeLevel,
  };
}
