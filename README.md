# 광주 동구 밤길 안심지도

광주 동구의 안심 인프라와 주변 환경을 조합해 도로별 상대적 밤길 안전 참고지수를 보여주는 MVP입니다. 보안등·CCTV·비상벨·편의점은 공공데이터 실측 자료, CPTED는 완료 사업지의 주소 대표점(VWORLD 지오코딩), 여성밤길 치안안전(범죄 밀도분석)은 생활안전지도 WMS 사전 샘플링 결과(여성밤길 우선, 미커버 구간은 범죄주의구간으로 보완)이고, 도로와 인도는 국토지리정보원 연속수치지형도에서 동구 경계로 추출한 **10,660개 구간(약 356km)** 기준입니다. 가상의 샘플을 운영 점수에 반영하지 않습니다.

## 데이터 갱신

**자동(기본)**: CCTV·비상벨·편의점·CPTED·경찰시설과 VWorld 도로명·도시계획 참고자료는 GitHub Actions가 **매월 5일 09:00 KST**에 동구권 데이터를 받아 커밋하고, 푸시된 내용은 Vercel이 자동 배포합니다(`.github/workflows/refresh-data.yml`). 저장소 Settings → Secrets and variables → Actions에 `SAFEMAP_SERVICE_KEY`, `MOIS_SERVICE_KEY`, `VWORLD_API_KEY`, `VWORLD_DATA_API_KEY`, `KAKAO_REST_API_KEY`를 등록합니다(커밋 금지, Actions Secret만). VWORLD 키에 서비스 URL 설정이 필요한 경우 Actions Variable `VWORLD_DOMAIN`도 등록합니다. 수집이 실패하면 알림 이슈가 자동 생성됩니다.

**수동**: 로컬에서 즉시 갱신할 수도 있습니다. 인증키는 `.env.local`에 둡니다.

```bash
# 보안등만 갱신
node scripts/fetch-real-data.mjs --only=streetlights
# CPTED만 갱신 (SAFEMAP_SERVICE_KEY + VWORLD_API_KEY 필요)
node scripts/fetch-real-data.mjs --only=cpted
# 경찰시설만 갱신 (MOIS_SERVICE_KEY + KAKAO_REST_API_KEY)
node scripts/fetch-real-data.mjs --only=police
# 전체 갱신 (CCTV 전국 스캔 포함, 약 15분)
node scripts/fetch-real-data.mjs
```

경찰청 두 API의 광주 동구 지구대·파출소 및 치안센터 주소를 `MOIS_SERVICE_KEY`로 수집합니다. 원본에는 좌표가 없어 카카오 로컬 API로 도로명·건물번호가 일치하는 주소만 지도에 표시합니다. 카카오 키가 없으면 OpenStreetMap의 시설명·번지가 모두 일치하는 POI만 사용합니다. 지도에서는 세 시설을 하나의 ‘지구대·파출소·치안센터’ 레이어로 표시합니다. 지구대·파출소는 v2 경찰시설 접근성 점수에 반영하고 치안센터는 위치 정보로 표시합니다. Actions의 **Run workflow → only: police**에서 다른 시설을 유지한 채 갱신할 수 있습니다.

### CCTV 위치 및 목적 보정

최신 `전남광주통합특별시_CCTV_20260630`은 설치 **위치** 자료로 사용합니다. 좌표가 동구 행정경계 안이고 주소와 충돌하지 않는 행만 포함하며, 같은 장소에 여러 카메라가 있더라도 하나의 설치지점으로 병합합니다. 과거 `20210818` 자료에서 도로명·지번 주소가 일치하면 목적을 참고하되, 과거 목적이 현재 목적이나 운영 상태를 보증하지는 않습니다. 확인되지 않은 목적은 `unknown`으로 기록합니다. 기존 행안부 CCTV는 동구 주변까지 보존하고 새 자료와 겹치는 설치지점만 제거합니다. 수집·제외 사유와 목적별 건수는 `public/data/meta.json`에 남깁니다. 현재 경로는 2026-06-30 공개본으로 고정되어 있으므로 다음 공개본이 나오면 API 경로와 자료기준일을 갱신해야 합니다.

