# 광주 동구 밤길 안심지도

광주 동구의 안심 인프라와 주변 환경을 조합해 도로별 상대적 밤길 안전 참고지수를 보여주는 MVP입니다. 보안등·CCTV·비상벨·편의점은 공공데이터 실측 자료, 야간 운영시설은 OpenStreetMap 영업시간 기반, 범죄 상대적 주의도는 생활안전지도(경찰청 밀도분석) WMS 사전 샘플링 결과이고, 도로와 인도는 국토지리정보원 연속수치지형도에서 동구 경계로 추출한 **10,660개 구간(약 356km)** 기준입니다. 가상의 샘플을 운영 점수에 반영하지 않습니다.

## 데이터 갱신

**자동(기본)**: CCTV·비상벨·편의점은 GitHub Actions가 **매월 5일 09:00 KST**에 전국 데이터를 받아 동구권으로 걸러 커밋하고, 푸시된 내용은 Vercel이 자동 배포합니다(`.github/workflows/refresh-data.yml`). 최초 1회 저장소 Settings → Secrets and variables → Actions에 `SAFEMAP_SERVICE_KEY`, `MOIS_SERVICE_KEY`를 등록하면 됩니다(커밋 금지, Actions Secret만). 수집이 실패하면 알림 이슈가 자동 생성됩니다.

**수동**: 로컬에서 즉시 갱신할 수도 있습니다. 인증키는 `.env.local`에 둡니다.

```bash
# 보안등만 갱신
node scripts/fetch-real-data.mjs --only=streetlights
# 전체 갱신 (CCTV 전국 스캔 포함, 약 15분)
node scripts/fetch-real-data.mjs
```

보안등은 API가 좌표를 공개하지 않아 동구청 제공 CSV를 사용합니다. `scripts/data/donggu-streetlights.csv`를 최신 자료로 교체한 뒤 위 명령으로 반영하세요. 자료가 매년 말 기준이라 매년 1월 15일에 GitHub Actions가 갱신 알림 이슈를 자동 생성합니다(`.github/workflows/streetlight-refresh-reminder.yml`).

## 야간 운영시설 (OpenStreetMap)

야간 시간대에 실제로 운영하는 생활시설(편의점·슈퍼·음식점·카페·패스트푸드·약국·병원)을 Overpass API로 수집해 `opening_hours`를 파싱해 야간 운영 수준을 매긴다. 야간 보행환경에서의 활동성·자연감시 **가능성**을 나타내는 보조지표이며, "시설 많음 = 안전"이 아니다. bar·pub·nightclub 등 유흥시설은 밤 인파가 자연감시를 의미하지 않아 의도적으로 수집하지 않는다.

```bash
npm run fetch:night-facilities   # public/data/night-facilities.geojson + 메타 갱신
npm run score-roads              # 도로별 nightActivityScore 재계산
```

- 영업시간 판정은 `opening_hours.js` 파서로 KST 대표 주 7일을 평가한다. 22·00·02·04시에 영업 중인 날이 주 4일 이상이면 해당 시간대 운영으로 본다(한국 상가는 주 7일 영업이 기본이라 7일 전부를 요구하면 과도하게 보수적).
- `nightScore`: 24시간 1.0 · 02시 이후 0.9 · 00시 이후 0.75 · 22시 이후 0.5 · 미확인 0.15 · 주간 전용 0. 유형별 가중치는 `config/safetyWeights.ts`의 `nightActivity.categoryWeights`에서 조정한다.
- 도로 점수는 시설별 기여도(거리 감쇠 × nightScore × 유형 가중치)의 합에 로그 포화를 적용해 밀집 지역이 무한히 유리해지지 않게 한다.
- 영업시간은 OSM 기여자 데이터로 실제와 다를 수 있다. 폐업·휴무일 반영이 늦을 수 있고, 광주 동구는 opening_hours 기재율이 낮다(2026-09 기준 약 13%). 미기재 시설은 "미확인"으로 표시되며 점 기여가 약하다(0이 아님).
- GitHub Actions가 매주 월요일 03:00 KST에 갱신한다(`.github/workflows/night-facilities-refresh.yml`). Overpass 장애 시 기존 데이터를 보존하고 커밋하지 않는다.

노후건물은 안전디딤돌 WMS 전용(좌표 미공개)이라 아직 미포함입니다. CPTED(IF_0023)와 도로시설(인도) IF_0095는 좌표가 없어 미사용이며, 인도는 대신 국토지리정보원 원본 도형을 사용합니다(아래 참고). 현재 상태는 `public/data/meta.json`에 기록됩니다.

