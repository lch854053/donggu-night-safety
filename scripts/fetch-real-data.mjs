#!/usr/bin/env node
// 광주 동구 밤길 안전 지도 실데이터 수집 스크립트
// 사용:
//   node scripts/fetch-real-data.mjs                      전체 갱신
//   node scripts/fetch-real-data.mjs --only=security-lights,road-lights  조명만 갱신
// 키는 .env.local (SAFEMAP_SERVICE_KEY, MOIS_SERVICE_KEY, VWORLD_API_KEY) 또는 환경변수로 전달합니다.
//
// 소스별 상태
//   보안등      동구청 제공 CSV (scripts/data/donggu-security-lights.csv) 연 1회 갱신 ✅
//   가로등      동구 가로등현황 odcloud (2024년 기준) 좌표 대표 위치 ✅
//   CCTV        행안부 cctv_info                WGS84 좌표 ✅
//   비상벨      행안부 emergency_call_box_info   WGS84 좌표 ✅
//   편의점      안전디딤돌 IF_0039               Web Mercator(3857) 좌표 ✅
//   CPTED      안전디딤돌 IF_0023               완료 사업지 주소 → VWORLD 지오코딩 대표점
//   노후건물/범죄주의구간  안전디딤돌 WMS 전용(좌표 미공개) → 좌표 API 확보 후 추가
//   인도        국토지리정보원 보행로(N3L_A0033320 계열) → import-sidewalks.py, 연 1회 수동 ✅
//              (안전디딤돌 IF_0095는 같은 데이터의 무좌표 속성 API라 미사용)
//   도로 링크  국토지리정보원 도로중심선 → 시설 갱신 후 점수 자동 재계산
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { collectCptedFeatures, geocodeAddress } from "./cpted.mjs";
import { fetchPoliceRows, geocodePolice, normalizeAddress, policeName } from "./police-facilities.mjs";
import { buildMunicipalCctv, CCTV_APIS, fetchCctvSnapshot } from "./cctv.mjs";
import { CCTV_PURPOSE_CONFIDENCE, CCTV_PURPOSE_LABELS, classifyCctvPurpose } from "../config/cctvPurpose.mjs";
import { fetchBusStops } from "./bus-stops.mjs";
import { collectVacantHouses } from "./vacant-houses.mjs";
import { collectRoadLights } from "./road-lights.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "public", "data");
const FEATURES_PATH = path.join(DATA_DIR, "safety-features.geojson");
const META_PATH = path.join(DATA_DIR, "meta.json");
const CPTED_CACHE_PATH = path.join(DATA_DIR, "cpted-geocodes.json");
const SECURITY_LIGHT_CSV = path.join(ROOT, "scripts", "data", "donggu-security-lights.csv");

// .env.local 파서 (dotenv 의존성 없이 최소 구현)
if (existsSync(path.join(ROOT, ".env.local"))) {
  for (const line of readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const SAFEMAP_KEY = process.env.SAFEMAP_SERVICE_KEY;
const MOIS_KEY = process.env.MOIS_SERVICE_KEY;
const VWORLD_KEY = process.env.VWORLD_API_KEY;
const KAKAO_KEY = process.env.KAKAO_REST_API_KEY;
const TAGO_KEY = process.env.TAGO_SERVICE_KEY;
const ROAD_LIGHT_KEY = process.env.ROAD_LIGHT_SERVICE_KEY;

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice(7).split(",") : [];
const want = (source) => only.length === 0 || only.includes(source);
if (only.length && only.some((k) => !["cctv", "bell", "store", "streetlights", "security-lights", "road-lights", "cpted", "police", "bus", "vacant"].includes(k))) {
  console.error("--only 값은 cctv, bell, store, security-lights, road-lights, cpted, police, bus, vacant 중에서 선택합니다.");
  process.exit(1);
}

// 광주 동구 중심부 + 주변 완충 구간. 도로는 동구 안이지만 인접 구 시설도 점수에 유효하므로 넉넉하게 잡음.
const BBOX = { minLon: 126.86, minLat: 35.08, maxLon: 127.03, maxLat: 35.22 };
const inBbox = (lon, lat) =>
  lon >= BBOX.minLon && lon <= BBOX.maxLon && lat >= BBOX.minLat && lat <= BBOX.maxLat;
const inKorea = (lon, lat) => lon > 124 && lon < 132 && lat > 33 && lat < 43;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWithRetry(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "donggu-night-safety/0.1" }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (i === tries - 1) throw new Error(`${new URL(url).hostname}: ${e.message}${e.cause?.code ? ` (${e.cause.code})` : ""}`);
      console.warn(`  ${new URL(url).hostname} 요청 재시도 ${i + 1}/${tries - 1}`);
      await sleep(3000 * (i + 1));
    }
  }
}

