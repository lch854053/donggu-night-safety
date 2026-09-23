#!/usr/bin/env node
// 야간 운영시설(night_activity) 수집 스크립트 — OpenStreetMap(Overpass API)
//
//   node scripts/fetch-night-facilities.mjs
//
// 대상: shop=convenience·supermarket, amenity=restaurant·cafe·fast_food·pharmacy·hospital.
// bar·pub·nightclub 등 유흥시설은 의도적으로 제외한다. "밤에 사람이 많다"는 것은
// 보행자 자연감시와 다르며, 야간활동 지표(natural surveillance proxy)의 대상이 아니다.
//
// 산출물:
//   public/data/night-facilities.geojson       시설 FeatureCollection (별도 파일로 관리)
//   public/data/night-facilities-meta.json     수집 기록·집계
//
// 방어적 동작:
//   - Overpass 인스턴스 3곳을 순서대로 시도하고 timeout·retry를 둔다.
//   - 수집 실패 시 기존 night-facilities.geojson을 절대 덮어쓰지 않고 비정상 종료한다.
//     (GitHub Actions에서는 커밋이 생략되어 이전 데이터로 배포가 유지된다.)
//   - 수집 결과가 이전 대비 절반 미만이면 장애·부분 응답으로 보고 실패 처리한다.
//   - 좌표는 BBOX·한국 범위 자가검사를 통과한 것만 남긴다.
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { computeNightState } from "./lib/night-hours.mjs";
import { DONGGU_BBOX, inBbox, overpassBbox } from "./lib/config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_PATH = path.join(ROOT, "public", "data", "night-facilities.geojson");
const META_PATH = path.join(ROOT, "public", "data", "night-facilities-meta.json");

