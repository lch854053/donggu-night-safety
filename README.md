# 광주 동구 밤길 안심지도

광주 동구의 안심 인프라와 주변 환경을 조합해 도로별 상대적 밤길 안전 참고지수를 보여주는 MVP입니다. 보안등·CCTV·비상벨·편의점은 공공데이터 실측 자료이고, 도로는 국토지리정보원 연속수치지형도에서 동구 경계로 추출한 **10,660개 구간(약 356km)**입니다. 주의구간은 미수집 상태이며 가상의 샘플을 운영 점수에 반영하지 않습니다.

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

노후건물·범죄주의구간은 안전디딤돌 WMS 전용(좌표 미공개)이라 아직 미포함입니다. CPTED(IF_0023)는 좌표가 없어 지오코딩 연결 후 수집합니다. 현재 상태는 `public/data/meta.json`에 기록됩니다.

시설 수집 스크립트는 저장 후 `score-roads`를 자동 실행합니다(`npm ci` 필요). 월간 CI에서도 입력 해시와 도로 점수 정합성을 확인한 후 커밋합니다.

## 도로 가져오기·점수 갱신

```bash
# 도로 원본을 교체할 때만 필요: Python 3.11+
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements-roads.txt
.venv/bin/python scripts/import-roads.py --shp "/다운로드/도로중심선_광주/N3L_A0020000_29.shp"

# 시설·가중치·도로가 바뀌었을 때 점수 재계산
npm run score-roads
npm test
.venv/bin/python -m unittest discover -s scripts -p 'test_*.py'
```

- 원본 SHP/DBF/SHX/PRJ는 로컬에 보관합니다. 재현에 필요한 원본 해시는 `public/data/roads-meta.json`에 기록합니다.
- `scripts/data/road-segments.geojson`: EPSG:5179에서 동구 경계로 클립하고 연결부를 정리한 뒤 최대 50m로 나눈 입력. 배포 파일은 WGS84입니다.
- `public/data/road-segments.geojson`: 공간 인덱스로 후보 시설을 찾고 기존 Turf 점수 함수를 적용한 사전 계산 결과. 브라우저는 점수를 다시 계산하지 않습니다.
- 도로명 누락 시 `행정동 + 구간 식별자`로 표시합니다. 검색과 100개 단위 페이지로 조회할 수 있습니다.
- 도로 XML 생성일은 2023-02-17이나 실제 측량·갱신 기준일은 미확인입니다. 보행 가능 여부·입체교차 연결을 검증한 경로탐색망은 아닙니다.
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
config/safetyWeights.ts      거리 반경, 가감점, 점수 등급
lib/data/                    데이터 공급자 인터페이스와 정적 GeoJSON 구현
lib/scoring/                 Turf 기반 도로 구간 점수 계산
scripts/fetch-real-data.mjs  공공데이터 수집 스크립트
public/data/                 수집된 GeoJSON과 수집 기록(meta.json)
public/data/mock-samples/    기능 검증용 샘플 백업
types/                       공간 데이터와 UI 공유 타입
docs/architecture.md         PostGIS 전환 설계
```

`components`는 데이터 출처를 알지 못합니다. `lib/data/index.ts`가 공급자를 선택하고, `SafetyDataSource`가 GeoJSON 계약을 고정합니다. Phase 4에서는 `SupabaseSafetyDataSource`를 추가해 같은 계약으로 PostGIS 결과를 반환합니다.

## 점수 원칙

`config/safetyWeights.ts`의 기본점수와 거리별 가중치만 사용합니다. 보안등, CCTV, 비상벨, 편의점, CPTED 시설은 가점하고 상대적 주의등급과 노후건축물 표본은 감점합니다. 최종값은 `lib/scoring/calculateRoadSafety.ts`에서 0~100으로 제한합니다.

이 점수는 절대적인 안전을 보장하지 않으며, 공공데이터의 누락·갱신 시차·공간 해상도에 따라 달라질 수 있습니다.
