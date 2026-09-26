// 2024-04-15 동구 가로등현황. 개별 관리번호 여러 건이 한 대표 좌표를 공유한다.
const ENDPOINT = "https://api.odcloud.kr/api/15113447/v1/uddi:6aec4d77-1e0e-4757-9af7-888d0257e427";
const PAGE_SIZE = 1000;

export async function collectRoadLights(key, getText) {
  if (!key) throw new Error("ROAD_LIGHT_SERVICE_KEY가 필요합니다.");
  const features = [];
  const coordinates = new Set();
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
      if (ids.has(id) || coordinates.has(coordinate)) continue;
      ids.add(id);
      coordinates.add(coordinate);
      const asOf = String(row["데이터기준일자"] || "").trim();
      if (asOf > dataAsOf) dataAsOf = asOf;
      const roadName = String(row["소재지도로명주소"] || "").trim();
      features.push({
        type: "Feature",
        properties: {
          id: `road-light-${coordinate.replace(",", "-")}`, type: "road_light", name: roadName || "가로등 위치",
          source: "odcloud:15113447", ...(roadName ? { roadName } : {}),
          ...(asOf ? { dataAsOf: asOf } : {}),
        },
        geometry: { type: "Point", coordinates: [+lon.toFixed(6), +lat.toFixed(6)] },
      });
    }
  }
  if (!features.length || !dataAsOf) throw new Error("가로등 좌표 또는 기준일자 없음 — 기존 자료 유지");
  return { features, total, invalid, dataAsOf };
}