CCTV 점수는 가장 가까운 카메라만 보지 않고 **거리 점수 × 목적별 상대적 감시 신뢰계수**의 최고값으로 계산합니다. 생활방범 1.0, 어린이보호 0.9, 목적 미상 0.5, 쓰레기단속 0.4, 교통·기타 0.3을 사용합니다. 쓰레기·교통 단속 CCTV도 감시 기여를 0으로 간주하지 않지만 방범 전용과 동일시하지 않습니다. 이 계수는 실제 범죄 감소율이 아니라 **지수 산정용 보정계수**이며 `config/cctvPurpose.mjs` 한 곳에서 변경합니다. 서로 다른 설치지점의 포화형 개수 보너스만 적용하고 같은 위치의 카메라 수는 보너스에 중복 반영하지 않습니다. 촬영 방향·화각·실제 모니터링 여부는 확인할 수 없어 점수에 넣지 않으며, 최종 점수는 절대적인 안전도를 의미하지 않는 공공데이터 기반 상대적 참고지수입니다.

보안등은 API가 좌표를 공개하지 않아 동구청 제공 CSV를 사용합니다. `scripts/data/donggu-streetlights.csv`를 최신 자료로 교체한 뒤 위 명령으로 반영하세요. 자료가 매년 말 기준이라 매년 1월 15일에 GitHub Actions가 갱신 알림 이슈를 자동 생성합니다(`.github/workflows/streetlight-refresh-reminder.yml`).

빈집은 공공데이터포털 동구 빈집 현황(2025-07-16)의 EPSG:5174 투영좌표를 WGS84로 변환해 레이어와 공간환경 점수에 반영합니다. 주소 기반 필지와 대조해 원본 좌표가 어긋난 8건은 지번 일치 필지 대표점으로 보정하고, 주소·좌표 일치를 확인할 수 없는 5건은 표시와 점수에서 제외합니다(`scripts/data/vacant-coordinate-review.json`). 신규 좌표가 추가되면 주소·필지를 재확인해야 합니다. 노후건물은 안전디딤돌 WMS 전용(좌표 미공개)이라 레이어에 표시하지 않습니다. CPTED(IF_0023)는 VWORLD로 주소를 좌표화하며, 도로시설(인도) IF_0095는 좌표가 없어 대신 국토지리정보원 원본 도형을 사용합니다(아래 참고). 현재 상태는 `public/data/meta.json`에 기록됩니다.

### CPTED 주소 연동

- 생활안전지도 IF_0023의 광주광역시 사업 중 `imprvm_pro=완료`만 반영합니다. 계획·진행 중 사업은 기존 시설로 가점하지 않습니다.
- `jibun_addr`를 VWORLD Geocoder API 2.0의 지번(`parcel`) 검색으로 WGS84(EPSG:4326) 좌표화합니다. 미검색 시 `roadnm_add`가 있으면 도로명(`road`) 검색을 시도합니다.
- 동일 주소는 하나의 사업지로 집계하고 동구권 BBOX 밖 좌표는 제외합니다. **주소 대표점이며 개별 시설의 실측 위치나 사업구역의 경계가 아닙니다.** 지도와 거리 기반 CPTED 점수도 이 대표점을 사용합니다.
- 수집·제외 건수, 미검색 주소는 `public/data/cpted-meta.json`에 기록합니다. 인증 실패·서비스 오류·0건 수집이면 저장 전에 실패해 기존 시설 데이터를 보존합니다. 정상 미검색(`NOT_FOUND`) 주소만 제외하고 기록합니다.
- VWORLD 조회 결과는 `public/data/cpted-geocodes.json`에 주소별로 캐시합니다(키 미포함). 성공 좌표는 재사용하고 미검색은 90일 후 재조회합니다. 전체 재조회는 `node scripts/fetch-real-data.mjs --only=cpted --refresh-geocodes`로 실행합니다. GitHub 호스팅 러너에서 VWORLD 접속이 끊기는 경우가 있어, 새 주소·만료된 미검색 주소의 조회에는 VWORLD 접속이 가능한 실행 환경이 필요합니다. 접속 실패를 미검색으로 캐시하지 않습니다.
- Actions의 **Run workflow → only: cpted**로 다른 시설을 유지하면서 CPTED와 도로 점수만 갱신할 수 있습니다. 키는 수집 단계에서만 사용하며 브라우저나 Vercel 환경에는 필요하지 않습니다.

