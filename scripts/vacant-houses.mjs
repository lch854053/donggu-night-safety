import proj4 from "proj4";
import { readFileSync } from "node:fs";

// 원본의 '위도(X)'·'경도(Y)'는 각도가 아니라 구 한국측지계 중부원점 TM (EPSG:5174) 미터 좌표다.
// 주소 기반 필지와 대조하면 EPSG:5181로 해석할 경우 대부분 약 320m 남쪽에 표시된다.
const TM_5174 = "+proj=tmerc +lat_0=38 +lon_0=127.002890277778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +towgs84=-145.907,505.034,685.756,-1.162,2.347,1.592,6.342 +units=m +no_defs";
const review = JSON.parse(readFileSync(new URL("./data/vacant-coordinate-review.json", import.meta.url), "utf8"));
const ENDPOINT = "https://api.odcloud.kr/api/15144631/v1/uddi:4b08ea19-5d8e-4050-99a6-bf6905c56b06";

export function vacantHouseFeature(row, index) {
  const x = Number(row["위도"]), y = Number(row["경도"]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 150000 || x > 250000 || y < 140000 || y > 240000) return null;
  const key = `${x},${y}`;
  // 일부 원본 좌표는 두 좌표계 어느 쪽으로 해석해도 주소와 맞지 않는다.
  // 필지 PNU와 지번이 일치하는 경우만 필지 대표점으로 대체하고, 나머지는 제외한다.
  if (review.unverified.includes(key)) return null;
  const [lon, lat] = review.parcelCenters[key] ?? proj4(TM_5174, "WGS84", [x, y]);
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
  const encountered = new Set();
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
      encountered.add(`${Number(row["위도"])},${Number(row["경도"])}`);
      const feature = vacantHouseFeature(row, (page - 1) * 1000 + index + 1);
      if (feature) features.push(feature);
    }
  }
  const excluded = total - features.length;
  if (!features.length || excluded !== review.unverified.filter((key) => encountered.has(key)).length) {
    throw new Error(`빈집 좌표 검증 실패: 전체 ${total}건 중 ${features.length}건 (검증되지 않은 좌표만 제외 가능)`);
  }
  return { features, dataAsOf, total, excluded };
}
