# 공간 데이터 아키텍처

## 단계별 경계

Phase 1은 정적 GeoJSON을 `MockSafetyDataSource`로 읽고 브라우저에서 Turf로 점수를 계산합니다. Phase 4에서는 PostGIS가 점수를 사전 계산하거나 조회 시 집계하고, Supabase 공급자는 결과를 기존 `SafetyDataset` 형태로 변환합니다. 공급자가 `metadata.scoreKind`를 `precomputed`로 지정하면 클라이언트는 반환된 도로 점수를 그대로 사용하므로 MapLibre 컴포넌트와 패널은 이 전환의 영향을 받지 않습니다.

실제 데이터 적재 시 원천 좌표계를 확인하고 저장 직전에 EPSG:4326으로 통일합니다. 분석은 거리 왜곡을 피하도록 `geography` 캐스팅을 사용하고, 화면 전송은 GeoJSON 또는 데이터가 커질 경우 벡터 타일로 전환합니다.

## 권장 PostGIS 스키마

```sql
create extension if not exists postgis;
create extension if not exists pgcrypto;

create table public.safety_features (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in (
    'security_light', 'road_light', 'cctv', 'emergency_bell', 'convenience_store',
    'cpted', 'old_building', 'police_facility', 'bus_stop'
  )),
  name text,
  geom geometry(Geometry, 4326) not null,
  source text not null,
  properties jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.risk_zones (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  risk_level smallint not null check (risk_level between 1 and 5),
  geom geometry(Geometry, 4326) not null,
  source text not null,
  properties jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.road_segments (
  id uuid primary key default gen_random_uuid(),
  name text,
  geom geometry(LineString, 4326) not null,
  length_m numeric not null check (length_m >= 0),
  lighting_score smallint check (lighting_score between 0 and 100),
  surveillance_score smallint check (surveillance_score between 0 and 100),
  crime_score smallint check (crime_score between 0 and 100),
  environment_score smallint check (environment_score between 0 and 100),
  safety_score smallint check (safety_score between 0 and 100),
  score_details jsonb not null default '{}'::jsonb,
  scored_at timestamptz,
  updated_at timestamptz not null default now()
);

create index safety_features_geom_gix on public.safety_features using gist (geom);
create index safety_features_type_idx on public.safety_features (type);
create index risk_zones_geom_gix on public.risk_zones using gist (geom);
create index road_segments_geom_gix on public.road_segments using gist (geom);
create index road_segments_safety_score_idx on public.road_segments (safety_score);
```

## 집계 방향

시설 반경 집계는 도로와 시설을 `ST_DWithin(r.geom::geography, f.geom::geography, 반경미터)`로 조인합니다. CPTED·상대적 주의구간처럼 면 또는 선과의 관계가 중요한 데이터는 `ST_Intersects`를 우선 사용하고, 원천 도형의 품질이 낮을 때만 검증된 허용 거리로 `ST_Buffer`를 적용합니다.

```sql
select
  r.id,
  count(*) filter (
     where f.type = 'security_light'
      and ST_DWithin(r.geom::geography, f.geom::geography, 50)
  ) as streetlight_count,
  count(*) filter (
    where f.type = 'cctv'
      and ST_DWithin(r.geom::geography, f.geom::geography, 100)
  ) as cctv_count,
  max(z.risk_level) filter (where ST_Intersects(r.geom, z.geom)) as risk_level
from public.road_segments r
left join public.safety_features f
  on ST_DWithin(r.geom::geography, f.geom::geography, 100)
left join public.risk_zones z
  on ST_Intersects(r.geom, z.geom)
group by r.id;
```

가중치는 데이터베이스에 중복 하드코딩하지 않습니다. 초기에는 서버 작업이 `config/safetyWeights.ts`와 같은 버전의 설정을 읽어 `road_segments`를 갱신하고, 운영 단계에서는 `scoring_weight_sets` 테이블과 적용 버전을 `score_details`에 기록해 점수 재현성을 확보합니다.

## 성능 확장

1. 동구 경계로 원천 데이터를 적재 단계에서 제한합니다.
2. 공간 조인 결과는 배치 작업으로 `road_segments`에 저장합니다.
3. 데이터가 커지면 지도 viewport bbox만 반환하는 RPC를 사용합니다.
4. 최종 단계에서는 도로와 시설을 PMTiles 또는 MVT로 제공하고 상세정보만 Supabase에서 조회합니다.