시설 수집 스크립트는 저장 후 `score-roads`를 자동 실행합니다(`npm ci` 필요). 월간 CI에서도 입력 해시와 도로 점수 정합성을 확인한 후 커밋합니다.

## 여성밤길 치안안전 가져오기

경찰청 밀도분석 좌표 원본이 비공개라, 생활안전지도(safemap)의 WMS 래스터 두 개를 동구 타일로 내려받아 도로를 따라 샘플링해 도로별 상대적 주의도로 변환합니다.

- **여성밤길치안안전(전체)**(IF_0080, 밤 시간대 20~24시 5대 범죄 밀도분석 10등급) — 우선 사용
- **범죄주의구간(전체)**(IF_0087, 전체 시간대 밀도분석 10등급) — 여성밤길이 닿지 않는 구간만 보완

두 레이어는 같은 경찰청 밀도분석 10등급 구조라 하나의 파이프라인에서 출처 상수만 바꿔 샘플링하고, 구간별로 여성밤길 값을 우선 병합합니다(출처는 `crime-risk.json` 구간별 `source`에 기록). 스크립트·출력 파일 이름에 `crime`이 남는 것은 내용이 범죄 밀도 정보이기 때문입니다.

```bash
# SAFEMAP_SERVICE_KEY 를 .env.local 에 추가 (커밋 금지)
npm run fetch:safemap-crime   # crime-risk.json + 지도 오버레이용 PNG 생성
npm run score-roads           # 상대적 주의도를 점수에 반영
```

- 데이터가 있는 구간만 반영됩니다. 두 WMS 모두 닿지 않는 구간은 `crimeScore: null`(미수집)로 남고, 샘플링 결과가 낮은 구간(`crimeScore: 100`)과 다르게 표시됩니다.
- 산출값은 경찰청 밀도분석의 상대 참고값입니다. 생활안전지도 공식 안내대로 **등급이 높은 지역이 현재 위험하다는 의미가 아니며**, 실제 범죄 발생 가능성을 예측하는 수치가 아닙니다. 보완 구간은 전체 시간대 값이라 밤 시간대 위험도보다 넓게 잡힐 수 있습니다.
- 원본 벡터가 아니라 WMS 래스터(약 1.7m/픽셀)를 읽으므로 렌더링·해상도 오차가 있고, 색상은 공식 범례 API(`lgdInfo`)와 최근접 매칭합니다. IF_0080 WMS는 `styles`를 빈 값으로 호출해야만 렌더되고(공식 스타일명은 400), 타일에는 치안시설이 없는 지역의 #333333 음영이 섞여 있지만 샘플러는 범례색만 인정하므로 자동 배제됩니다.
- 지도의 오버레이용 PNG는 같은 WMS 원본을 사전 내려받은 정적 이미지입니다(서비스키 노출 없음). 여성밤길 타일을 위에 덮어 병합합니다.
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
VWORLD_DATA_API_KEY=... .venv/bin/python scripts/enrich_vworld_roads.py