async function runPool(jobs, workers) {
  const queue = [...jobs];
  let done = 0, failed = 0;
  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      try {
        await job();
      } catch (e) {
        failed++;
        if (failed <= 5) console.warn("  요청 실패(계속 진행):", e.message);
      }
      done++;
      if (done % 300 === 0) console.log(`  진행 ${done}/${done + queue.length}`);
      await sleep(60);
    }
  }
  await Promise.all(Array.from({ length: workers }, worker));
  return failed;
}

// 행안부 APIs: /info 오퍼레이션, numOfRows는 100으로 강제됨
async function fetchMois(slug) {
  const items = [];
  for (let pageNo = 1; ; pageNo++) {
    const body = JSON.parse(
      await getWithRetry(
        `https://apis.data.go.kr/1741000/${slug}/info?serviceKey=${MOIS_KEY}&pageNo=${pageNo}&numOfRows=100&type=json`,
      ),
    );
    const page = body.response?.body?.items?.item ?? [];
    items.push(...page);
    if (pageNo === 1) console.log(`  총 ${body.response.body.totalCount}건`);
    if (page.length < 100) break;
    await sleep(60);
  }
  return items;
}

// 안전디딤돌: /openapi2/IF_XXXX, 1000건/페이지
async function fetchSafemap(ifId, pageSize = 1000) {
  const items = [];
  for (let pageNo = 1; ; pageNo++) {
    const body = JSON.parse(
      await getWithRetry(
        `https://www.safemap.go.kr/openapi2/${ifId}?serviceKey=${SAFEMAP_KEY}&pageNo=${pageNo}&numOfRows=${pageSize}&type=json`,
      ),
    );
    if (body.header?.resultCode !== "00") throw new Error(`safemap ${ifId}: ${body.header?.resultMsg}`);
    const page = body.body?.items?.item ?? [];
    items.push(...page);
    if (pageNo === 1) console.log(`  총 ${body.body.totalCount}건`);
    if (page.length < pageSize) break;
    await sleep(60);
  }
  return items;
}

const mercatorToWgs84 = (x, y) => [
  (x / 6378137) * (180 / Math.PI),
  (Math.atan(Math.exp(y / 6378137)) - Math.PI / 4) * (180 / Math.PI) * 2,
];

const feat = (id, type, lon, lat, props) => ({
  type: "Feature",
  properties: { id, type, name: props.name, source: props.source, ...props },
  geometry: { type: "Point", coordinates: [+lon.toFixed(6), +lat.toFixed(6)] },
});

// 큰 따옴표 필드를 포함할 수 있는 표준데이터 CSV용 최소 파서
function parseCsvLine(line) {
  const out = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function collectSecurityLights() {
  console.log("[보안등] 동구청 CSV 읽기 (scripts/data/donggu-security-lights.csv)");
  const lines = readFileSync(SECURITY_LIGHT_CSV, "utf8").replace(/^\ufeff/, "").trim().split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const col = (name) => header.indexOf(name);
  const items = [];
  let dataAsOf = "";
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    const lat = Number(c[col("위도")]), lon = Number(c[col("경도")]);
    if (!lat || !lon) throw new Error(`좌표 누락 행: ${line}`);
    dataAsOf = dataAsOf > c[col("데이터기준일자")] ? dataAsOf : c[col("데이터기준일자")];
    items.push(
      feat(`light-${c[col("보안등위치명")]}`, "security_light", lon, lat, {
        name: c[col("보안등위치명")],
        installedAt: c[col("설치연도")] || undefined,
        note: [c[col("설치형태")], c[col("소재지지번주소")]].filter(Boolean).join(" · "),
        source: "donggu-office:csv",
      }),
    );
  }
  console.log(`  ${items.length}건, 데이터기준일자 ${dataAsOf}`);
  return { features: items, dataAsOf };
}

