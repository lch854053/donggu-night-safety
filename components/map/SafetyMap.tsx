"use client";

import * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

import { MAP_LAYER_DEFINITIONS, POINT_LAYER_KEYS } from "@/config/mapLayers";
import { getSafetyBand, SAFETY_SCORE_BANDS } from "@/config/safetyWeights";
import type {
  LayerVisibility,
  RoadSegmentProperties,
  SafetyDataset,
  SafetyFeatureType,
  ScoredRoadSegments,
} from "@/types/safety";

const DONGGU_CENTER: [number, number] = [126.9232, 35.1461];
const [verySafeBand, safeBand, averageBand, cautionBand, highCautionBand] =
  SAFETY_SCORE_BANDS;

const BASEMAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    openStreetMap: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    {
      id: "open-street-map",
      type: "raster",
      source: "openStreetMap",
      minzoom: 0,
      maxzoom: 19,
    },
  ],
};

interface SafetyMapProps {
  data: SafetyDataset | null;
  roadSegments: ScoredRoadSegments | null;
  visibility: LayerVisibility;
}

function pointLayerId(type: SafetyFeatureType) {
  return `safety-${type}`;
}

function numericProperty(properties: Record<string, unknown>, key: keyof RoadSegmentProperties) {
  const value = Number(properties[key]);
  return Number.isFinite(value) ? value : 0;
}

function roadPopupContent(properties: Record<string, unknown>) {
  const content = document.createElement("article");
  content.className = "road-popup";

  const name = document.createElement("p");
  name.className = "road-popup-name";
  name.textContent = String(properties.name ?? "도로 구간");

  const label = document.createElement("p");
  label.className = "road-popup-label";
  label.textContent = "밤길 안전 참고지수";

  const score = numericProperty(properties, "safetyScore");
  const band = getSafetyBand(score);
  const scoreRow = document.createElement("div");
  scoreRow.className = "road-popup-score";
  scoreRow.innerHTML = `<strong>${score}</strong><span>/ 100</span>`;

  const badge = document.createElement("span");
  badge.className = "road-popup-band";
  badge.style.setProperty("--band-color", band.color);
  badge.textContent = band.label;
  scoreRow.append(badge);

  const metrics = document.createElement("dl");
  metrics.className = "road-popup-metrics";
  [
    ["보안등 수준", "lightingScore"],
    ["CCTV·비상벨 접근성", "surveillanceScore"],
    ["상대적 주의도", "crimeScore"],
    ["생활시설·주변 환경", "environmentScore"],
  ].forEach(([label, key]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = `${numericProperty(properties, key as keyof RoadSegmentProperties)}점`;
    row.append(term, detail);
    metrics.append(row);
  });

  const note = document.createElement("p");
  note.className = "road-popup-note";
  note.textContent = "여러 공간지표를 조합한 상대적 참고값입니다.";
  content.append(name, label, scoreRow, metrics, note);
  return content;
}

export function SafetyMap({ data, roadSegments, visibility }: SafetyMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [styleReady, setStyleReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    maplibregl.setWorkerUrl("/vendor/maplibre-gl-worker.mjs");
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_STYLE,
      center: DONGGU_CENTER,
      zoom: 14,
      minZoom: 11,
      maxZoom: 19,
      attributionControl: false,
    });

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.once("load", () => {
      if (mapRef.current === map) setStyleReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !data || !roadSegments) return;

    map.addSource("safety-features", { type: "geojson", data: data.features });
    map.addSource("risk-zones", { type: "geojson", data: data.riskZones });
    map.addSource("road-segments", { type: "geojson", data: roadSegments });

    map.addLayer({
      id: "risk-zone-fill",
      type: "fill",
      source: "risk-zones",
      paint: {
        "fill-color": [
          "match",
          ["get", "riskLevel"],
          5,
          "#b43c32",
          4,
          "#cf684c",
          3,
          "#dd9a5a",
          "#e9bd73",
        ],
        "fill-opacity": 0.2,
      },
    });
    map.addLayer({
      id: "risk-zone-line",
      type: "line",
      source: "risk-zones",
      paint: {
        "line-color": "#a84635",
        "line-width": 1.5,
        "line-dasharray": [3, 2],
        "line-opacity": 0.8,
      },
    });

    map.addLayer({
      id: "road-safety-casing",
      type: "line",
      source: "road-segments",
      paint: {
        "line-color": "#fffdf8",
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 5, 16, 11],
        "line-opacity": 0.95,
      },
    });
    map.addLayer({
      id: "road-safety",
      type: "line",
      source: "road-segments",
      paint: {
        "line-color": [
          "step",
          ["get", "safetyScore"],
          highCautionBand.color,
          cautionBand.min,
          cautionBand.color,
          averageBand.min,
          averageBand.color,
          safeBand.min,
          safeBand.color,
          verySafeBand.min,
          verySafeBand.color,
        ],
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3, 16, 7],
        "line-opacity": 0.94,
      },
    });

    POINT_LAYER_KEYS.forEach((type) => {
      const definition = MAP_LAYER_DEFINITIONS.find((layer) => layer.key === type);
      if (!definition) return;

      map.addLayer({
        id: pointLayerId(type),
        type: "circle",
        source: "safety-features",
        filter: ["==", ["get", "type"], type],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 4, 16, 7],
          "circle-color": definition.color,
          "circle-stroke-color": "#fffdf8",
          "circle-stroke-width": 1.5,
          "circle-opacity": type === "old_building" ? 0.72 : 0.94,
        },
      });
    });

    const showRoadDetails = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature?.properties) return;

      new maplibregl.Popup({ closeButton: true, offset: 10, maxWidth: "310px" })
        .setLngLat(event.lngLat)
        .setDOMContent(roadPopupContent(feature.properties))
        .addTo(map);
    };
    const showPointer = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const hidePointer = () => {
      map.getCanvas().style.cursor = "";
    };

    map.on("click", "road-safety", showRoadDetails);
    map.on("mouseenter", "road-safety", showPointer);
    map.on("mouseleave", "road-safety", hidePointer);

    return () => {
      map.off("click", "road-safety", showRoadDetails);
      map.off("mouseenter", "road-safety", showPointer);
      map.off("mouseleave", "road-safety", hidePointer);
      POINT_LAYER_KEYS.forEach((type) => {
        const id = pointLayerId(type);
        if (map.getLayer(id)) map.removeLayer(id);
      });
      ["road-safety", "road-safety-casing", "risk-zone-line", "risk-zone-fill"].forEach((id) => {
        if (map.getLayer(id)) map.removeLayer(id);
      });
      if (map.getSource("road-segments")) map.removeSource("road-segments");
      if (map.getSource("risk-zones")) map.removeSource("risk-zones");
      if (map.getSource("safety-features")) map.removeSource("safety-features");
    };
  }, [data, roadSegments, styleReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !data) return;

    POINT_LAYER_KEYS.forEach((type) => {
      const id = pointLayerId(type);
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", visibility[type] ? "visible" : "none");
      }
    });

    ["risk-zone-fill", "risk-zone-line"].forEach((id) => {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", visibility.risk_zone ? "visible" : "none");
      }
    });
  }, [data, styleReady, visibility]);

  return (
    <div className="map-region">
      <div ref={containerRef} className="map-canvas" aria-label="광주 동구 밤길 안심지도" />
      {!styleReady ? <div className="map-loading">지도를 불러오는 중입니다</div> : null}
    </div>
  );
}
