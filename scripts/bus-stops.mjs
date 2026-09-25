import { booleanPointInPolygon, buffer } from "@turf/turf";

const ENDPOINT = "https://apis.data.go.kr/1613000/BusSttnInfoInqireService/getSttnNoList";

export function buildBusStops(rows, boundaries, previous = []) {
  if (!Array.isArray(rows) || rows.length < 1000) throw new Error("TAGO 광주 정류장 목록이 불완전합니다.");
  const nearby = boundaries.map((boundary) => buffer(boundary, 0.5, { units: "kilometers" }));
  const old = new Map(previous.filter((f) => f.properties.type === "bus_stop")
    .map((f) => [f.properties.id, f.properties]));
  const seen = new Set();
  const features = [];
  let insideCount = 0;
  for (const row of rows) {
    const id = String(row.nodeid ?? "");
    const lat = Number(row.gpslati), lon = Number(row.gpslong);
    if (!/^KJB\d+$/.test(id) || !Number.isFinite(lat) || !Number.isFinite(lon)
      || lat < 33 || lat > 43 || lon < 124 || lon > 132) continue;
    if (seen.has(id)) throw new Error(`TAGO 중복 정류장 ID: ${id}`);
    seen.add(id);
    const point = [lon, lat];
    const inDonggu = boundaries.some((boundary) => booleanPointInPolygon(point, boundary));
    if (!inDonggu && !nearby.some((boundary) => booleanPointInPolygon(point, boundary))) continue;
    if (inDonggu) insideCount++;
    const previousProps = old.get(`bus-${id}`) ?? {};
    const { nightRidershipPeriod, nightWeekdayBoarding, nightWeekdayAlighting,
      nightWeekendBoarding, nightWeekendAlighting, ...rest } = previousProps;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [Number(lon.toFixed(6)), Number(lat.toFixed(6))] },
      properties: {
        ...rest, id: `bus-${id}`, type: "bus_stop", name: String(row.nodenm || "버스정류장"),
        source: "tago:BusSttnInfoInqireService", nodeId: id,
        ...(row.nodeno != null ? { arsNumber: String(row.nodeno) } : {}),
        inDonggu,
        ...(nightRidershipPeriod ? { nightRidershipPeriod, nightWeekdayBoarding,
          nightWeekdayAlighting, nightWeekendBoarding, nightWeekendAlighting } : {}),
      },
    });
  }
  if (insideCount < 100 || features.length < insideCount) {
    throw new Error(`TAGO 동구 정류장 ${insideCount}건 — 경계 또는 API 결과를 확인하세요.`);
  }
  return { features, insideCount };
}

export async function fetchBusStops(key, boundaries, previous = [], getText = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`TAGO HTTP ${response.status}`);
  return response.text();
}) {
  if (!key) throw new Error("TAGO_SERVICE_KEY가 필요합니다.");
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({ serviceKey: key, cityCode: "24", pageNo: "1", numOfRows: "5000", _type: "json" }).toString();
  const response = JSON.parse(await getText(url.toString()));
  if (response.response?.header?.resultCode !== "00") {
    throw new Error(`TAGO 정류장 응답 오류: ${response.response?.header?.resultMsg ?? "응답 형식 오류"}`);
  }
  const body = response.response.body;
  const rows = body?.items?.item;
  if (!Array.isArray(rows) || rows.length !== Number(body.totalCount)) {
    throw new Error("TAGO 정류장 페이지가 잘렸습니다 — 기존 데이터를 보존합니다.");
  }
  return { ...buildBusStops(rows, boundaries, previous), totalCount: rows.length };
}