# 시설·가중치·도로가 바뀌었을 때 점수 재계산
npm run score-roads
npm test
.venv/bin/python -m unittest discover -s scripts -p 'test_*.py'
```

- 원본 SHP/DBF/SHX/PRJ는 로컬에 보관합니다. 재현에 필요한 원본 해시는 `public/data/roads-meta.json`에 기록합니다.
- `scripts/data/road-segments.geojson`: EPSG:5179에서 동구 경계로 클립하고 연결부를 정리한 뒤 최대 50m로 나눈 입력. 배포 파일은 WGS84입니다.
- `public/data/road-segments.geojson`: 공간 인덱스로 후보 시설을 찾고 기존 Turf 점수 함수를 적용한 사전 계산 결과. 브라우저는 점수를 다시 계산하지 않습니다.
- NGII에 도로명이 없는 구간은 도로명주소 도로(`LT_L_SPRD`)의 선형과 5m 이내·길이 80% 이상 일치하고 후보 도로명이 하나일 때만 도로명을 보강합니다. 그 외에는 `행정동 + 구간 식별자`로 표시합니다. 검색과 100개 단위 페이지로 조회할 수 있습니다.
- 도로 XML 생성일은 2023-02-17이나 실제 측량·갱신 기준일은 미확인입니다. 입체교차 연결을 검증한 경로탐색망은 아닙니다. 인도 인접 여부는 도형 기반 참고값이므로 보행 가능 여부를 법적으로 판정하지 않습니다.
- 경계는 SGIS 기반 `vuski/admdongkor`의 2026-07-01판 13개 행정동을 합쳤습니다. 출처·처리 방식·검증 결과는 [도로 데이터 문서](docs/roads.md)를 참고하세요.

### VWorld 도로명·도시계획 도로 참고자료

`scripts/enrich_vworld_roads.py`는 서버 측 수집 단계에서만 `VWORLD_DATA_API_KEY`를 사용합니다(`VWORLD_API_KEY`도 폴백 허용). 등록 도메인이 다르면 `VWORLD_DOMAIN` 또는 `--domain`을 설정하세요. 두 레이어를 동구 경계로 잘라 기존 중심선과 매칭하며, API 오류·누락 페이지·0건에는 기존 데이터를 덮어쓰지 않습니다. 도로 원본을 다시 가져오면 인도 판정과 도로명·종류 보강을 차례로 재실행해야 합니다. 갱신 결과는 `public/data/vworld-roads-meta.json`에 기록합니다.

- **도로명주소 도로(`LT_L_SPRD`)**: 기존 NGII 도로의 형상·ID·폭원은 유지하고 검증된 임시 표시명만 변경합니다. 원래 표시명과 도로명 출처도 구간 속성에 보존합니다.
- **도시계획 도로(`LT_C_UPISUQ151`)**: 중심선 길이 80% 이상을 덮는 단일 지정에 소로·중로·대로·광로 등급이 있을 때 계획상 종류와 집행 상태를 중심선 클릭 팝업에 표시합니다. 현재 종류가 확인되는 구간은 4,149개, 그중 집행완료 1,140개 구간만 점수 계산에 활용합니다. 폴리곤 자체는 지도에 표시하지 않습니다. ‘미집행’은 실제 도로·인도가 없다는 뜻이 아닙니다.
- **도로 활성도 proxy**: NGII 폭원 점수 80% + 집행완료·단일 지정 구간의 계획상 종류 점수 20%로 기존 폭원 proxy를 대체합니다. 종류별 기준은 소로 25·중로 55·대로 80·광로 90점이며, 매칭이 없거나 미집행이면 기존 폭원 점수만 사용합니다. 이는 교통량·보행량 실측치가 아니며 별도 직접 가점도 아닙니다. TAGO 버스정류장 좌표 수집 이후 대중교통 접근성도 같은 야간활동·자연감시 차원에 반영되어 각 지표의 유효 비중이 재정규화됩니다.

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

지도는 VersaTiles의 OSM 벡터 타일 `gray` 스타일을 안전지도용으로 단순화해 사용합니다. 별도의 베이스맵 API 키는 필요하지 않습니다. `config/baseMap.ts`에서 POI 레이어 전체를 제외하고 지명·도로·건물·공원·수계 등 분석에 필요한 배경만 남깁니다. 안전시설 레이어와 도로 점수 데이터는 이 스타일과 분리되어 있습니다.

```dotenv
NEXT_PUBLIC_SPATIAL_DATA_SOURCE=static
```

베이스맵 출처는 지도 하단에 VersaTiles·OpenStreetMap·ESA WorldCover로 표기합니다. 타일은 OSM 원본의 실시간 뷰가 아니라 공급자의 갱신 주기에 따라 반영되므로 특정 재개발 구역의 최신 여부는 OSM 및 배포 타일 양쪽에서 확인해야 합니다.

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
              + 공간환경·방치도×0.15 + 여성밤길 치안안전×0.25
```