const collections = { cctv: [], emergency_bell: [], convenience_store: [], cpted: [], police_station: [], police_center: [], bus_stop: [], vacant_house: [], security_light: [], road_light: [] };
const metaSources = {};
let cptedMetadata;
let cptedCache;

async function collectCctv() {
  console.log("[CCTV] 행안부 cctv_info 전국 스캔");
  let total = 0;
  const firstPage = JSON.parse(
    await getWithRetry(`https://apis.data.go.kr/1741000/cctv_info/info?serviceKey=${MOIS_KEY}&pageNo=1&numOfRows=100&type=json`),
  );
  total = firstPage.response.body.totalCount;
  const pages = Math.ceil(total / 100);
  const items = firstPage.response.body.items?.item ?? [];
  const jobs = [];
  for (let p = 2; p <= pages; p++) {
    jobs.push(async () => {
      const body = JSON.parse(
        await getWithRetry(`https://apis.data.go.kr/1741000/cctv_info/info?serviceKey=${MOIS_KEY}&pageNo=${p}&numOfRows=100&type=json`),
      );
      items.push(...(body.response.body.items?.item ?? []));
    });
  }
  const failed = await runPool(jobs, 6);
  if (failed) throw new Error(`CCTV 일부 페이지 수집 실패: ${failed}/${pages} — 기존 데이터 보존`);
  for (const it of items) {
    const lon = Number(it.WGS84_LOT), lat = Number(it.WGS84_LAT);
    if (!lon || !lat || !inBbox(lon, lat)) continue;
    const purpose = classifyCctvPurpose(it.INSTL_PRPS_SE_NM);
    collections.cctv.push(
      feat(`cctv-${it.MNG_NO}`, "cctv", lon, lat, {
        name: `${it.MNG_INST_NM} CCTV`,
        installedAt: it.INSTL_YM || undefined,
        note: [it.INSTL_PRPS_SE_NM, it.LCTN_LOTNO_ADDR].filter(Boolean).join(" · "),
        address: it.LCTN_LOTNO_ADDR || undefined,
        purpose,
        purposeLabel: CCTV_PURPOSE_LABELS[purpose],
        confidence: CCTV_PURPOSE_CONFIDENCE[purpose],
        purposeSource: "current",
        source: "mois:cctv_info",
      }),
    );
  }
  console.log("[CCTV] 전남광주통합특별시 2026-06 위치 + 2021-08 목적 교차 확인");
  const [recent, historical] = await Promise.all([
    fetchCctvSnapshot(CCTV_APIS.current, MOIS_KEY),
    fetchCctvSnapshot(CCTV_APIS.historical, MOIS_KEY),
  ]);
  const boundaries = JSON.parse(readFileSync(path.join(ROOT, "scripts/data/donggu-admin-boundaries.geojson"), "utf8")).features;
  const merged = buildMunicipalCctv(recent, historical, boundaries, collections.cctv);
  collections.cctv = merged.features;
  metaSources.cctv = { count: collections.cctv.length, fetchedAt: new Date().toISOString().slice(0, 10),
    ...merged.stats,
    notes: ["설치목적 미기재 최신 행은 확인 가능한 2021년 동일 주소 목적만 참조; 과거 목적은 현재 운영 상태를 보증하지 않음",
      "쓰레기·교통 단속 및 목적 미확인 CCTV도 모델 내부 상대적 감시 신뢰계수로 제한적 반영",
      "촬영 방향·화각·모니터링 여부를 확인할 수 없어 점수에 반영하지 않음"] };
  console.log(`  동구 ${merged.stats.includedLocations}개 설치지점, 목적 미확인 ${merged.stats.purposeCounts.unknown}개`);
}

async function collectBells() {
  console.log("[비상벨] 행안부 emergency_call_box_info 전국 스캔");
  const items = await fetchMois("emergency_call_box_info");
  for (const it of items) {
    const lon = Number(it.WGS84_LOT), lat = Number(it.WGS84_LAT);
    if (!lon || !lat || !inBbox(lon, lat)) continue;
    collections.emergency_bell.push(
      feat(`bell-${it.MNG_NO}`, "emergency_bell", lon, lat, {
        name: `${it.MNG_INST_NM} 안전비상벨`,
        installedAt: it.SFTY_EMRGNCBLL_INSTL_YR || undefined,
        note: [it.INSTL_PLC_TYPE, it.LCTN_LOTNO_ADDR].filter(Boolean).join(" · "),
        source: "mois:emergency_call_box_info",
      }),
    );
  }
  metaSources.emergency_bell = { count: collections.emergency_bell.length, fetchedAt: new Date().toISOString().slice(0, 10) };
}

