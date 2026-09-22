import { createHash } from "node:crypto";

const normalizeAddress = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
const isGwangju = (address) => /^(광주광역시|광주시|광주)\s+(동구|서구|남구|북구|광산구)\s/.test(address);
const validCoordinates = (value) => Array.isArray(value) && value.length === 2 &&
  value.every(Number.isFinite) && value[0] >= 124 && value[0] <= 132 && value[1] >= 33 && value[1] <= 43;

/** VWORLD 오류/인증 실패를 주소 미검색과 구분한다. 요청 URL에는 키가 있어 로그에 남기지 않는다. */
export async function geocodeAddress(address, type, { key, domain, getText, cache }) {
  if (!key) throw new Error("VWORLD_API_KEY가 필요합니다.");
  const cacheKey = `${type}:${address}`;
  const cached = cache?.[cacheKey];
  if (cached?.crs === "EPSG:4326" && validCoordinates(cached.coordinates)) return [...cached.coordinates];
  // 미검색도 일시 캐시하되 영구 누락으로 굳어지지 않도록 90일 뒤 재조회한다.
  const age = Date.now() - Date.parse(cached?.geocodedAt);
  if (cached?.status === "NOT_FOUND" && age >= 0 && age < 90 * 86400000) return null;
  const url = new URL("https://api.vworld.kr/req/address");
  url.search = new URLSearchParams({
    service: "address", request: "getCoord", version: "2.0", crs: "EPSG:4326",
    address, type, format: "json", refine: "true", simple: "false", key,
    ...(domain ? { domain } : {}),
  });
  const { response } = JSON.parse(await getText(url));
  if (response?.status === "NOT_FOUND") {
    if (cache) cache[cacheKey] = { status: "NOT_FOUND", geocodedAt: new Date().toISOString().slice(0, 10) };
    return null;
  }
  if (response?.status !== "OK") {
    throw new Error(`VWORLD 지오코딩 실패 (${response?.error?.code ?? "INVALID_RESPONSE"})`);
  }
  const point = response.result?.point;
  const lon = Number(point?.x), lat = Number(point?.y);
  if (!point?.x || !point?.y || !validCoordinates([lon, lat])) {
    throw new Error("VWORLD 응답 좌표가 올바르지 않습니다.");
  }
  if (cache) cache[cacheKey] = { coordinates: [lon, lat], crs: "EPSG:4326", geocodedAt: new Date().toISOString().slice(0, 10) };
  return [lon, lat];
}

/** IF_0023은 사업지 주소 데이터다. 완료 사업만 주소 대표점으로 수집한다. */
export async function collectCptedFeatures(items, { geocode, inBbox }) {
  const features = [], unresolved = [], seen = new Set(), cache = new Map();
  const counts = { sourceRows: items.length, regionalRows: 0, incomplete: 0, duplicates: 0, outsideBbox: 0 };
  for (const item of items) {
    const parcel = normalizeAddress(item.jibun_addr);
    const road = normalizeAddress(item.roadnm_add);
    if (!isGwangju(parcel) && !isGwangju(road)) continue;
    counts.regionalRows++;
    if (String(item.imprvm_pro ?? "").trim() !== "완료") { counts.incomplete++; continue; }
    const address = parcel || road;
    // 같은 주소의 중복 사업이 시설 개수 가점으로 중복 반영되지 않도록 한다.
    if (seen.has(address)) { counts.duplicates++; continue; }
    seen.add(address);
    let coordinates = null, matchedAddress, addressType;
    for (const [candidate, type] of [[parcel, "parcel"], [road, "road"]]) {
      if (!candidate || !isGwangju(candidate)) continue;
      const cacheKey = `${type}:${candidate}`;
      if (!cache.has(cacheKey)) cache.set(cacheKey, await geocode(candidate, type));
      coordinates = cache.get(cacheKey);
      if (coordinates) { matchedAddress = candidate; addressType = type; break; }
    }
    if (!coordinates) { unresolved.push({ address, reason: "NOT_FOUND" }); continue; }
    if (!inBbox(...coordinates)) { counts.outsideBbox++; continue; }
    const id = createHash("sha256").update(address).digest("hex").slice(0, 16);
    features.push({
      type: "Feature",
      properties: {
        id: `cpted-${id}`, type: "cpted", name: "CPTED 환경개선 사업지",
        source: "safemap:IF_0023", address, status: "완료",
        geocoder: "vworld", geocodedAddress: matchedAddress, addressType,
        locationAccuracy: "address",
        note: [item.dsign_prps, item.usr_cmnt, address, "VWORLD 주소 대표점(사업구역 경계·개별 시설 위치 아님)"].filter(Boolean).join(" · "),
      },
      geometry: { type: "Point", coordinates: coordinates.map((n) => +n.toFixed(6)) },
    });
  }
  if (!features.length) throw new Error("CPTED 수집 결과가 0건입니다 — 주소·사업 상태·지오코딩을 확인하세요.");
  return {
    features,
    metadata: {
      source: "safemap:IF_0023", geocoder: "VWORLD Geocoder API 2.0", crs: "EPSG:4326",
      fetchedAt: new Date().toISOString().slice(0, 10), count: features.length,
      ...counts, unresolvedCount: unresolved.length, unresolved,
      note: "광주광역시 완료 사업을 지오코딩한 뒤 동구권 BBOX로 필터링. 주소 대표점이며 사업구역 경계나 개별 설치시설의 실측 좌표가 아님. 계획·진행 중 사업 제외.",
    },
  };
}