// 야간 자연감시 proxy 대상 생활시설. 유형 가중치는 config/safetyWeights.ts의
// SAFETY_SCORES_V2.activity.nightActivity.categoryWeights와 짝을 이룬다.
const TARGET_FILTERS = [
  ['["shop"~"^(convenience|supermarket)$"]', "shop"],
  ['["amenity"~"^(restaurant|cafe|fast_food|pharmacy|hospital)$"]', "amenity"],
];
// TODO(nightlife): bar·pub·nightclub은 별도 타입으로 수집해 시각화만 제공할 수 있다(점수 미반영).

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const CATEGORY_BY_TAG = {
  "shop/convenience": "convenience_store",
  "shop/supermarket": "supermarket",
  "amenity/restaurant": "restaurant",
  "amenity/cafe": "cafe",
  "amenity/fast_food": "fast_food",
  "amenity/pharmacy": "pharmacy",
  "amenity/hospital": "hospital",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildQuery() {
  const bbox = overpassBbox();
  const body = TARGET_FILTERS
    .map(([filter]) => `  nwr${filter}(${bbox});`)
    .join("\n");
  // out center: way/relation도 중심점 좌표를 준다. tags로 opening_hours를 받는다.
  return `[out:json][timeout:120];\n(\n${body}\n);\nout center tags;`;
}

async function fetchOverpass() {
  const query = buildQuery();
  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[Overpass] ${endpoint} (시도 ${attempt})`);
        const res = await fetch(endpoint, {
          method: "POST",
          body: "data=" + encodeURIComponent(query),
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "donggu-night-safety/0.1 (https://github.com/lch854053/donggu-night-safety)",
          },
          signal: AbortSignal.timeout(120_000),
        });
        if (res.status === 429 || res.status === 504) throw new Error(`HTTP ${res.status} (rate-limit/timeout)`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!Array.isArray(json.elements)) throw new Error("응답에 elements 없음");
        return json.elements;
      } catch (e) {
        lastError = e;
        console.warn(`  실패: ${e.message}`);
        await sleep(3000 * attempt); // rate-limit·일시 장애 고려한 백오프
      }
    }
  }
  throw lastError;
}

// OSM element → GeoJSON Feature. 불완전한 레코드(좌표·이름 누락)는 버리지 않되
// 최소한의 좌표는 있어야 한다. name 누락은 "유형명"으로 표시한다(점수에는 무관).
function toFeature(element) {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (!lat || !lon) return null;
  const tags = element.tags ?? {};
  const key = tags.shop ? `shop/${tags.shop}` : `amenity/${tags.amenity}`;
  const category = CATEGORY_BY_TAG[key];
  if (!category) return null; // 쿼리 밖 태그 혼입 방어
  const night = computeNightState(tags.opening_hours);
  return {
    type: "Feature",
    properties: {
      id: `osm-${element.type[0]}${element.id}`,
      type: "night_activity",
      category,
      name: tags.name ?? tags["name:ko"] ?? category,
      openingHours: tags.opening_hours,
      source: "openstreetmap",
      ...night,
    },
    geometry: { type: "Point", coordinates: [+lon.toFixed(6), +lat.toFixed(6)] },
  };
}

function summarize(features) {
  const byTier = {}, byCategory = {};
  let withOpeningHours = 0;
  for (const f of features) {
    const p = f.properties;
    byTier[p.nightTier] = (byTier[p.nightTier] ?? 0) + 1;
    byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;
    if (p.openingHours) withOpeningHours++;
  }
  return { withOpeningHours, byTier, byCategory };
}

async function main() {
  const started = new Date();
  const previousCount = existsSync(OUTPUT_PATH)
    ? JSON.parse(readFileSync(OUTPUT_PATH, "utf8")).features.length
    : null;

  const elements = await fetchOverpass();
  const features = elements
    .map(toFeature)
    .filter(Boolean)
    .filter((f) => inBbox(...f.geometry.coordinates)); // 좌표 변환·center 오차 방어

  // 자가검사: 빈 결과·급감·범위 밖 좌표는 장애로 보고 기존 파일을 보존한다.
  if (!features.length) throw new Error("수집 결과 0건 — 쿼리나 Overpass 상태를 확인하세요.");
  if (previousCount !== null && features.length < previousCount * 0.5) {
    throw new Error(`수집 결과 급감 (${previousCount} → ${features.length}) — 부분 응답 의심, 기존 파일 유지`);
  }
  const outside = features.filter((f) => {
    const [lon, lat] = f.geometry.coordinates;
    return !(lon > 124 && lon < 132 && lat > 33 && lat < 43);
  });
  if (outside.length) throw new Error(`한국 범위 밖 좌표 ${outside.length}건 — 좌표 오류 의심`);

  const fc = { type: "FeatureCollection", features };
  const stats = summarize(features);
  writeFileSync(`${OUTPUT_PATH}.tmp`, `${JSON.stringify(fc)}\n`, "utf8");
  renameSync(`${OUTPUT_PATH}.tmp`, OUTPUT_PATH); // 쓰기 실패로 기존 파일이 망가지지 않게 원자적 교체
  writeFileSync(
    META_PATH,
    `${JSON.stringify(
      {
        generatedAt: started.toISOString().slice(0, 10),
        source: "openstreetmap",
        via: "Overpass API",
        bbox: DONGGU_BBOX,
        counts: {
          total: features.length,
          previous: previousCount,
          withOpeningHours: stats.withOpeningHours,
          openingHoursRatio: +(stats.withOpeningHours / features.length).toFixed(3),
          byTier: stats.byTier,
          byCategory: stats.byCategory,
        },
        thresholds: { minNightDaysPerWeek: 4, unknownNightScore: 0.15 },
        note: "영업시간은 OSM 기여자 데이터로 실제와 다를 수 있다. bar/pub/nightclub은 야간활동 지표에서 의도적으로 제외했다.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log("\n=== 야간 운영시설 수집 완료 ===");
  console.log(`총 ${features.length}건 (이전: ${previousCount ?? "없음"}) · opening_hours 보유 ${stats.withOpeningHours}건`);
  console.log(JSON.stringify(stats.byTier), JSON.stringify(stats.byCategory));
  console.log(`저장: ${OUTPUT_PATH}`);
  console.log(`소요: ${((Date.now() - started) / 1000).toFixed(0)}초`);
}

main().catch((e) => {
  console.error("실패(기존 night-facilities.geojson 유지):", e.message);
  process.exit(1);
});
