// 수집 스크립트 공통 설정. 여러 스크립트가 같은 BBOX를 따로 정의하지 않게 여기서만 관리한다.
// 광주 동구 중심부 + 주변 완충 구간. 도로는 동구 안이지만 인접 구 시설도 점수에 유효하므로 넉넉하게 잡음.
export const DONGGU_BBOX = { minLon: 126.86, minLat: 35.08, maxLon: 127.03, maxLat: 35.22 };

export const inBbox = (lon, lat) =>
  lon >= DONGGU_BBOX.minLon && lon <= DONGGU_BBOX.maxLon && lat >= DONGGU_BBOX.minLat && lat <= DONGGU_BBOX.maxLat;

export const overpassBbox = () =>
  `${DONGGU_BBOX.minLat},${DONGGU_BBOX.minLon},${DONGGU_BBOX.maxLat},${DONGGU_BBOX.maxLon}`;