| 차원 | 하위 지표 | 현재 데이터 |
| --- | --- | --- |
| 조명·가시성 (25%) | 조명 커버리지 50% · 최대 암구간 30% · 조명 균일도 20% | 보안등 좌표 ✅ (lux 아님) |
| 감시·긴급대응 (20%) | CCTV 50% · CPTED 25% · 비상벨 15% · 경찰시설 10% | CCTV·비상벨·CPTED ✅ 거리감쇠(CPTED는 주소 대표점), 경찰시설 ❌ |
| 야간활동·자연감시 (15%) | 야간 영업시설 40% · 대중교통 25% · 도로 활성도 proxy 20% · 편의점 15% | 폭원·확인된 계획상 종류 proxy·편의점 ✅, 야간 POI·대중교통 ❌ |
| 공간환경·방치도 (15%) | 빈집 45% · 건축물 노후/방치 20% · 보행환경 20% · 공간구조 15% | 인도·빈집 ✅, 노후건물 좌표·공간구조 ❌ |
| 여성밤길 치안안전 (25%) | 생활안전지도 여성밤길치안안전(전체, 밤 20~24시) 우선 + 범죄주의구간(전체) 보완 WMS 샘플링 | 실측값은 `public/data/crime-risk.json` summary 참조 |

- **결측값**: 데이터가 없는 항목은 0점이 아니라 미수집(null)으로 기록되고 재정규화로 제외된다. 예를 들어 CPTED·경찰시설이 없으면 CCTV·비상벨 비율(0.50:0.15)을 다시 100%로 정규화한다. 모든 하위지표가 null인 차원은 차원 자체가 null이고, 미수집 차원이 많아도 최종 점수가 부당하게 깎이지 않는다. 범죄 WMS가 닿지 않는 구간의 `crimeScore: null`은 위험구간이 아니라 미수집이며, 이 경우 나머지 4개 차원(0.75)으로 재정규화한다.
- **조명**: 보안등 좌표·거리 분포 기반의 상대적 조명환경 추정값이다. 실제 조도(lux)를 측정하지 않는다. 보안등 개수(`streetlightCount`)는 표시용이며 점수에 이중 반영하지 않는다.
- **CCTV·비상벨**: 존재 여부가 아니라 거리감쇠(가까울수록 높음)로 평가한다. CCTV가 여러 대여도 포화형 보너스(×1.10/×1.15)만 적용해 개수에 선형 비례하지 않는다.
- **경찰시설**: 경찰서·지구대·파출소까지의 좌표 거리 접근성이며 실제 출동시간을 의미하지 않는다. 좌표 API 확보 전까지 미수집(`policeScore` null)이다.
- **야간활동**: 야간 영업 POI·대중교통은 실제 보행량이 아니라 proxy다. TAGO 정류장 좌표는 `bus_stop`으로 수집해 접근성에 반영한다. `night_activity`·`subway_entrance`는 미수집이며 가짜값을 채우지 않는다. 폭원·검증된 집행완료 도로 종류를 혼합한 도로 활성도 proxy의 설정 가중치는 차원 내 20%다. "큰 도로 = 안전"의 직접 가점이 아니다. 대규모 공동주택 역시 직접 가점하지 않는다(CCTV·조명 등 실제 요소를 각각 측정한다).
- **빈집·노후건축물**: 빈집(`vacant_house`)은 강한 감점 지표, 노후건축물은 약한 보조 지표(deterioration, 차원 내 20%)로 분리한다. v1의 노후건물 최대 −8 직접 감점·인도 없음 −3은 폐기하고 환경 차원 내부로 흡수했다.
- 점수 등급은 v2 기준 5단계(80~100 상대적 안심 높음 ~ 0~34 높은 주의 참고)다. 최종 점수는 **절대적인 안전을 보장하는 수치가 아니라 공공데이터 기반의 상대적 밤길 환경 참고지수**다.

