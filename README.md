# 광주 동구 밤길 안심지도

광주 동구의 안심 인프라와 주변 환경을 조합해 도로별 상대적 밤길 안전 참고지수를 보여주는 Phase 1 MVP입니다. 현재 화면의 모든 시설과 주의구간은 기능 검증용 mock 데이터입니다.

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
NEXT_PUBLIC_SPATIAL_DATA_SOURCE=mock
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
lib/data/                    데이터 공급자 인터페이스와 mock 구현
lib/scoring/                 Turf 기반 도로 구간 점수 계산
public/data/                 mock GeoJSON
types/                       공간 데이터와 UI 공유 타입
docs/architecture.md         PostGIS 전환 설계
```

`components`는 데이터 출처를 알지 못합니다. `lib/data/index.ts`가 공급자를 선택하고, `SafetyDataSource`가 GeoJSON 계약을 고정합니다. Phase 4에서는 `SupabaseSafetyDataSource`를 추가해 같은 계약으로 PostGIS 결과를 반환합니다.

## 점수 원칙

`config/safetyWeights.ts`의 기본점수와 거리별 가중치만 사용합니다. 보안등, CCTV, 비상벨, 편의점, CPTED 시설은 가점하고 상대적 주의등급과 노후건축물 표본은 감점합니다. 최종값은 `lib/scoring/calculateRoadSafety.ts`에서 0~100으로 제한합니다.

이 점수는 절대적인 안전을 보장하지 않으며, 공공데이터의 누락·갱신 시차·공간 해상도에 따라 달라질 수 있습니다.
