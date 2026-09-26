// 동구 가로등현황: 여러 관리번호가 같은 대표 좌표·주소를 공유한다. 개별 등주 Point가 아니다.
const ENDPOINT = "https://api.odcloud.kr/api/15113447/v1/uddi:6aec4d77-1e0e-4757-9af7-888d0257e427";
const PAGE_SIZE = 1000;

/** 고유 관리번호별 관리대상을 prefix 단위로 묶는다. 좌표는 개별 설치 위치가 아니다. */
export function normalizeRoadLightClusters(rows) {
  const clusters = new Map();
  const ids = new Map();
  let invalid = 0;
  for (const row of rows) {
    const lon = Number(row["경도"]), lat = Number(row["위도"]);
    const id = String(row["관리번호"] || "").trim();
    if (!row["경도"] || !row["위도"] || !Number.isFinite(lon) || !Number.isFinite(lat) ||
        lon < 126.86 || lon > 127.03 || lat < 35.07 || lat > 35.22 || !/^(.*)-\d+$/.test(id)) {
      invalid++; continue;
    }
    const clusterId = id.replace(/-\d+$/, "");
    const representativeCoordinate = [+lon.toFixed(6), +lat.toFixed(6)];
    const coordKey = representativeCoordinate.join(",");
    const roadAddress = String(row["소재지도로명주소"] || "").trim();
    const parcelAddress = String(row["소재지지번주소"] || "").trim();
    const asOf = String(row["데이터기준일자"] || "").trim();
    const signature = JSON.stringify([coordKey, roadAddress, parcelAddress, asOf]);
    if (ids.has(id)) {
      if (ids.get(id) !== signature) throw new Error(`관리번호 ${id} 속성 충돌 — 기존 자료 유지`);
      continue;
    }
    ids.set(id, signature);
    const cluster = clusters.get(clusterId) ?? {
      clusterId, managedUnitCount: 0, representativeCoordinate,
      roadAddresses: new Set(), parcelAddresses: new Set(), dataAsOf: "",
      roadAddressManagedUnitCount: 0, parcelAddressManagedUnitCount: 0,
    };
    if (cluster.representativeCoordinate.join(",") !== coordKey) {
      throw new Error(`관리그룹 ${clusterId} 대표좌표 충돌 — 기존 자료 유지`);
    }
    cluster.managedUnitCount++;
    if (roadAddress) { cluster.roadAddresses.add(roadAddress); cluster.roadAddressManagedUnitCount++; }
    if (parcelAddress) { cluster.parcelAddresses.add(parcelAddress); cluster.parcelAddressManagedUnitCount++; }
    if (asOf > cluster.dataAsOf) cluster.dataAsOf = asOf;
    clusters.set(clusterId, cluster);
  }
  const normalized = [...clusters.values()].map((c) => ({ ...c,
    roadAddresses: [...c.roadAddresses], parcelAddresses: [...c.parcelAddresses] }));
  // 우연히 같은 좌표를 사용하는 서로 다른 관리그룹도 하나의 관리대상으로 합치지 않는다.
  return { clusters: normalized, invalid, uniqueManagedUnitCount: ids.size };
}

export async function collectRoadLights(key, getText) {
  if (!key) throw new Error("ROAD_LIGHT_SERVICE_KEY가 필요합니다.");
  const rows = [];
  let total = null;
  for (let page = 1; total === null || (page - 1) * PAGE_SIZE < total; page++) {
    const url = new URL(ENDPOINT);
    url.searchParams.set("page", String(page));
    url.searchParams.set("perPage", String(PAGE_SIZE));
    url.searchParams.set("serviceKey", key);
    const body = JSON.parse(await getText(url.toString()));
    if (!Number.isInteger(body.matchCount) || !Array.isArray(body.data) ||
        body.matchCount < 1 || body.data.length !== Math.min(PAGE_SIZE, body.matchCount - (page - 1) * PAGE_SIZE)) {
      throw new Error("가로등 API 페이지 누락 또는 응답 형식 오류 — 기존 자료 유지");
    }
    if (total !== null && body.matchCount !== total) throw new Error("가로등 API 총 건수 변경 — 기존 자료 유지");
    total = body.matchCount;
    rows.push(...body.data);
  }
  const { clusters, invalid, uniqueManagedUnitCount } = normalizeRoadLightClusters(rows);
  const dataAsOf = clusters.reduce((latest, cluster) => cluster.dataAsOf > latest ? cluster.dataAsOf : latest, "");
  if (!clusters.length || !dataAsOf) throw new Error("가로등 좌표 또는 기준일자 없음 — 기존 자료 유지");
  return { clusters, total, invalid, uniqueManagedUnitCount, dataAsOf };
}