빈집 재수집은 기존 `MOIS_SERVICE_KEY`를 사용해 `node scripts/fetch-real-data.mjs --only=vacant`으로 실행합니다. 월간 갱신도 기존 GitHub Actions Secret `MOIS_SERVICE_KEY`를 그대로 사용합니다. 키가 없을 때 전체 갱신은 이전 빈집 자료를 보존하며, 빈집만 갱신하면 오류를 알립니다. 키는 빌드 산출물이나 저장소에 포함하지 않습니다. 나머지 실데이터 연결 우선순위는 `public/data/meta.json`의 `pending`과 `scripts/fetch-real-data.mjs`에 기록됩니다.

### 버스정류장과 야간 승하차

`TAGO_SERVICE_KEY`를 서버 측 환경변수(로컬 `.env.local`, Actions Secret)에 설정하고 `node scripts/fetch-real-data.mjs --only=bus`로 TAGO 광주 정류장 좌표를 갱신합니다. 동구 13개 행정동 경계 안과 경계에서 500m 이내 정류장을 저장해 구 경계 도로의 접근성 계산을 보완합니다. 정류장 ID(`KJB` + CSV의 `정류장번호`)를 기준으로 연결하며 ARS 번호가 없는 정류장도 보존합니다. 전체 수집과 매월 자동 수집도 정류장을 갱신하며, 이전 승하차 집계는 같은 ID에서 유지합니다.

분기 승하차 원본 ZIP은 저장소에 올리지 않고 로컬에서 집계합니다:

```bash
python3 scripts/import-bus-ridership.py --zip "/다운로드/전남광주통합특별시_시내버스 노선별 승하차 인원_20260630.zip"
npm run score-roads
npm test
```

집계는 2026년 4월 1일–6월 30일의 20–23시 **승차·하차 거래건수**를 정류장과 평일/주말별 1일 평균으로 요약합니다. 환승은 제외하며, 정류장 팝업에 기간을 표시합니다. 승하차 건수는 보행량이나 범죄 위험의 직접 측정값이 아니므로 안전지수 가중치에는 넣지 않습니다. ZIP의 새 분기판을 적용하려면 기간 검증 및 집계 스크립트를 해당 기간에 맞춰 갱신해야 합니다.

## 점수 원칙 (v1)

`config/safetyWeights.ts`의 기본점수와 거리별 가중치만 사용합니다. 보안등은 개수가 아니라 도로를 5m 간격으로 샘플링해 계산한 **조명 커버리지(50%)·최대 암구간(30%)·조명 균일도(20%)**로 조명 환경(0~100)을 산출하고, CCTV·비상벨·편의점·CPTED 시설은 가점합니다. 여성밤길 치안안전(생활안전지도 WMS 샘플링)과 인도 없는 구간, 노후건축물 표본은 감점합니다. 조명 환경은 실제 조도(lux)가, 여성밤길 치안안전의 밀도 등급은 실제 범죄 발생 확률이 아닙니다. 최종값은 `lib/scoring/calculateRoadSafety.ts`에서 0~100으로 제한합니다.

이 점수는 절대적인 안전을 보장하지 않으며, 공공데이터의 누락·갱신 시차·공간 해상도에 따라 달라질 수 있습니다.
