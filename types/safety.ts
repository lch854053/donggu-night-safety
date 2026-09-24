import type { FeatureCollection, LineString, Point, Polygon } from "geojson";
import type { CctvPurpose } from "@/config/cctvPurpose.mjs";

export type SafetyFeatureType =
  | "streetlight"
  | "cctv"
  | "emergency_bell"
  | "convenience_store"
  | "cpted"
  | "old_building"
  /** 지구대·파출소. 주소를 건물 좌표로 변환한 시설만 포함한다. */
  | "police_station"
  | "police_center"
  /** 야간 영업 POI(음식점·카페·약국·PC방 등). 데이터 연결은 TODO. */
  | "night_activity"
  /** 버스정류장. 데이터 연결은 TODO. */
  | "bus_stop"
  /** 지하철 출입구. 데이터 연결은 TODO. */
  | "subway_entrance"
  /** 빈집. 데이터 연결은 TODO. */
  | "vacant_house";

export type LayerKey = Exclude<SafetyFeatureType, "police_center">;

export type RoadPlanningGrade = "소로" | "중로" | "대로" | "광로";

export interface SafetyFeatureProperties {
  id: string;
  type: SafetyFeatureType;
  name: string;
  source: string;
  installedAt?: string;
  note?: string;
  address?: string;
  purpose?: CctvPurpose;
  purposeLabel?: string;
  confidence?: number;
  cameraCount?: number;
  sourceYear?: number;
  sourceDataset?: string;
  purposeSource?: "historical" | "current";
}

export interface RiskZoneProperties {
  id: string;
  type: "relative_caution";
  name: string;
  riskLevel: 1 | 2 | 3 | 4 | 5;
  source: string;
  note: string;
}

export type PedestrianAccess = "yes" | "partial" | "no" | "unverified";

export interface RoadSegmentInputProperties {
  id: string;
  name: string;
  source: string;
  /** VWorld 도로명주소 도로가 기존의 임시 표시명을 대체한 경우에만 설정한다. */
  roadNameSource?: "LT_L_SPRD";
  fallbackName?: string;
  sourceIds?: string[];
  adminDong?: string;
  roadClass?: string;
  /** VWorld 도시계획 도로의 단일 지정이 구간 80% 이상과 일치할 때만 기재. */
  planningRoadGrade?: RoadPlanningGrade;
  planningRoadName?: string;
  planningRoadStatus?: string;
  widthMeters?: number;
  lanes?: number;
  pedestrianAccess?: PedestrianAccess;
  sidewalkWidthMeters?: number | null;
}

export interface RoadSegmentProperties extends RoadSegmentInputProperties {
  lengthMeters: number;
  /**
   * v1(legacy) 최종 점수. 비교·롤백을 위해 보존되며 신규 표시는 safetyScoreV2가 기준.
   * 기본점수 50에 시설별 가감점을 합산한 구버전 모델이다.
   */
  safetyScore: number;
  /**
   * v2 최종 밤길 안전 참고지수(0~100). 5개 차원의 가중 평균이며,
   * 미수집 차원은 재정규화해 제외한다. 차원이 전혀 없으면 null(0과 다른 의미).
   */
  safetyScoreV2: number | null;
  /** 보안등 위치·거리 분포 기반 상대적 조명 환경(0~100). 실제 조도(lux)가 아니다. v2 조명·가시성 차원. */
  lightingScore: number;
  lightingCoverage: number;
  maxDarkGapMeters: number;
  lightingUniformityScore: number;
  /** v2 감시·긴급대응 차원(0~100). CCTV·CPTED·비상벨·경찰시설 중 수집된 항목만 재정규화 평균. */
  surveillanceScore: number | null;
  /** v2 야간활동·자연감시 차원(0~100). */
  activityScore: number | null;
  /** v2 공간환경·방치도 차원(0~100). 100점에서 취약요인만큼 감점. */
  environmentScore: number | null;
  crimeScore: number | null;
  /** 상대적 주의도 산출에 쓴 WMS 샘플 수. 데이터가 없는 구간은 null. */
  crimeSampleCount: number | null;
  /** v1(legacy) 인도 없음 감점 기록. v2에서는 sidewalkScore로 흡수됐다. */
  sidewalkContribution: number;
  streetlightCount: number;
  cctvCount: number;
  emergencyBellCount: number;
  convenienceStoreCount: number;
  cptedCount: number;
  oldBuildingCount: number;
  riskLevel: number;

  // ── v2 세부 점수. 데이터가 수집된 항목만 숫자로 기록하고 미수집은 필드 자체를 생략한다.
  cctvScore?: number | null;
  emergencyBellScore?: number | null;
  cptedScore?: number | null;
  policeScore?: number | null;
  nightActivityScore?: number | null;
  transitScore?: number | null;
  roadActivityScore?: number | null;
  convenienceStoreScore?: number | null;
  vacancyScore?: number | null;
  deteriorationScore?: number | null;
  sidewalkScore?: number | null;
  spatialStructureScore?: number | null;
}

export interface SafetyDataset {
  features: FeatureCollection<Point, SafetyFeatureProperties>;
  riskZones: FeatureCollection<Polygon | LineString, RiskZoneProperties>;
  roadSegments: FeatureCollection<LineString, RoadSegmentInputProperties>;
  metadata: {
    sourceKind: "mock" | "static" | "supabase";
    scoreKind: "client" | "precomputed";
    updatedAt: string;
  };
  /**
   * 생활안전지도(경찰청 밀도분석) WMS를 도로별로 샘플링한 상대적 주의도.
   * 현재 원천은 여성밤길치안안전(전체, 밤 시간대 20~24시) 레이어다.
   * 이 파일 자체는 사전 처리 산출물이며, 구간에 없으면 해당 도로는
   * crimeScore가 null(미수집)이 된다 — 0(낮음)과 다른 의미다.
   */
  crimeRiskByRoad?: Record<string, CrimeRiskSummary>;
}

/** 공간 데이터와 UI가 공유하는 도로별 상대적 주의도 요약. */
export interface CrimeRiskSummary {
  /** mean/max/highRiskRatio 가중 합산 (0~1). */
  crimeRisk: number;
  /** 0~5 감점 단계 (SAFETY_WEIGHTS.crimeRisk 키). */
  level: number;
  /** 샘플 평균 정규화 위험도 (0~1). */
  mean: number;
  /** 샘플 최고 정규화 위험도 (0~1). */
  max: number;
  /** 고위험 등급 샘플 비율 (0~1). */
  highRiskRatio: number;
  /** 범례에 매칭된 샘플 수. */
  sampleCount: number;
  /** noData(투명·미매칭) 샘플 비율. noData는 위험도 0이 아니다. */
  noDataRatio: number;
  /** 이 구간 값의 원천. 여성밤길(IF_0080)을 우선하고 없는 구간은 범죄주의구간(IF_0087)으로 보완된다. */
  source?: "IF_0080" | "IF_0087";
}

export type ScoredRoadSegments = FeatureCollection<LineString, RoadSegmentProperties>;

export interface ScoredRoadFile extends ScoredRoadSegments {
  scoreMetadata: {
    kind: "precomputed";
    generatedAt: string;
    inputHashes: Record<string, string>;
  };
}

export type LayerVisibility = Record<LayerKey, boolean>;
