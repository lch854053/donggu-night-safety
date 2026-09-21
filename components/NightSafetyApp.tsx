"use client";

import { useEffect, useState } from "react";

import { SafetyMap } from "@/components/map/SafetyMap";
import { LayerPanel } from "@/components/panel/LayerPanel";
import { INITIAL_LAYER_VISIBILITY } from "@/config/mapLayers";
import { getSafetyDataSource } from "@/lib/data";
import { calculateRoadSafety } from "@/lib/scoring/calculateRoadSafety";
import type {
  CrimeOverlayInfo,
  LayerKey,
  LayerVisibility,
  SafetyDataset,
  ScoredRoadSegments,
} from "@/types/safety";

export function NightSafetyApp() {
  const [data, setData] = useState<SafetyDataset | null>(null);
  const [roadSegments, setRoadSegments] = useState<ScoredRoadSegments | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<LayerVisibility>(INITIAL_LAYER_VISIBILITY);
  const [selectedRoadId, setSelectedRoadId] = useState("");
  const [crimeOverlay, setCrimeOverlay] = useState<CrimeOverlayInfo | null>(null);

  useEffect(() => {
    let active = true;

    async function loadSafetyData() {
      try {
        const dataset = await getSafetyDataSource().load();
        const scoredRoadSegments =
          dataset.metadata.scoreKind === "precomputed"
            ? (dataset.roadSegments as ScoredRoadSegments)
            : calculateRoadSafety(dataset);

        if (active) {
          setData(dataset);
          setRoadSegments(scoredRoadSegments);
          setSelectedRoadId(scoredRoadSegments.features[0]?.properties.id ?? "");
        }
      } catch (reason: unknown) {
        if (active) {
          setError(reason instanceof Error ? reason.message : "지도 데이터를 불러오지 못했습니다.");
        }
      }
    }

    void loadSafetyData();

    return () => {
      active = false;
    };
  }, []);

  const toggleLayer = (key: LayerKey) => {
    // WMS 오버레이 이미지는 켤 때 한 번만 내려받는다(지도 초기 성능 보호).
    if (key === "crime_overlay" && !visibility.crime_overlay && !crimeOverlay) {
      void fetch("/data/crime-risk.json")
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
        .then((payload) => {
          if (payload?.overlay?.url && payload.overlay.coordinates?.length === 4) {
            setCrimeOverlay(payload.overlay);
          }
        })
        .catch(() => {
          // 시각 참고용이라 실패해도 지도·점수는 영향받지 않는다.
        });
    }
    setVisibility((current) => ({ ...current, [key]: !current[key] }));
  };

  return (
    <main className="relative h-dvh w-screen overflow-hidden bg-[#e7e1d5]">
      <LayerPanel
        visibility={visibility}
        data={data}
        error={error}
        roadSegments={roadSegments}
        selectedRoadId={selectedRoadId}
        onRoadSelect={setSelectedRoadId}
        onToggle={toggleLayer}
      />
      <SafetyMap
        data={data}
        roadSegments={roadSegments}
        visibility={visibility}
        crimeOverlay={crimeOverlay}
      />
    </main>
  );
}