async function collectStores() {
  console.log("[편의점] 안전디딤돌 IF_0039 전국 스캔");
  const items = await fetchSafemap("IF_0039");
  for (const it of items) {
    const [lon, lat] = mercatorToWgs84(Number(it.x), Number(it.y));
    if (!inBbox(lon, lat)) continue;
    collections.convenience_store.push(
      feat(`store-${it.objt_id}`, "convenience_store", lon, lat, {
        name: it.fclty_nm || "편의점",
        installedAt: it.data_yr || undefined,
        note: it.rn_adres || it.adres || undefined,
        source: "safemap:IF_0039",
      }),
    );
  }
  metaSources.convenience_store = { count: collections.convenience_store.length, fetchedAt: new Date().toISOString().slice(0, 10) };
}

async function collectPolice(previousFeatures) {
  console.log("[경찰시설] 경찰청 지구대·파출소 / 치안센터 주소 수집");
  const rows = await fetchPoliceRows(MOIS_KEY);
  if (!rows.length) throw new Error("광주 동구 경찰시설이 0건입니다 — 주소 필터를 확인하세요.");
  const previous = new Map(previousFeatures
    .filter((f) => ["police_station", "police_center"].includes(f.properties.type))
    .map((f) => [f.properties.address, f.geometry.coordinates]));
  for (const { row, kind, source } of rows) {
    const address = normalizeAddress(row.주소);
    const type = kind === "center" ? "police_center" : "police_station";
    const geocoded = await geocodePolice(row, kind, KAKAO_KEY);
    if (!KAKAO_KEY) await sleep(1100);
    const coordinates = geocoded ?? previous.get(address);
    if (!coordinates || !inBbox(...coordinates)) {
      console.warn(`  위치 미확인 (지도 제외): ${policeName(row, kind)} / ${address}`);
      continue;
    }
    collections[type].push(feat(`police-${kind}-${row.연번}`, type, ...coordinates, {
      name: policeName(row, kind), address, note: address, source,
    }));
  }
  for (const type of ["police_station", "police_center"]) {
    metaSources[type] = { count: collections[type].length, addressCount: rows.filter(({ kind }) =>
      (kind === "center" ? "police_center" : "police_station") === type).length,
      dataAsOf: "2025-12-31", fetchedAt: new Date().toISOString().slice(0, 10) };
  }
}

