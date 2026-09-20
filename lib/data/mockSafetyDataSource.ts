import type { FeatureCollection, LineString, Point, Polygon } from "geojson";

import type { SafetyDataSource } from "@/lib/data/SafetyDataSource";
import type {
  RiskZoneProperties,
  RoadSegmentInputProperties,
  SafetyDataset,
  SafetyFeatureProperties,
} from "@/types/safety";

async function fetchGeoJson<T>(url: string): Promise<T> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${url} 데이터를 불러오지 못했습니다.`);
  }

  return response.json() as Promise<T>;
}

export class MockSafetyDataSource implements SafetyDataSource {
  async load(): Promise<SafetyDataset> {
    const [features, riskZones, roadSegments] = await Promise.all([
      fetchGeoJson<FeatureCollection<Point, SafetyFeatureProperties>>(
        "/data/safety-features.geojson",
      ),
      fetchGeoJson<FeatureCollection<Polygon | LineString, RiskZoneProperties>>(
        "/data/risk-zones.geojson",
      ),
      fetchGeoJson<FeatureCollection<LineString, RoadSegmentInputProperties>>(
        "/data/road-segments.geojson",
      ),
    ]);

    return {
      features,
      riskZones,
      roadSegments,
      metadata: {
        sourceKind: "mock",
        scoreKind: "client",
        updatedAt: "2026-09-20",
      },
    };
  }
}
