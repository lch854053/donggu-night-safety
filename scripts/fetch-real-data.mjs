#!/usr/bin/env node
// 광주 동구 밤길 안전 지도 실데이터 수집 스크립트
// 사용:
//   node scripts/fetch-real-data.mjs                      전체 갱신
//   node scripts/fetch-real-data.mjs --only=streetlights  보안등만 갱신 (기존 데이터 유지)
// 키는 .env.local (SAFEMAP_SERVICE_KEY, MOIS_SERVICE_KEY) 또는 환경변수로 전달합니다.
//
// 소스별 상태
//   보안등      동구청 제공 CSV (scripts/data/donggu-streetlights.csv)  연 1회 갱신(매년 말 기준) ✅
//   CCTV        행안부 cctv_info                WGS84 좌표 ✅
//   비상벨      행안부 emergency_call_box_info   WGS84 좌표 ✅
//   편의점      안전디딤돌 IF_0039               Web Mercator(3857) 좌표 ✅
//   CPTED      안전디딤돌 IF_0023               좌표 없음(지번주소만) → 지오코딩 전까지 수집 제외
//   노후건물/범죄주의구간  안전디딤돌 WMS 전용(좌표 미공개) → 좌표 API 확보 후 추가
//   도로 링크  국토지리정보원 도로중심선 → 시설 갱신 후 점수 자동 재계산
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "public", "data");
const FEATURES_PATH = path.join(DATA_DIR, "safety-features.geojson");
const META_PATH = path.join(DATA_DIR, "meta.json");
const STREETLIGHT_CSV = path.join(ROOT, "scripts", "data", "donggu-streetlights.csv");

// .env.local 파서 (dotenv 의존성 없이 최소 구현)
if (existsSync(path.join(ROOT, ".env.local"))) {
  for (const line of readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const SAFEMAP_KEY = process.env.SAFEMAP_SERVICE_KEY;
const MOIS_KEY = process.env.MOIS_SERVICE_KEY;

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice(7).split(",") : [];
const want = (source) => only.length === 0 || only.includes(source);
if (only.length && only.some((k) => !["cctv", "bell", "store", "streetlights"].includes(k))) {
  console.error("--only 값은 cctv, bell, store, streetlights 중에서 선택합니다.");
  process.exit(1);
}

// 광주 동구 중심부 + 주변 완충 구간. 도로는 동구 안이지만 인접 구 시설도 점수에 유효하므로 넉넉하게 잡음.
const BBOX = { minLon: 126.86, minLat: 35.08, maxLon: 127.03, maxLat: 35.22 };
const inBbox = (lon, lat) =>
  lon >= BBOX.minLon && lon <= BBOX.maxLon && lat >= BBOX.minLat && lat <= BBOX.maxLat;
const inKorea = (lon, lat) => lon > 124 && lon < 132 && lat > 33 && lat < 43;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWithRetry(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "donggu-night-safety/0.1" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1000 * (i + 1));
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
        `https://safemap.go.kr/openapi2/${ifId}?serviceKey=${SAFEMAP_KEY}&pageNo=${pageNo}&numOfRows=${pageSize}&type=json`,
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

function collectStreetlights() {
  console.log("[보안등] 동구청 CSV 읽기 (scripts/data/donggu-streetlights.csv)");
  const lines = readFileSync(STREETLIGHT_CSV, "utf8").replace(/^\ufeff/, "").trim().split(/\r?\n/);
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
      feat(`light-${c[col("보안등위치명")]}`, "streetlight", lon, lat, {
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

const collections = { cctv: [], emergency_bell: [], convenience_store: [] };
const metaSources = {};

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
  if (failed > pages * 0.05) throw new Error(`CCTV 실패율 과다: ${failed}/${pages}`);
  for (const it of items) {
    const lon = Number(it.WGS84_LOT), lat = Number(it.WGS84_LAT);
    if (!lon || !lat || !inBbox(lon, lat)) continue;
    collections.cctv.push(
      feat(`cctv-${it.MNG_NO}`, "cctv", lon, lat, {
        name: `${it.MNG_INST_NM} CCTV`,
        installedAt: it.INSTL_YM || undefined,
        note: [it.INSTL_PRPS_SE_NM, it.LCTN_LOTNO_ADDR].filter(Boolean).join(" · "),
        source: "mois:cctv_info",
      }),
    );
  }
  metaSources.cctv = { count: collections.cctv.length, fetchedAt: new Date().toISOString().slice(0, 10) };
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

async function main() {
  const started = new Date();

  // 부분 갱신: 기존 파일에서 유지할 타입을 보존
  const refreshedTypes = new Set();
  let keptFeatures = [];
  let keptMetaSources = {};
  if (only.length && existsSync(FEATURES_PATH)) {
    const prev = JSON.parse(readFileSync(FEATURES_PATH, "utf8"));
    keptFeatures = prev.features;
  }
  if (existsSync(META_PATH)) {
    keptMetaSources = JSON.parse(readFileSync(META_PATH, "utf8")).sources ?? {};
  }

  if (want("cctv")) { await collectCctv(); refreshedTypes.add("cctv"); }
  if (want("bell")) { await collectBells(); refreshedTypes.add("emergency_bell"); }
  if (want("store")) { await collectStores(); refreshedTypes.add("convenience_store"); }
  if (want("streetlights")) {
    const { features, dataAsOf } = collectStreetlights();
    collections.streetlight = features;
    metaSources.streetlight = { count: features.length, dataAsOf };
    refreshedTypes.add("streetlight");
  }

  const newFeatures = [
    ...collections.cctv,
    ...collections.emergency_bell,
    ...collections.convenience_store,
    ...(collections.streetlight ?? []),
  ];
  const features = [...keptFeatures.filter((f) => !refreshedTypes.has(f.properties.type)), ...newFeatures];

  // 자가검사: 수집 건수, 좌표 범위 (이번 실행에서 새로 수집한 타입만)
  for (const [type, list] of Object.entries(collections)) {
    if (refreshedTypes.has(type) && list.length === 0) {
      throw new Error(`${type} 수집 결과가 0건입니다 — 필터나 소스를 확인하세요.`);
    }
  }
  const offMap = features
    .filter((f) => ["cctv", "emergency_bell", "convenience_store"].includes(f.properties.type))
    .filter((f) => !inBbox(f.geometry.coordinates[0], f.geometry.coordinates[1]));
  if (offMap.length) throw new Error(`BBOX 밖 좌표 ${offMap.length}건 — 좌표 변환 오류 의심`);
  const offKorea = features.filter((f) => !inKorea(...f.geometry.coordinates));
  if (offKorea.length) throw new Error(`한국 범위 밖 좌표 ${offKorea.length}건 — 좌표 오류 의심`);

  mkdirSync(DATA_DIR, { recursive: true });
  const fc = { type: "FeatureCollection", features };
  writeFileSync(FEATURES_PATH, JSON.stringify(fc), "utf8");
  writeFileSync(
    META_PATH,
    JSON.stringify(
      {
        generatedAt: started.toISOString().slice(0, 10),
        sources: { ...keptMetaSources, ...metaSources,
          road_segments: { source: "국토지리정보원 연속수치지형도", metadata: "/data/roads-meta.json" } },
        pending: {
          old_building: "안전디딤돌 IF_0002는 WMS 전용 — 건축물대장 API 연결 필요",
          cpted: "IF_0023에 좌표 없음 — 지오코딩 연결 후 수집",
          risk_zones: "좌표 공개 소스 없음 — 미수집, 점수 감점 미적용",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  execFileSync(process.execPath, ["--import", "tsx", "scripts/score-roads.ts"], {
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
