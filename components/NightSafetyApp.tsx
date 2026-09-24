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
  PlanningRoads,
  SafetyDataset,
  ScoredRoadSegments,
} from "@/types/safety";

export function NightSafetyApp() {
  const [data, setData] = useState<SafetyDataset | null>(null);
  const [roadSegments, setRoadSegments] = useState<ScoredRoadSegments | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<LayerVisibility>(INITIAL_LAYER_VISIBILITY);
  const [selectedRoadId, setSelectedRoadId] = useState("");
  const [planningRoads, setPlanningRoads] = useState<PlanningRoads | null>(null);
  const [planningError, setPlanningError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!visibility.planning_road || planningRoads) return;
    const controller = new AbortController();
    setPlanningError(null);
    fetch("/data/planning-roads.geojson", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("도시계획 도로 자료를 불러오지 못했습니다.");
        return response.json() as Promise<PlanningRoads>;
      })
      .then((collection) => {
        if (collection.type !== "FeatureCollection" || !collection.features.length) {
          throw new Error("도시계획 도로 자료가 비어 있습니다.");
        }
        setPlanningRoads(collection);
        setPlanningError(null);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setPlanningError(reason instanceof Error ? reason.message : "도시계획 도로 자료를 불러오지 못했습니다.");
        }
      });
    return () => controller.abort();
  }, [visibility.planning_road, planningRoads]);

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
        planningRoads={planningRoads}
        planningError={planningError}
      />
      <SafetyMap
        data={data}
        roadSegments={roadSegments}
        visibility={visibility}
        planningRoads={planningRoads}
      />
    </main>
  );
}
