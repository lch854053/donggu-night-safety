import type { FeatureCollection, LineString, Point, Polygon } from "geojson";

export type SafetyFeatureType =
  | "streetlight"
  | "cctv"
  | "emergency_bell"
  | "convenience_store"
  | "cpted"
  | "old_building";

export type LayerKey = SafetyFeatureType;

export interface SafetyFeatureProperties {
  id: string;
  type: SafetyFeatureType;
  name: string;
  source: string;
  installedAt?: string;
  note?: string;
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
  sourceIds?: string[];
  adminDong?: string;
  roadClass?: string;
  widthMeters?: number;
  lanes?: number;
  pedestrianAccess?: PedestrianAccess;
  sidewalkWidthMeters?: number | null;
}

export interface RoadSegmentProperties extends RoadSegmentInputProperties {
  lengthMeters: number;
  /** 보안등 위치·거리 분포 기반 상대적 조명 환경(0~100). 실제 조도(lux)가 아니다. */
  lightingScore: number;
  lightingCoverage: number;
  maxDarkGapMeters: number;
  lightingUniformityScore: number;
  surveillanceScore: number;
  crimeScore: number | null;
  /** 상대적 주의도 산출에 쓴 WMS 샘플 수. 데이터가 없는 구간은 null. */
  crimeSampleCount: number | null;
  environmentScore: number;
  sidewalkContribution: number;
  safetyScore: number;
  streetlightCount: number;
  cctvCount: number;
  emergencyBellCount: number;
  convenienceStoreCount: number;
  cptedCount: number;
  oldBuildingCount: number;
  riskLevel: number;
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