시설 수집 스크립트는 저장 후 `score-roads`를 자동 실행합니다(`npm ci` 필요). 월간 CI에서도 입력 해시와 도로 점수 정합성을 확인한 후 커밋합니다.

## 범죄 상대적 주의도 가져오기

경찰청 범죄주의구간은 좌표 원본이 비공개라, 생활안전지도(safemap)의 **범죄주의구간(전체) WMS 래스터**(IF_0087, 밀도분석 10등급)를 동구 타일로 내려받아 도로를 따라 샘플링해 도로별 상대적 주의도로 변환합니다.

```bash
# SAFEMAP_SERVICE_KEY 를 .env.local 에 추가 (커밋 금지)
npm run fetch:safemap-crime   # crime-risk.json + 지도 오버레이용 PNG 생성
npm run score-roads           # 상대적 주의도를 점수에 반영
```

- 데이터가 있는 구간만 반영됩니다. WMS 밀도분석이 닿지 않는 구간은 `crimeScore: null`(미수집)로 남고, 샘플링 결과가 낮은 구간(`crimeScore: 100`)과 다르게 표시됩니다.
- 산출값은 경찰청 밀도분석(최근 1년 5대 범죄)의 상대 참고값입니다. 생활안전지도 공식 안내대로 **등급이 높은 지역이 현재 위험하다는 의미가 아니며**, 실제 범죄 발생 가능성을 예측하는 수치가 아닙니다.
- 원본 벡터가 아니라 WMS 래스터(약 1.7m/픽셀)를 읽으므로 렌더링·해상도 오차가 있고, 색상은 공식 범례 API(`lgdInfo`)와 최근접 매칭합니다.
- 지도의 "범죄 상대적 주의구간 표시" 레이어는 같은 WMS 원본을 사전 내려받은 정적 이미지입니다(서비스키 노출 없음, 시각 참고용).
- 출처: 행정안전부 생활안전지도 / 경찰청. 경찰청 요청으로 원데이터가 아닌 가공(도로 클리핑·등급) 정보만 제공되며, 2차 가공·재배포 조건은 생활안전지도 오픈API 이용조건을 확인한 뒤 유지합니다(TODO: 이용조건 변경 시 본 파이프라인 재검토).

## 인도 가져오기

인도 원본도 도로와 같은 국가공간정보포털 수치지도 다운로드에서 받습니다(보행로 레이어 `N3L_A0033320` 계열). 연 1회 수동 교체를 전제로 하며, 안전디딤돌 IF_0095는 같은 데이터의 무좌표 속성 API라 점수 계산에 쓸 수 없습니다.

```bash
# 도로 원본을 교체했거나 인도 원본을 교체할 때 실행 (import-roads 다음에)
.venv/bin/python scripts/import-sidewalks.py --shp "/다운로드/N3L_A0033320.shp"
```

구간 길이 중 10m 반경 내 인도에 덮인 비율로 `pedestrianAccess`(yes 80% 이상 / partial 30% 이상 / no 미만)를 매기고, 인도 없음 구간은 −3점을 반영합니다. 처리 결과는 `public/data/sidewalks-meta.json`에 기록됩니다.

## 도로 가져오기·점수 갱신

```bash
# 도로 원본을 교체할 때만 필요: Python 3.11+
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements-roads.txt
.venv/bin/python scripts/import-roads.py --shp "/다운로드/도로중심선_광주/N3L_A0020000_29.shp"
.venv/bin/python scripts/import-sidewalks.py --shp "/다운로드/N3L_A0033320.shp"

# 시설·가중치·도로가 바뀌었을 때 점수 재계산
npm run score-roads
npm test
.venv/bin/python -m unittest discover -s scripts -p 'test_*.py'
```

