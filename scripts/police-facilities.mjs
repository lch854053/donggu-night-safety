// 경찰청 주소 데이터에는 좌표가 없습니다. 건물 단위로 확인된 주소만 지도에 표시합니다.
export const POLICE_APIS = [
  { path: "15077036/v1/uddi:6b371c66-09a5-4efd-8445-bfd53672542e", kind: "station" },
  { path: "15076962/v1/uddi:496cadf8-cb37-478a-81b4-efbbe881c819", kind: "center" },
];

export const isDongguPolice = (row) =>
  row.시도청 === "광주청" && /^광주(?:광역시)?\s+동구\s/.test(row.주소?.trim() ?? "");

export const policeName = (row, kind) => kind === "center"
  ? row.치안센터명
  : `${row.관서명}${row.구분}`;

export const normalizeAddress = (address) => address.trim().replace(/\s+/g, " ").replace(/([가-힣]+로)\s+(\d+)\s*번길/g, "$1$2번길");

export async function fetchPoliceRows(key, request = fetch) {
  if (!key) throw new Error("MOIS_SERVICE_KEY가 필요합니다.");
  const results = [];
  for (const api of POLICE_APIS) {
    let page = 1;
    let total = Infinity;
    while ((page - 1) * 500 < total) {
      const url = new URL(`https://api.odcloud.kr/api/${api.path}`);
      url.searchParams.set("page", String(page));
      url.searchParams.set("perPage", "500");
      url.searchParams.set("serviceKey", key);
      const response = await request(url);
      if (!response.ok) throw new Error(`경찰청 ${api.kind} API: HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body.data) || !Number.isFinite(body.totalCount) || body.data.length === 0) {
        throw new Error(`경찰청 ${api.kind} API 응답 형식이 예상과 다릅니다.`);
      }
      total = body.totalCount;
      results.push(...body.data.filter(isDongguPolice).map((row) => ({ row, kind: api.kind, source: `odcloud:${api.path}` })));
      page++;
    }
  }
  return results;
}

export async function geocodePolice(row, kind, kakaoKey, request = fetch) {
  const address = normalizeAddress(row.주소);
  if (kakaoKey) {
    const url = new URL("https://dapi.kakao.com/v2/local/search/address.json");
    url.searchParams.set("query", address);
    const response = await request(url, { headers: { Authorization: `KakaoAK ${kakaoKey}` } });
    if (!response.ok) throw new Error(`카카오 주소 검색: HTTP ${response.status}`);
    const body = await response.json();
    const requestedNumber = address.match(/(\d+)(?:-(\d+))?$/);
    const match = body.documents?.find((item) => item.road_address?.region_2depth_name === "동구" &&
      item.road_address.region_1depth_name?.includes("광주") &&
      item.road_address.main_building_no === requestedNumber?.[1] &&
      (item.road_address.sub_building_no || "") === (requestedNumber?.[2] || "") &&
      address.includes(item.road_address.road_name));
    return match ? [Number(match.x), Number(match.y)] : null;
  }

  // 공개 OSM에서는 도로 중심점을 반환하기도 하므로 경찰 시설 POI + 번지 일치만 사용.
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", address);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "5");
  const response = await request(url, { headers: { "User-Agent": "donggu-night-safety/0.1 (https://github.com/lch854053/donggu-night-safety)" } });
  if (!response.ok) throw new Error(`OSM 주소 검색: HTTP ${response.status}`);
  const results = await response.json();
  const number = address.match(/(\d+(?:-\d+)?)$/)?.[1];
  const match = results.find((item) => item.type === "police" &&
    item.display_name?.includes("동구") && item.display_name?.includes(number ? `${number},` : "~~~") &&
    item.display_name?.includes(kind === "center" ? row.치안센터명 : row.관서명));
  return match ? [Number(match.lon), Number(match.lat)] : null;
}
