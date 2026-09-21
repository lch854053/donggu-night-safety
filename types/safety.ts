import type { FeatureCollection, LineString, Point, Polygon } from "geojson";

export type SafetyFeatureType =
  | "streetlight"
  | "cctv"
  | "emergency_bell"
  | "convenience_store"
  | "cpted"
  | "old_building";

export type LayerKey = SafetyFeatureType | "risk_zone";

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
  lightingScore: number;
  surveillanceScore: number;
  crimeScore: number | null;
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
