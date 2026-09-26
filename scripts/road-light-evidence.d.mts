export interface RoadLightCluster {
  clusterId: string;
  managedUnitCount: number;
  representativeCoordinate: [number, number];
  roadAddresses: string[];
  parcelAddresses: string[];
  roadAddressManagedUnitCount?: number;
  parcelAddressManagedUnitCount?: number;
  dataAsOf: string;
}
export interface RoadLightEvidenceOptions {
  corridorModel?: "C1" | "C2";
  fixedCorridorMeters?: number;
  strengthModel?: "A" | "B" | "C";
}
export function normalizeRoadName(text: string): string;
export function roadNameFromAddress(address: string): string;
export function corridorLength(managedUnitCount: number, model?: "C1" | "C2", fixedMeters?: number): number;
export function buildRoadLightingEvidence(
  clusters: RoadLightCluster[], roads: object, boundaries: object, options?: RoadLightEvidenceOptions,
): {
  roads: Record<string, {
    source: "road_light_api"; estimated: true; clusterIds: string[]; managedUnitCount: number;
    representativePointCount: number; matchedRecordCount: number; uniqueRepresentativePointCount: number;
    matchConfidence: number; matchMethod: "road_name_and_coordinate" | "road_name" | "parcel_and_coordinate";
    distanceFromAnchorMeters: number; corridorDistanceMeters: number; roadLightingEvidence: number;
    roadLightingMatchedMeters: number;
    roadLightingCoverageEstimated: number; roadLightingContinuity: number;
    roadLightingRunMeters: number; roadLightingClusterCount: number; roadLightingScore: number;
  }>;
  diagnostics: {
    clusterLinks: { clusterId: string; managedUnitCount: number; anchorRoadId: string; anchorMeters: number;
      corridorLengthMeters: number; linkedRoadCount: number; method: string }[];
    linkedRoadCount: number; [key: string]: any;
  };
};
