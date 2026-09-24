"use client";

import { useEffect, useState } from "react";

import { SafetyMap } from "@/components/map/SafetyMap";
import { LayerPanel } from "@/components/panel/LayerPanel";
import { INITIAL_LAYER_VISIBILITY } from "@/config/mapLayers";
import { getSafetyDataSource } from "@/lib/data";
import { calculateRoadSafety } from "@/lib/scoring/calculateRoadSafety";
import type {
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
      />
    </main>
  );
}
