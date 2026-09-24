import type { Feature, Point } from "geojson";
import type { SafetyFeatureProperties } from "../types/safety";
export const CCTV_DATASET: string;
export const CCTV_APIS: { current: string; historical: string };
export function fetchCctvSnapshot(path: string, key: string, request?: typeof fetch): Promise<Record<string, unknown>[]>;
export function normalizeCctvAddress(address: string | null | undefined): string;
export function buildMunicipalCctv(
  rows: Record<string, unknown>[], historicalRows: Record<string, unknown>[],
  boundaries: object[], legacyFeatures?: Feature<Point, SafetyFeatureProperties>[],
): { features: Feature<Point, SafetyFeatureProperties>[]; stats: {
  sourceRows: number; validCoordinateRows: number; uniqueLocations: number; includedLocations: number;
  excludedInvalidCoordinate: number; excludedOutsideBoundary: number; excludedAddressCoordinateMismatch: number;
  excludedDuplicateRows: number; purposeCounts: Record<string, number>; historicalPurposeMatches: number;
} };
