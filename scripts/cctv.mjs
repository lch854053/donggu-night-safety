import { booleanPointInPolygon } from "@turf/turf";
import { CCTV_PURPOSE_CONFIDENCE, CCTV_PURPOSE_LABELS, classifyCctvPurpose } from "../config/cctvPurpose.mjs";

export const CCTV_DATASET = "전남광주통합특별시_CCTV_20260630";
export const CCTV_APIS = {
  current: "15084631/v1/uddi:c4bde716-7f69-468c-a0d9-927fccc90868",
  historical: "15084631/v1/uddi:d8d440f9-3dc2-4a97-9586-aa3279e0eb10",
};

export async function fetchCctvSnapshot(path, key, request = fetch) {
  if (!key) throw new Error("MOIS_SERVICE_KEY가 필요합니다.");
  const rows = [];
  let total = Infinity;
  for (let page = 1; (page - 1) * 1000 < total; page++) {
    const url = new URL(`https://api.odcloud.kr/api/${path}`);
    for (const [name, value] of Object.entries({ page, perPage: 1000, serviceKey: key })) {
      url.searchParams.set(name, String(value));
    }
    const response = await request(url);
    if (!response.ok) throw new Error(`CCTV API HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body.data) || !Number.isInteger(body.totalCount) || body.totalCount <= 0 || !body.data.length) {
      throw new Error("CCTV API 응답 형식이 예상과 다릅니다.");
    }
    total = body.totalCount;
    rows.push(...body.data);
  }
  if (!rows.length || rows.length !== total) {
    throw new Error(`CCTV API 수집 누락: ${rows.length}/${total}건 — 기존 데이터 보존`);
  }
  return rows;
}

export const normalizeCctvAddress = (value) => String(value ?? "").trim()
  .replace(/^광주광역시\s*|^전남광주통합특별시\s*/, "")
  .replace(/\s+/g, "");

function district(address) {
  const raw = String(address ?? "").trim();
  if (/^[가-힣]+(?:광역시|특별시|자치시|특별자치도|도)\s/.test(raw) &&
      !/^(광주광역시|전남광주통합특별시)\s/.test(raw)) return "타시도";
  const text = raw.replace(/^광주광역시\s*|^전남광주통합특별시\s*/, "");
  return text.match(/^([^\s]+구)\s/)?.[1] ?? null;
}

function distanceMeters(a, b) {
  const dy = (a[1] - b[1]) * 111195;
  const dx = (a[0] - b[0]) * 111195 * Math.cos((a[1] + b[1]) * Math.PI / 360);
  return Math.hypot(dx, dy);
}

function historicalPurposes(rows) {
  const byAddress = new Map();
  for (const row of rows) {
    for (const address of [row.소재지도로명주소, row.소재지지번주소]) {
      if (!address) continue;
      const key = normalizeCctvAddress(address);
      if (!byAddress.has(key)) byAddress.set(key, new Set());
      byAddress.get(key).add(classifyCctvPurpose(row.설치목적구분));
    }
  }
  return byAddress;
}

export function buildMunicipalCctv(rows, historicalRows, boundaries, legacyFeatures = []) {
  if (!rows.length || !boundaries.length) throw new Error("CCTV 원본 또는 동구 행정경계가 비었습니다.");
  const history = historicalPurposes(historicalRows);
  const stats = {
    sourceDataset: CCTV_DATASET, sourceRows: rows.length, validCoordinateRows: 0,
    addressDongguRows: 0, uniqueLocations: 0, includedLocations: 0,
    excludedInvalidCoordinate: 0, excludedOutsideBoundary: 0,
    excludedAddressCoordinateMismatch: 0, excludedDuplicateRows: 0,
    excludedLegacyOverlaps: 0, historicalPurposeMatches: 0,
    purposeCounts: { crime_prevention: 0, child_safety: 0, waste: 0, traffic: 0, unknown: 0, other: 0 },
  };
  const sites = [];
  const byCoordinate = new Map();
  for (const row of rows) {
    const lon = Number(row.경도), lat = Number(row.위도);
    if (row.경도 == null || row.위도 == null || !Number.isFinite(lon) || !Number.isFinite(lat) ||
        lon < 124 || lon > 132 || lat < 33 || lat > 43) {
      stats.excludedInvalidCoordinate++;
      continue;
    }
    stats.validCoordinateRows++;
    const addresses = [row.소재지도로명주소, row.소재지지번주소].filter(Boolean);
    const districts = [...new Set(addresses.map(district).filter(Boolean))];
    const saysDonggu = districts.includes("동구");
    if (saysDonggu) stats.addressDongguRows++;
    const inside = boundaries.some((boundary) => booleanPointInPolygon([lon, lat], boundary));
    if (districts.length && (!inside && saysDonggu || inside && districts.some((value) => value !== "동구"))) {
      stats.excludedAddressCoordinateMismatch++;
      continue;
    }
    if (!inside) { stats.excludedOutsideBoundary++; continue; }
    if (districts.length && !saysDonggu) { stats.excludedAddressCoordinateMismatch++; continue; }

    const coordinates = [lon, lat];
    const address = row.소재지도로명주소 || row.소재지지번주소 || "";
    const normalized = normalizeCctvAddress(address);
    const exact = coordinates.join(",");
    let site = byCoordinate.get(exact);
    if (!site && normalized) {
      site = sites.find((candidate) => candidate.normalized === normalized &&
        distanceMeters(candidate.coordinates, coordinates) <= 3);
    }
    if (site) {
      site.rows.push(row);
      stats.excludedDuplicateRows++;
    } else {
      site = { coordinates, normalized, address, rows: [row] };
      sites.push(site);
    }
    byCoordinate.set(exact, site);
  }
  stats.uniqueLocations = sites.length;
  if (!sites.length) throw new Error("동구 CCTV 위치가 0건입니다 — 수집 결과를 보존하지 않습니다.");

  const features = sites.map((site) => {
    const purposes = new Set();
    for (const row of site.rows) {
      for (const address of [row.소재지도로명주소, row.소재지지번주소]) {
        for (const value of history.get(normalizeCctvAddress(address)) ?? []) purposes.add(value);
      }
    }
    let purpose = purposes.size === 1 ? [...purposes][0] : "unknown";
    let purposeSource = purpose !== "unknown" ? "historical" : undefined;
    if (purposes.size === 0) {
      const addressKeys = new Set(site.rows.flatMap((row) =>
        [row.소재지도로명주소, row.소재지지번주소].filter(Boolean).map(normalizeCctvAddress)));
      const nearby = legacyFeatures.filter((feature) => feature.properties.address &&
        addressKeys.has(normalizeCctvAddress(feature.properties.address)) &&
        distanceMeters(feature.geometry.coordinates, site.coordinates) <= 5);
      const nearbyPurposes = new Set(nearby.map((feature) => feature.properties.purpose).filter(Boolean));
      if (nearbyPurposes.size === 1) {
        purpose = [...nearbyPurposes][0];
        purposeSource = "current";
      }
    }
    if (purposeSource === "historical") stats.historicalPurposeMatches++;
    stats.purposeCounts[purpose]++;
    const [lon, lat] = site.coordinates;
    return { type: "Feature", geometry: { type: "Point", coordinates: [+lon.toFixed(6), +lat.toFixed(6)] },
      properties: {
        id: `cctv-municipal-${lon.toFixed(6)}-${lat.toFixed(6)}`,
        type: "cctv", name: "CCTV", source: `odcloud:${CCTV_APIS.current}`,
        address: site.address, note: site.address,
        purpose, purposeLabel: CCTV_PURPOSE_LABELS[purpose], confidence: CCTV_PURPOSE_CONFIDENCE[purpose],
        cameraCount: site.rows.reduce((sum, row) => sum + (Number(row.카메라대수) || 0), 0),
        sourceYear: 2026, sourceDataset: CCTV_DATASET,
        ...(purposeSource ? { purposeSource } : {}),
      } };
  });
  stats.includedLocations = features.length;
  const retainedLegacy = legacyFeatures.filter((feature) => {
    if (features.some((item) => distanceMeters(item.geometry.coordinates, feature.geometry.coordinates) <= 3)) {
      stats.excludedLegacyOverlaps++;
      return false;
    }
    return true;
  });
  return { features: [...retainedLegacy, ...features], stats };
}
