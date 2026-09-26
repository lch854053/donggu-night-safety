import type { FeatureCollection, LineString, Point, Polygon } from "geojson";

import type { SafetyDataSource } from "@/lib/data/SafetyDataSource";
import { validateScoredRoads } from "@/lib/data/validateScoredRoads";
import type {
  RiskZoneProperties,
  ScoredRoadFile,
  SafetyDataset,
  SafetyFeatureProperties,
} from "@/types/safety";

interface DataMeta {
  generatedAt?: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${url} 데이터를 불러오지 못했습니다.`);
  }

  return response.json() as Promise<T>;
}

// scripts/fetch-real-data.mjs가 생성한 정적 공공데이터 GeoJSON을 읽는 공급자.
export class StaticSafetyDataSource implements SafetyDataSource {
  async load(): Promise<SafetyDataset> {
    const [features, riskZones, roadSegments, meta, roadLightCorridors] = await Promise.all([
      fetchJson<FeatureCollection<Point, SafetyFeatureProperties>>(
        "/data/safety-features.geojson",
      ),
      fetchJson<FeatureCollection<Polygon | LineString, RiskZoneProperties>>(
        "/data/risk-zones.geojson",
      ),
      fetchJson<ScoredRoadFile>(
        "/data/road-segments.geojson",
      ),
      fetchJson<DataMeta>("/data/meta.json").catch(() => ({}) as DataMeta),
      fetchJson<NonNullable<SafetyDataset["roadLightCorridors"]>>(
        "/data/road-light-corridors.geojson",
      ),
    ]);

    return {
      features,
      riskZones,
      roadSegments: validateScoredRoads(roadSegments),
      roadLightCorridors,
      metadata: {
        sourceKind: "static",
        scoreKind: "precomputed",
        updatedAt: meta.generatedAt ?? "",
      },
    };
  }
}
