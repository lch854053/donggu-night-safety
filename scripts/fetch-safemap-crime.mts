/**
 * 생활안전지도(안전디딤돌) 여성밤길치안안전(전체, IF_0080)과
 * 범죄주의구간(전체, IF_0087) WMS를 동구 타일로 내려받아
 * 도로별 상대적 주의도(public/data/crime-risk.json)를 산출한다.
 * 두 레이어 모두 경찰청 밀도분석 10등급이라 같은 샘플링을 쓰며,
 * IF_0080(밤 시간대 20~24시)을 우선하고 닿지 않는 구간은
 * IF_0087(전체 시간대)로 보완해 커버리지를 확보한다.
 *
 * - WMS 파라미터는 공식 OpenLayers 예제와 같이 소문자여야 한다
 *   (layers/styles/srs/bbox/width/height/format/transparent). 표준 대문자
 *   (LAYERS/SRS...)을 쓰면 서버가 항상 일반 400 페이지로만 응답한다.
 * - IF_0080은 styles 를 빈 값으로 호출해야만 렌더된다(공식 lgdInfo의 스타일명을
 *   넣으면 400). 빈 스타일 렌더가 공식 10등급 팔레트와 일치함은 픽셀 매칭으로
 *   확인됐다. IF_0087은 기존처럼 스타일명을 그대로 쓴다.
 * - IF_0080 타일에는 등급 도로선 외에 치안시설이 없는 지역의 #333333 음영이
 *   섞여 렌더된다. 샘플러는 범례색만 인정하므로 음영 픽셀은 noData로 배제된다.
 * - 경찰청 요청으로 원본 좌표가 비공개라(도로 클리핑·등급 가공만 제공) WMS
 *   래스터 샘플링이 유일한 방법이다. 산출값은 밀도분석 10등급의 상대 참고값이며
 *   실제 범죄 발생 가능성을 예측하지 않는다.
 *
 * 사용:
 *   npm run fetch:safemap-crime            # 전체 실행 (타일 캐시 재사용)
 *   npm run fetch:safemap-crime -- --force # 타일 재다운로드
 * 키: .env.local의 SAFEMAP_SERVICE_KEY 또는 환경변수. 없으면 경고 후 종료하며
 * 기존 crime-risk.json은 건드리지 않는다.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { PNG } from "pngjs";

import { SAFETY_WEIGHTS } from "../config/safetyWeights";
import { combineCrimeLevels, lonLatToWebMercator, nearestLegendLevel,
  sampleRoadPoints, webMercatorToLonLat } from "../lib/scoring/crimeRisk";
import type { CrimeRiskConfig } from "../config/safetyWeights";
import type { Feature, LineString } from "geojson";

const root = fileURLToPath(new URL("../", import.meta.url));
// 우선순위 순서. 앞 레이어가 닿은 구간은 뒤 레이어로 덮지 않는다.
const SOURCES = [
  {
    intId: "IF_0080",
    layer: "A2SM_CRMNLHSPOT_F1_TOT",
    // WMS는 styles를 비워 호출해야만 렌더된다(헤더 주석). 범례는 lgdInfo를 LAYER로만 조회한다.
    style: "",
    label: "여성밤길치안안전(전체)",
  },
  {
    intId: "IF_0087",
    layer: "A2SM_CRMNLHSPOT_TOT",
    style: "A2SM_CrmnlHspot_Tot_Tot",
    label: "범죄주의구간(전체)",
  },
] as const;
const WMS_BASE = "https://safemap.go.kr/openapi2";
const LEGEND_URL = "https://www.safemap.go.kr/openapi2/lgdInfo";
const BBOX_PAD_DEGREES = 0.004; // 경계 밖 ~400m 완충

const crimeConfig: CrimeRiskConfig = SAFETY_WEIGHTS.crime;

if (existsSync(resolve(root, ".env.local"))) {
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const SERVICE_KEY = process.env.SAFEMAP_SERVICE_KEY?.trim();
if (!SERVICE_KEY) {
  console.error("SAFEMAP_SERVICE_KEY 가 없습니다. .env.local 에 추가한 뒤 실행하세요. 기존 crime-risk.json을 유지합니다.");
  process.exit(1);
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const noOverlay = args.includes("--no-overlay");
const gridArg = args.find((a) => a.startsWith("--grid="));
const grid = Math.max(1, Math.min(6, Number(gridArg?.slice(7)) || 3));
const tileArg = args.find((a) => a.startsWith("--tile-size="));
const tileSize = Math.max(256, Math.min(4096, Number(tileArg?.slice(12)) || 1024));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url: string, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "donggu-night-safety/0.1" } });
      if (res.ok) return res;
      console.warn(`  HTTP ${res.status} (시도 ${i + 1}/${tries})`);
    } catch (error) {
      console.warn(`  요청 실패 (시도 ${i + 1}/${tries}):`, error instanceof Error ? error.message : error);
    }
    await sleep(500 * (i + 1));
  }
  return null;
}

// 1) 동구 경계 bbox → Web Mercator (도로 좌표계 4326, WMS 좌표계 3857)
const boundary = JSON.parse(readFileSync(resolve(root, "scripts/data/donggu-admin-boundaries.geojson"), "utf8"));
let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
for (const feature of boundary.features) {
  const rings = feature.geometry.type === "Polygon"
    ? feature.geometry.coordinates
    : feature.geometry.coordinates.map((polygon) => polygon[0]);
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    }
  }
}
const [minX, minY] = lonLatToWebMercator([minLon - BBOX_PAD_DEGREES, minLat - BBOX_PAD_DEGREES]);
const [maxX, maxY] = lonLatToWebMercator([maxLon + BBOX_PAD_DEGREES, maxLat + BBOX_PAD_DEGREES]);
const spanX = (maxX - minX) / grid;
const spanY = (maxY - minY) / grid;
console.log(`동구 WMS 타일: ${grid}x${grid} @ ${tileSize}px (${((maxX - minX) / 1000).toFixed(1)}km 영역)`);

// 2) 도로 원본. 두 레이어 샘플링에서 같이 쓴다.
const roadsFile = JSON.parse(readFileSync(resolve(root, "scripts/data/road-segments.geojson"), "utf8"));

interface SourceRoadStats {
  crimeRisk: number; level: number; mean: number; max: number; highRiskRatio: number;
  sampleCount: number; noDataRatio: number;
}
type SourceDefinition = (typeof SOURCES)[number];

interface CollectedSource {
  definition: SourceDefinition;
  legendLevels: { level: number; color: string; label: string }[];
  legendWarning: string;
  tiles: { row: number; col: number; png: PNG }[];
  roads: Record<string, SourceRoadStats>;
  levelDistribution: Record<string, number>;
  withData: number;
}

async function collectSource(definition: SourceDefinition): Promise<CollectedSource> {
  const { intId, layer, style, label } = definition;

  // 3) 범례 (색상을 임의로 추측하지 않는다 — 공식 lgdInfo API)
  const cacheDir = resolve(root, `.cache/safemap-crime/${intId}_${grid}x${grid}_${tileSize}px`);
  mkdirSync(cacheDir, { recursive: true });
  const legendCachePath = resolve(cacheDir, "legend.json");
  let legendLevels: { level: number; color: string; label: string }[] = [];
  let legendWarning = "";
  if (existsSync(legendCachePath) && !force) {
    const cached = JSON.parse(readFileSync(legendCachePath, "utf8"));
    legendLevels = cached.levels;
    legendWarning = cached.warning;
    console.log(`[${label}] 범례 캐시 재사용: ${legendLevels.length}단계`);
  } else {
    const res = await fetchWithRetry(
      `${LEGEND_URL}?serviceKey=${encodeURIComponent(SERVICE_KEY)}&intId=${intId}&pageNo=1&numOfRows=50`);
    const body = res ? await res.json().catch(() => null) : null;
    const items: Record<string, string>[] = body?.body?.items?.item ?? [];
    legendLevels = items
      .filter((item) => item.LAYER === layer && (!style || item.STYLE === style))
      .map((item) => ({ level: Number(item.LGD_NO), color: item.IMAGE, label: item.LGD_NM }))
      .sort((a, b) => a.level - b.level);
    legendWarning = String(items[0]?.WARN ?? "").replace(/<br\s*\/?>/g, " ").trim();
    if (!legendLevels.length) {
      console.error(`[${label}] 범례 조회 실패 — 색상을 임의로 추측하지 않고 종료합니다. 기존 crime-risk.json을 유지합니다.`);
      process.exit(1);
    }
    writeFileSync(legendCachePath, JSON.stringify({ levels: legendLevels, warning: legendWarning }));
    console.log(`[${label}] 범례 조회: ${legendLevels.length}단계 (${legendLevels[0].color} ~ ${legendLevels.at(-1)!.color})`);
  }
  const legendMaxLevel = Math.max(...legendLevels.map((entry) => entry.level));

  // 4) 타일 다운로드 (캐시 우선, 서버 부하를 줄이는 스로틀)
  const tiles: { row: number; col: number; png: PNG }[] = [];
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let row = 0; row < grid; row++) {
    for (let col = 0; col < grid; col++) {
      const path = resolve(cacheDir, `r${row}c${col}.png`);
      let buffer: Buffer | null = existsSync(path) && !force ? readFileSync(path) : null;
      if (!buffer) {
        const tileBbox = [
          minX + col * spanX, minY + row * spanY, minX + (col + 1) * spanX, minY + (row + 1) * spanY,
        ].join(",");
        const url = `${WMS_BASE}/${intId}_WMS?serviceKey=${encodeURIComponent(SERVICE_KEY)}` +
          `&layers=${layer}&styles=${style}&srs=EPSG:3857&bbox=${tileBbox}` +
          `&width=${tileSize}&height=${tileSize}&format=image/png&transparent=true`;
        const res = await fetchWithRetry(url);
        buffer = res ? Buffer.from(await res.arrayBuffer()) : null;
        if (!buffer || !buffer.subarray(0, 8).equals(pngMagic)) {
          console.error(`[${label}] 타일 r${row}c${col} 다운로드 실패 — 기존 crime-risk.json을 유지하고 종료합니다.`);
          process.exit(1);
        }
        writeFileSync(path, buffer);
        await sleep(250); // 서버 부하 최소화
      }
      tiles.push({ row, col, png: PNG.sync.read(buffer) });
    }
  }

  let totalMatchedPixels = 0;
  for (const tile of tiles) {
    for (let i = 0; i < tile.png.data.length; i += 4) {
      if (tile.png.data[i + 3] <= 40) continue;
      if (nearestLegendLevel(
        { r: tile.png.data[i], g: tile.png.data[i + 1], b: tile.png.data[i + 2] },
        legendLevels, crimeConfig.maxColorDistance,
      ) !== null) totalMatchedPixels++;
    }
  }
  if (totalMatchedPixels === 0) {
    console.error(`[${label}] 모든 타일이 비어 있습니다 — WMS 렌더링 실패로 보입니다. 기존 crime-risk.json을 유지하고 종료합니다.`);
    process.exit(1);
  }
  console.log(`[${label}] 타일 ${tiles.length}개 준비, 범례 매칭 픽셀 ${totalMatchedPixels.toLocaleString()}개`);

  // 5) 임의 좌표 → 타일 → 픽셀 → 위험등급
  function levelAtMercator(mercatorX: number, mercatorY: number): number | null {
    const col = Math.min(grid - 1, Math.max(0, Math.floor((mercatorX - minX) / spanX)));
    const row = Math.min(grid - 1, Math.max(0, Math.floor((mercatorY - minY) / spanY)));
    const tile = tiles.find((t) => t.row === row && t.col === col)!;
    const px = Math.min(tileSize - 1, Math.max(0, Math.floor(((mercatorX - (minX + col * spanX)) / spanX) * tileSize)));
    const py = Math.min(tileSize - 1, Math.max(0, Math.floor(((minY + (row + 1) * spanY - mercatorY) / spanY) * tileSize)));
    const index = (py * tileSize + px) * 4;
    if (tile.png.data[index + 3] <= 40) return null; // 투명 = noData (위험도 0이 아님)
    return nearestLegendLevel(
      { r: tile.png.data[index], g: tile.png.data[index + 1], b: tile.png.data[index + 2] },
      legendLevels, crimeConfig.maxColorDistance,
    );
  }

  // 6) 도로 20m 샘플링 → 도로별 통계
  const roads: Record<string, SourceRoadStats> = {};
  const levelDistribution: Record<string, number> = {};
  let withData = 0;
  for (const feature of roadsFile.features as Feature<LineString>[]) {
    const id = feature.properties?.id;
    if (!id) continue;
    const levels = sampleRoadPoints(feature, crimeConfig.sampleIntervalMeters)
      .map(([lon, lat]) => levelAtMercator(...lonLatToWebMercator([lon, lat])));
    const stats = combineCrimeLevels(levels, crimeConfig, legendMaxLevel);
    if (!stats) continue; // 매칭 픽셀 없음 = 데이터 없음 (위험도 0이 아님)
    withData++;
    roads[id] = {
      crimeRisk: Number(stats.crimeRisk.toFixed(4)),
      level: stats.crimeLevel,
      mean: Number(stats.meanRisk.toFixed(4)),
      max: Number(stats.maxRisk.toFixed(4)),
      highRiskRatio: Number(stats.highRiskRatio.toFixed(4)),
      sampleCount: stats.sampleCount,
      noDataRatio: Number((stats.noDataCount / stats.sampleCount).toFixed(3)),
    };
    levelDistribution[String(stats.crimeLevel)] = (levelDistribution[String(stats.crimeLevel)] ?? 0) + 1;
  }
  console.log(`[${label}] 도로 ${withData.toLocaleString()}/${roadsFile.features.length} 구간에 데이터, 감점 단계 분포: ` +
    Object.entries(levelDistribution).sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([level, count]) => `${level}단계 ${count}`).join(", "));

  return { definition, legendLevels, legendWarning, tiles, roads, levelDistribution, withData };
}

const collected: CollectedSource[] = [];
for (const source of SOURCES) {
  collected.push(await collectSource(source));
}
const [primary, fallback] = collected;

// 7) 병합. 여성밤길(IF_0080)을 우선하고 닿지 않는 구간만 범죄주의구간(IF_0087)으로 채운다.
//    출처를 구간별로 남겨 어떤 레이어 값인지 추적 가능하게 한다.
const roads: Record<string, SourceRoadStats & { source: SourceDefinition["intId"] }> = {};
for (const [id, entry] of Object.entries(primary.roads)) {
  roads[id] = { ...entry, source: primary.definition.intId };
}
let overlap = 0;
for (const [id, entry] of Object.entries(fallback.roads)) {
  if (roads[id]) { overlap++; continue; }
  roads[id] = { ...entry, source: fallback.definition.intId };
}
const withData = Object.keys(roads).length;
const levelDistribution: Record<string, number> = {};
for (const entry of Object.values(roads)) {
  levelDistribution[String(entry.level)] = (levelDistribution[String(entry.level)] ?? 0) + 1;
}
console.log(`병합: 도로 ${withData.toLocaleString()}/${roadsFile.features.length} 구간 ` +
  `(여성밤길 ${primary.withData.toLocaleString()} + 범죄주의구간 보완 ${(withData - primary.withData).toLocaleString()}, 겹침 ${overlap.toLocaleString()}구간은 여성밤길 우선), ` +
  `감점 단계 분포: ` + Object.entries(levelDistribution).sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([level, count]) => `${level}단계 ${count}`).join(", "));

// 8) 지도 오버레이용 원본 래스터 (서비스키 없는 정적 PNG, 시각 참고용).
//    범죄주의구간 타일을 깔고 여성밤길 타일의 불투명 픽셀을 위에 덮는다(점수 병합과 같은 우선순위).
let overlay: { url: string; coordinates: [number, number][] } | null = null;
if (!noOverlay) {
  const width = grid * tileSize;
  const merged = new PNG({ width, height: width });
  for (const collectedSource of [fallback, primary]) {
    for (const tile of collectedSource.tiles) {
      for (let y = 0; y < tileSize; y++) {
        const from = y * tileSize * 4;
        const to = ((tile.row * tileSize + y) * width + tile.col * tileSize) * 4;
        if (collectedSource === primary) {
          for (let x = 0; x < tileSize; x++) {
            const offset = from + x * 4;
            if (tile.png.data[offset + 3] > 40) {
              merged.data.set(tile.png.data.subarray(offset, offset + 4), to + x * 4);
            }
          }
        } else {
          merged.data.set(tile.png.data.subarray(from, from + tileSize * 4), to);
        }
      }
    }
  }
  mkdirSync(resolve(root, "public/data/crime-wms"), { recursive: true });
  writeFileSync(resolve(root, "public/data/crime-wms/overlay.png"), PNG.sync.write(merged));
  const corners = ([[minX, maxY], [maxX, maxY], [maxX, minY], [minX, minY]] as const)
    .map((point) => webMercatorToLonLat(point).map((value) => Number(value.toFixed(8)))) as [number, number][];
  overlay = { url: "/data/crime-wms/overlay.png", coordinates: corners };
}

// 9) 산출물. 입력 도로 해시를 남겨 도로 갱신 시 재실행 필요성을 알 수 있게 한다.
const output = {
  source: "생활안전지도 여성밤길치안안전(전체)+범죄주의구간(전체) WMS",
  dataSource: "safemap IF_0080+IF_0087 WMS",
  provider: "행정안전부 생활안전지도 / 경찰청",
  mergePolicy: "IF_0080(여성밤길) 우선, 미커버 구간은 IF_0087(범죄주의구간)로 보완",
  layer: primary.definition.layer, style: primary.definition.style, intId: primary.definition.intId,
  sources: collected.map((collectedSource) => ({
    intId: collectedSource.definition.intId,
    layer: collectedSource.definition.layer,
    style: collectedSource.definition.style,
    label: collectedSource.definition.label,
    legend: collectedSource.legendLevels,
    legendWarning: collectedSource.legendWarning,
    withData: collectedSource.withData,
  })),
  generatedAt: new Date().toISOString(),
  // 하위호환 대표 범례(우선 레이어 것). 두 레이어 모두 경찰청 밀도분석 10등급 팔레트다.
  legend: primary.legendLevels,
  legendWarning: primary.legendWarning,
  grid: { grid, tileSize, mercatorBbox: { minX, minY, maxX, maxY } },
  overlay,
  roadSegmentsSha256: createHash("sha256")
    .update(readFileSync(resolve(root, "scripts/data/road-segments.geojson")))
    .digest("hex").slice(0, 16),
  crimeConfig,
  summary: {
    roads: roadsFile.features.length,
    withData,
    withoutData: roadsFile.features.length - withData,
    levelDistribution,
    overlap,
    fromFallback: withData - primary.withData,
  },
  roads,
};
writeFileSync(resolve(root, "public/data/crime-risk.json"), JSON.stringify(output));
console.log(`crime-risk.json 저장 (${withData.toLocaleString()} 구간${overlay ? ", overlay.png 포함" : ""})`);
