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

// scripts/fetch-real-data.mjs·fetch-night-facilities.mjs가 생성한 정적 공공데이터 GeoJSON을 읽는 공급자.
export class StaticSafetyDataSource implements SafetyDataSource {
  async load(): Promise<SafetyDataset> {
    const [features, riskZones, roadSegments, meta] = await Promise.all([
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
    ]);
    // 야간 운영시설은 선택적 데이터. 없으면 기존 데이터만으로 그대로 동작한다.
    const nightFacilities = await fetchJson<FeatureCollection<Point, SafetyFeatureProperties>>(
      "/data/night-facilities.geojson",
    ).catch(() => null);
    if (nightFacilities?.features.length) {
      features.features.push(...nightFacilities.features);
    }

    return {
      features,
      riskZones,
      roadSegments: validateScoredRoads(roadSegments),
      metadata: {
        sourceKind: "static",
        scoreKind: "precomputed",
        updatedAt: meta.generatedAt ?? "",
      },
    };
  }
}
