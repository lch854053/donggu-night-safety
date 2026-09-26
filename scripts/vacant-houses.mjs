import proj4 from "proj4";

// 원본의 '위도(X)'·'경도(Y)'는 각도가 아니라 중부원점 GRS80 TM (EPSG:5181) 미터 좌표다.
const KATEC = "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +units=m +no_defs";
const ENDPOINT = "https://api.odcloud.kr/api/15144631/v1/uddi:4b08ea19-5d8e-4050-99a6-bf6905c56b06";

export function vacantHouseFeature(row, index) {
  const x = Number(row["위도"]), y = Number(row["경도"]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 150000 || x > 250000 || y < 140000 || y > 240000) return null;
  const [lon, lat] = proj4(KATEC, "WGS84", [x, y]);
  if (lon < 126.86 || lon > 127.03 || lat < 35.08 || lat > 35.22) return null;
  return {
    type: "Feature",
    properties: {
      id: `vacant-${index}`,
      type: "vacant_house",
      name: `${row["읍면동명"] || "동구"} 빈집`,
      source: "odcloud:15144631",
      note: [row["주택유형"], row["등급판정결과"]].filter(Boolean).join(" · "),
    },
    geometry: { type: "Point", coordinates: [+lon.toFixed(6), +lat.toFixed(6)] },
  };
}

export async function collectVacantHouses(key, getText) {
  if (!key) throw new Error("빈집 수집에는 MOIS_SERVICE_KEY가 필요합니다.");
  const features = [];
  let total = null;
  let dataAsOf = "";
  for (let page = 1; total === null || (page - 1) * 1000 < total; page++) {
    const url = new URL(ENDPOINT);
    url.searchParams.set("page", String(page));
    url.searchParams.set("perPage", "1000");
    url.searchParams.set("serviceKey", key);
    const body = JSON.parse(await getText(url.toString()));
    if (!Array.isArray(body.data) || !Number.isInteger(body.matchCount)) throw new Error("빈집 API 응답 형식 오류");
    total = body.matchCount;
    if (!body.data.length && features.length < total) throw new Error("빈집 API 페이지가 비어 있습니다.");
    for (const [index, row] of body.data.entries()) {
      dataAsOf = [dataAsOf, row["데이터기준일자"] || ""].sort().at(-1);
      const feature = vacantHouseFeature(row, (page - 1) * 1000 + index + 1);
      if (feature) features.push(feature);
    }
  }
  if (!features.length || features.length !== total) {
    throw new Error(`빈집 좌표 검증 실패: 전체 ${total}건 중 ${features.length}건 (데이터 누락·좌표계 확인 필요)`);
  }
  return { features, dataAsOf, total };
}
