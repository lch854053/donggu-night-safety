// 동구 가로등현황: 여러 관리번호가 같은 대표 좌표·주소를 공유한다. 개별 등주 Point가 아니다.
const ENDPOINT = "https://api.odcloud.kr/api/15113447/v1/uddi:6aec4d77-1e0e-4757-9af7-888d0257e427";
const PAGE_SIZE = 1000;

export async function collectRoadLights(key, getText) {
  if (!key) throw new Error("ROAD_LIGHT_SERVICE_KEY가 필요합니다.");
  const groups = new Map();
  const ids = new Set();
  let total = null;
  let dataAsOf = "";
  let invalid = 0;
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
    for (const row of body.data) {
      const lon = Number(row["경도"]), lat = Number(row["위도"]);
      if (!row["경도"] || !row["위도"] || !Number.isFinite(lon) || !Number.isFinite(lat) ||
          lon < 126.86 || lon > 127.03 || lat < 35.07 || lat > 35.22) { invalid++; continue; }
      const id = String(row["관리번호"] || "").trim();
      if (!id) { invalid++; continue; }
      const coordinate = [lon.toFixed(6), lat.toFixed(6)].join(",");
      if (ids.has(id)) continue;
      ids.add(id);
      const asOf = String(row["데이터기준일자"] || "").trim();
      if (asOf > dataAsOf) dataAsOf = asOf;
      const roadAddress = String(row["소재지도로명주소"] || "").trim();
      const parcelAddress = String(row["소재지지번주소"] || "").trim();
      const group = groups.get(coordinate) ?? {
        representativeCoordinates: [+lon.toFixed(6), +lat.toFixed(6)],
        recordCount: 0, roadAddresses: new Set(), parcelAddresses: new Set(), prefixes: new Set(),
      };
      group.recordCount++;
      if (roadAddress) group.roadAddresses.add(roadAddress);
      if (parcelAddress) group.parcelAddresses.add(parcelAddress);
      group.prefixes.add(id.replace(/-\d+$/, ""));
      groups.set(coordinate, group);
    }
  }
  if (!groups.size || !dataAsOf) throw new Error("가로등 좌표 또는 기준일자 없음 — 기존 자료 유지");
  return { groups: [...groups.values()].map((g) => ({
    representativeCoordinates: g.representativeCoordinates, recordCount: g.recordCount,
    roadAddresses: [...g.roadAddresses], parcelAddresses: [...g.parcelAddresses],
    managementPrefixes: [...g.prefixes],
  })), total, invalid, dataAsOf };
}
