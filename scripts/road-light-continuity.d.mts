import type { FeatureCollection, LineString } from "geojson";
export interface ScoredRoadLightingEvidence {
  roadLightingEvidence: number;
  roadLightingMatchedMeters: number;
  matchConfidence: number;
  clusterIds: string[];
  roadLightingCoverageEstimated?: number;
  roadLightingContinuity?: number;
  roadLightingRunMeters?: number;
  roadLightingClusterCount?: number;
  roadLightingScore?: number;
}
export function addRoadLightingScores<T extends { roads: Record<string, ScoredRoadLightingEvidence> }>(
  evidence: T, roads: FeatureCollection<LineString>,
): T;