async function main() {
  const started = new Date();
  if (want("cpted") && (!SAFEMAP_KEY || !VWORLD_KEY)) {
    throw new Error("CPTED 수집에는 SAFEMAP_SERVICE_KEY와 VWORLD_API_KEY가 필요합니다.");
  }

  // 부분 갱신: 기존 파일에서 유지할 타입을 보존
  const refreshedTypes = new Set();
  let keptFeatures = [];
  let keptMetaSources = {};
  if (existsSync(FEATURES_PATH)) {
    const prev = JSON.parse(readFileSync(FEATURES_PATH, "utf8"));
    keptFeatures = prev.features;
  }
  if (existsSync(META_PATH)) {
    keptMetaSources = JSON.parse(readFileSync(META_PATH, "utf8")).sources ?? {};
  }

  if (want("cctv")) { await collectCctv(); refreshedTypes.add("cctv"); }
  if (want("bell")) { await collectBells(); refreshedTypes.add("emergency_bell"); }
  if (want("store")) { await collectStores(); refreshedTypes.add("convenience_store"); }
  if (want("police")) {
    await collectPolice(keptFeatures);
    refreshedTypes.add("police_station");
    refreshedTypes.add("police_center");
  }
  if (want("cpted")) {
    console.log("[CPTED] 안전디딤돌 IF_0023 완료 사업지 → VWORLD 지오코딩");
    cptedCache = !process.argv.includes("--refresh-geocodes") && existsSync(CPTED_CACHE_PATH)
      ? JSON.parse(readFileSync(CPTED_CACHE_PATH, "utf8")) : {};
    const result = await collectCptedFeatures(await fetchSafemap("IF_0023", 100), {
      inBbox,
      geocode: async (address, type) => {
        await sleep(100);
        try {
          return await geocodeAddress(address, type, {
            key: VWORLD_KEY, domain: process.env.VWORLD_DOMAIN, getText: getWithRetry, cache: cptedCache,
          });
        } catch (error) {
          throw new Error(`CPTED 지오코딩: ${error.message}`);
        }
      },
    });
    collections.cpted = result.features;
    cptedMetadata = result.metadata;
    metaSources.cpted = { count: result.features.length, fetchedAt: result.metadata.fetchedAt,
      source: "safemap:IF_0023", geocoder: "vworld", metadata: "/data/cpted-meta.json" };
    console.log(`  ${result.features.length}건, 미검색 ${result.metadata.unresolvedCount}건, 미완료 제외 ${result.metadata.incomplete}건`);
    refreshedTypes.add("cpted");
  }
  if (want("security-lights") || want("streetlights")) {
    const { features, dataAsOf } = collectSecurityLights();
    collections.security_light = features;
    metaSources.security_light = { status: "ok", count: features.length, dataAsOf, source: "동구청 보안등 CSV" };
    delete keptMetaSources.streetlight;
    refreshedTypes.add("streetlight"); // 구 정적 데이터의 별칭도 함께 교체
    refreshedTypes.add("security_light");
  }
  if (want("road-lights") && (ROAD_LIGHT_KEY || only.includes("road-lights"))) {
    console.log("[가로등] odcloud 동구 가로등현황 수집");
    const result = await collectRoadLights(ROAD_LIGHT_KEY, getWithRetry);
    collections.road_light = result.features;
    metaSources.road_light = { status: "ok", count: result.features.length, sourceCount: result.total,
      invalid: result.invalid, dataAsOf: result.dataAsOf, fetchedAt: new Date().toISOString().slice(0, 10),
      source: "odcloud:15113447" };
    refreshedTypes.add("road_light");
  } else if (want("road-lights") && !ROAD_LIGHT_KEY) {
    console.warn("[가로등] ROAD_LIGHT_SERVICE_KEY 미설정 — 기존 가로등 자료 유지");
  }
  if (want("bus")) {
    console.log("[버스정류장] TAGO 광주 정류장 → 동구 및 주변 500m");
    const boundaries = JSON.parse(readFileSync(path.join(ROOT, "scripts/data/donggu-admin-boundaries.geojson"), "utf8")).features;
    const result = await fetchBusStops(TAGO_KEY, boundaries, keptFeatures, getWithRetry);
    collections.bus_stop = result.features;
    metaSources.bus_stop = { count: result.features.length, insideDonggu: result.insideCount,
      cityTotal: result.totalCount, fetchedAt: new Date().toISOString().slice(0, 10),
      source: "TAGO 버스정류소정보", nearbyMeters: 500 };
    refreshedTypes.add("bus_stop");
    console.log(`  동구 ${result.insideCount}개, 주변 포함 ${result.features.length}개`);
  }
  if (want("vacant") && (MOIS_KEY || only.includes("vacant"))) {
    console.log("[빈집] 공공데이터포털 광주 동구 빈집 현황");
    const { features, dataAsOf, total, excluded } = await collectVacantHouses(MOIS_KEY, getWithRetry);
    collections.vacant_house = features;
    metaSources.vacant_house = { count: features.length, sourceCount: total, excluded, dataAsOf,
      fetchedAt: new Date().toISOString().slice(0, 10), source: "odcloud:15144631", crs: "EPSG:5174" };
    refreshedTypes.add("vacant_house");
  } else if (want("vacant") && !MOIS_KEY) {
    console.warn("[빈집] MOIS_SERVICE_KEY 미설정 — 기존 빈집 자료 유지");
  }

  const newFeatures = [
    ...collections.cctv,
    ...collections.emergency_bell,
    ...collections.convenience_store,
    ...collections.police_station,
    ...collections.police_center,
    ...collections.bus_stop,
    ...collections.cpted,
    ...collections.vacant_house,
    ...collections.security_light,
    ...collections.road_light,
  ];
  const features = [...keptFeatures.filter((f) => !refreshedTypes.has(f.properties.type)), ...newFeatures];

  // 자가검사: 수집 건수, 좌표 범위 (이번 실행에서 새로 수집한 타입만)
  for (const [type, list] of Object.entries(collections)) {
    if (refreshedTypes.has(type) && list.length === 0) {
      throw new Error(`${type} 수집 결과가 0건입니다 — 필터나 소스를 확인하세요.`);
    }
  }
  const offMap = features
    .filter((f) => ["cctv", "emergency_bell", "convenience_store", "cpted", "police_station", "police_center"].includes(f.properties.type))
    .filter((f) => !inBbox(f.geometry.coordinates[0], f.geometry.coordinates[1]));
  if (offMap.length) throw new Error(`BBOX 밖 좌표 ${offMap.length}건 — 좌표 변환 오류 의심`);
  const offKorea = features.filter((f) => !inKorea(...f.geometry.coordinates));
  if (offKorea.length) throw new Error(`한국 범위 밖 좌표 ${offKorea.length}건 — 좌표 오류 의심`);

  mkdirSync(DATA_DIR, { recursive: true });
  const fc = { type: "FeatureCollection", features };
  writeFileSync(FEATURES_PATH, JSON.stringify(fc), "utf8");
  if (cptedMetadata) writeFileSync(path.join(DATA_DIR, "cpted-meta.json"), JSON.stringify(cptedMetadata, null, 2), "utf8");
  if (cptedCache) writeFileSync(CPTED_CACHE_PATH, JSON.stringify(cptedCache, null, 2), "utf8");
  writeFileSync(
    META_PATH,
    JSON.stringify(
      {
        generatedAt: started.toISOString().slice(0, 10),
        sources: { ...keptMetaSources, ...metaSources,
          road_segments: { source: "국토지리정보원 연속수치지형도", metadata: "/data/roads-meta.json" },
          sidewalks: { source: "국토지리정보원 연속수치지형도 보행로(인도)", metadata: "/data/sidewalks-meta.json" } },
        pending: {
          old_building: "안전디딤돌 IF_0002는 WMS 전용 — 건축물대장 API 연결 필요",
          ...(!features.some((f) => f.properties.type === "cpted")
            ? { cpted: "IF_0023 완료 사업지 — VWORLD_API_KEY 설정 후 --only=cpted 실행 필요" } : {}),
          risk_zones: "벡터 좌표 미공개 — 대신 public/data/crime-risk.json(safemap WMS 샘플링)으로 상대적 주의도 반영",
           ...(!features.some((f) => f.properties.type === "police_station")
             ? { police_station: "경찰청 주소 원본 수집 — 건물 단위 좌표 확인 필요" } : {}),
          night_activity: "야간 영업 POI(음식점·카페·약국·PC방·숙박 등) 좌표 수집 필요 — v2 activityScore 자동 반영",
          ...(!features.some((f) => f.properties.type === "vacant_house")
            ? { vacant_house: "MOIS_SERVICE_KEY 설정 후 --only=vacant 실행 필요" } : {}),
          ...(!features.some((f) => f.properties.type === "bus_stop")
            ? { transit: "버스정류장·지하철 출입구 좌표 수집 필요 — v2 activityScore(transit) 자동 반영" }
            : { subway_entrance: "지하철 출입구 좌표 수집 필요 — 현재 대중교통 접근성은 버스정류장만 반영" }),
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  execFileSync(process.execPath, ["--import", "tsx", "scripts/score-roads.ts", ...(only.length === 1 && only[0] === "vacant" ? ["--only=vacant"] : [])], {
    cwd: ROOT, stdio: "inherit",
  });

  const byType = {};
  for (const f of features) byType[f.properties.type] = (byType[f.properties.type] ?? 0) + 1;
  console.log("\n=== 완료 ===");
  console.log(JSON.stringify(byType));
  console.log(`저장: ${FEATURES_PATH} (${(JSON.stringify(fc).length / 1e6).toFixed(1)}MB)`);
  console.log(`소요: ${((Date.now() - started) / 1000).toFixed(0)}초`);
}

main().catch((e) => {
  console.error("실패:", e.message);
  process.exit(1);
});