- 원본 SHP/DBF/SHX/PRJ는 로컬에 보관합니다. 재현에 필요한 원본 해시는 `public/data/roads-meta.json`에 기록합니다.
- `scripts/data/road-segments.geojson`: EPSG:5179에서 동구 경계로 클립하고 연결부를 정리한 뒤 최대 50m로 나눈 입력. 배포 파일은 WGS84입니다.
- `public/data/road-segments.geojson`: 공간 인덱스로 후보 시설을 찾고 기존 Turf 점수 함수를 적용한 사전 계산 결과. 브라우저는 점수를 다시 계산하지 않습니다.
- 도로명 누락 시 `행정동 + 구간 식별자`로 표시합니다. 검색과 100개 단위 페이지로 조회할 수 있습니다.
- 도로 XML 생성일은 2023-02-17이나 실제 측량·갱신 기준일은 미확인입니다. 입체교차 연결을 검증한 경로탐색망은 아닙니다. 인도 인접 여부는 도형 기반 참고값이므로 보행 가능 여부를 법적으로 판정하지 않습니다.
- 경계는 SGIS 기반 `vuski/admdongkor`의 2026-07-01판 13개 행정동을 합쳤습니다. 출처·처리 방식·검증 결과는 [도로 데이터 문서](docs/roads.md)를 참고하세요.

## 실행

```bash
npm install
npm run dev
```

프로덕션 빌드는 다음 명령으로 확인합니다.

```bash
npm run build
```

Node.js 20 이상이 필요합니다. 현재 GitHub 저장소를 직접 가져오는 경우 Vercel Root Directory는 기본값인 `./`을 사용합니다.

지도는 MapTiler Cloud의 `streets-v2` 스타일을 사용합니다. 로컬 `.env.local`과 Vercel Production 환경에 다음 값을 설정해야 합니다.

```dotenv
NEXT_PUBLIC_SPATIAL_DATA_SOURCE=static
NEXT_PUBLIC_MAPTILER_KEY=MapTiler에서_발급한_공개키
```

MapTiler 키는 브라우저에서 사용되는 공개 키이므로 MapTiler 관리 화면에서 운영 도메인 `donggu-night-safety.vercel.app`과 사용자 도메인만 허용하도록 제한합니다. Vercel 환경변수를 변경한 뒤에는 새 배포가 필요합니다.

## 구조

```text
app/                         Next.js App Router 진입점과 전역 스타일
components/map/              MapLibre 지도, source/layer, 도로 팝업
components/panel/            레이어 제어, 범례, 안내문
config/mapLayers.ts          레이어 표시 메타데이터
config/safetyWeights.ts      거리 반경, 가감점, 점수 등급, v2 차원 설정
lib/data/                    데이터 공급자 인터페이스와 정적 GeoJSON 구현
lib/scoring/                 Turf 기반 도로 구간 점수 계산(v1+v2, 차원별 모듈)
scripts/fetch-real-data.mjs  공공데이터 수집 스크립트
scripts/fetch-night-facilities.mjs  야간 운영시설 수집(OSM Overpass + opening_hours 파싱)
public/data/                 수집된 GeoJSON과 수집 기록(meta.json)
public/data/mock-samples/    기능 검증용 샘플 백업
types/                       공간 데이터와 UI 공유 타입
docs/architecture.md         PostGIS 전환 설계
```

`components`는 데이터 출처를 알지 못합니다. `lib/data/index.ts`가 공급자를 선택하고, `SafetyDataSource`가 GeoJSON 계약을 고정합니다. Phase 4에서는 `SupabaseSafetyDataSource`를 추가해 같은 계약으로 PostGIS 결과를 반환합니다.

## v2 밤길 안전 참고지수

v2는 "시설 있음 → 가점" 방식의 v1(기본점수 50 + 시설별 가감점)을 폐기하지 않고 `safetyScore`로 보존해 두고, 서로 다른 개념을 분리해 평가하는 5차원 구조로 계산한 최종 참고지수다(`safetyScoreV2`, `lib/scoring/calculateRoadSafety.ts`). 각 하위 점수는 0~100으로 정규화하고, 데이터가 수집된 하위지표끼리 가중치를 재정규화해 평균낸다(`lib/scoring/weightedAverage.ts`의 `weightedAverageAvailable`).

```text
safetyScoreV2 = 조명·가시성×0.25 + 감시·긴급대응×0.20 + 야간활동·자연감시×0.15
              + 공간환경·방치도×0.15 + 범죄 상대주의도×0.25
```

| 차원 | 하위 지표 | 현재 데이터 |
| --- | --- | --- |
| 조명·가시성 (25%) | 조명 커버리지 50% · 최대 암구간 30% · 조명 균일도 20% | 보안등 좌표 ✅ (lux 아님) |
| 감시·긴급대응 (20%) | CCTV 50% · CPTED 25% · 비상벨 15% · 경찰시설 10% | CCTV·비상벨 ✅ 거리감쇠, CPTED·경찰시설 ❌ |
| 야간활동·자연감시 (15%) | 야간 운영시설 40% · 대중교통 25% · 도로 활성도 proxy 20% · 편의점 15% | 야간 운영시설(OSM)·폭원 proxy·편의점 ✅, 대중교통 ❌ |
| 공간환경·방치도 (15%) | 빈집 45% · 건축물 노후/방치 20% · 보행환경 20% · 공간구조 15% | 인도 ✅, 빈집·노후건물 좌표·공간구조 ❌ |
| 범죄 상대주의도 (25%) | 생활안전지도 WMS 샘플링(기존 로직 재사용) | 4,399/10,660 구간 ✅, 나머지 미수집 |

- **결측값**: 데이터가 없는 항목은 0점이 아니라 미수집(null)으로 기록되고 재정규화로 제외된다. 예를 들어 CPTED·경찰시설이 없으면 CCTV·비상벨 비율(0.50:0.15)을 다시 100%로 정규화한다. 모든 하위지표가 null인 차원은 차원 자체가 null이고, 미수집 차원이 많아도 최종 점수가 부당하게 깎이지 않는다. 범죄 WMS가 닿지 않는 구간의 `crimeScore: null`은 위험구간이 아니라 미수집이며, 이 경우 나머지 4개 차원(0.75)으로 재정규화한다.
- **조명**: 보안등 좌표·거리 분포 기반의 상대적 조명환경 추정값이다. 실제 조도(lux)를 측정하지 않는다. 보안등 개수(`streetlightCount`)는 표시용이며 점수에 이중 반영하지 않는다.
- **CCTV·비상벨**: 존재 여부가 아니라 거리감쇠(가까울수록 높음)로 평가한다. CCTV가 여러 대여도 포화형 보너스(×1.10/×1.15)만 적용해 개수에 선형 비례하지 않는다.
- **경찰시설**: 경찰서·지구대·파출소까지의 좌표 거리 접근성이며 실제 출동시간을 의미하지 않는다. 좌표 API 확보 전까지 미수집(`policeScore` null)이다.
- **야간활동**: 야간 운영시설(OSM opening_hours 기반)과 도로 활성도는 실제 보행량이 아니라 proxy다. 대중교통은 데이터 연결 전까지 구조만 존재하고(`bus_stop`·`subway_entrance` 타입) 가짜값을 채우지 않는다. 도로 활성도는 폭원 기반의 약한 proxy로 차원 내 20%에만 반영되며, "큰 도로 = 안전" 가점이 아니다. 대규모 공동주택 역시 직접 가점하지 않는다(CCTV·조명 등 실제 요소를 각각 측정한다).
- **빈집·노후건축물**: 빈집(`vacant_house`)은 강한 감점 지표, 노후건축물은 약한 보조 지표(deterioration, 차원 내 20%)로 분리한다. v1의 노후건물 최대 −8 직접 감점·인도 없음 −3은 폐기하고 환경 차원 내부로 흡수했다.
- 점수 등급은 v2 기준 5단계(80~100 상대적 안심 높음 ~ 0~34 높은 주의 참고)다. 최종 점수는 **절대적인 안전을 보장하는 수치가 아니라 공공데이터 기반의 상대적 밤길 환경 참고지수**다.

실데이터 연결 우선순위(빈집 → 경찰시설 → 버스정류장 → 지하철 출입구 → 야간활동 POI → 노후건축물 좌표)는 `public/data/meta.json`의 `pending`과 `scripts/fetch-real-data.mjs`에 기록된다. 데이터가 수집되면 타입만 맞춰 넣어도 점수에 자동 반영된다.

## 점수 원칙 (v1)

`config/safetyWeights.ts`의 기본점수와 거리별 가중치만 사용합니다. 보안등은 개수가 아니라 도로를 5m 간격으로 샘플링해 계산한 **조명 커버리지(50%)·최대 암구간(30%)·조명 균일도(20%)**로 조명 환경(0~100)을 산출하고, CCTV·비상벨·편의점·CPTED 시설은 가점합니다. 범죄 상대적 주의도(생활안전지도 WMS 샘플링)와 인도 없는 구간, 노후건축물 표본은 감점합니다. 조명 환경은 실제 조도(lux)가, 상대적 주의도는 실제 범죄 발생 확률이 아닙니다. 최종값은 `lib/scoring/calculateRoadSafety.ts`에서 0~100으로 제한합니다.

이 점수는 절대적인 안전을 보장하지 않으며, 공공데이터의 누락·갱신 시차·공간 해상도에 따라 달라질 수 있습니다.
