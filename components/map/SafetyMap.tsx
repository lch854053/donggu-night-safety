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
const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY?.trim();
const MAPTILER_STYLE_URL = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${encodeURIComponent(MAPTILER_KEY)}`
  : null;
const [verySafeBand, safeBand, averageBand, cautionBand, highCautionBand] =
  SAFETY_SCORE_BANDS;

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

/** v2 점수 필드는 null(미수집)이 허용된다. 0으로 표시하지 않는다. */
function nullableScore(properties: Record<string, unknown>, key: keyof RoadSegmentProperties) {
  const value = properties[key];
  return value === null || value === undefined ? null : Number(value);
}

// 팝업 하단 관찰 메시지 임계값. 데이터가 수집된 항목에서만 표시한다.
const SIGNAL_THRESHOLDS = {
  lightingCoverageGood: 60,
  cctvClose: 80,
  nightActivityLow: 40,
  vacancyPresent: 70,
} as const;

function roadPopupContent(properties: Record<string, unknown>) {
  const content = document.createElement("article");
  content.className = "road-popup";

  const name = document.createElement("p");
  name.className = "road-popup-name";
  name.textContent = String(properties.name ?? "도로 구간");

  const label = document.createElement("p");
  label.className = "road-popup-label";
  label.textContent = "밤길 참고지수 (v2)";

  const scoreV2 = nullableScore(properties, "safetyScoreV2");
  const scoreRow = document.createElement("div");
  scoreRow.className = "road-popup-score";
  scoreRow.innerHTML = scoreV2 === null
    ? `<span>데이터 없음</span>`
    : `<strong>${scoreV2}</strong><span>/ 100</span>`;

  if (scoreV2 !== null) {
    const band = getSafetyBand(scoreV2);
    const badge = document.createElement("span");
    badge.className = "road-popup-band";
    badge.style.setProperty("--band-color", band.color);
    badge.textContent = band.label;
    scoreRow.append(badge);
  }

  const metrics = document.createElement("dl");
  metrics.className = "road-popup-metrics";
  (
    [
      ["조명·가시성", "lightingScore", undefined],
      ["감시·긴급대응", "surveillanceScore", undefined],
      ["야간활동·자연감시", "activityScore", undefined],
      ["공간환경·방치도", "environmentScore", undefined],
      ["여성밤길 치안안전", "crimeScore", "미수집"],
    ] as const
  ).forEach(([label, key, nullText]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    const score = nullableScore(properties, key);
    term.textContent = label;
    detail.textContent = score === null
      ? nullText ?? "데이터 없음"
      : `${Math.round(score)}점`;
    row.append(term, detail);
    metrics.append(row);
  });

  // 관찰 메시지는 실제 수집된 데이터에서만 만든다. 없는 요소를 임의로 표시하지 않는다.
  const signals: string[] = [];
  if (numericProperty(properties, "lightingCoverage") >= SIGNAL_THRESHOLDS.lightingCoverageGood) {
    signals.push("✓ 조명 커버리지 양호");
  }
  const cctvScore = nullableScore(properties, "cctvScore");
  if (cctvScore !== null && cctvScore >= SIGNAL_THRESHOLDS.cctvClose) {
    signals.push("✓ CCTV 가까움");
  }
  const nightActivityScore = nullableScore(properties, "nightActivityScore");
  if (nightActivityScore !== null && nightActivityScore < SIGNAL_THRESHOLDS.nightActivityLow) {
    signals.push("△ 야간 개방시설 적음");
  }
  if (properties.pedestrianAccess === "no") {
    signals.push("△ 인도 없음");
  } else if (properties.pedestrianAccess === "partial") {
    signals.push("△ 인도 일부만 인접");
  }
  const vacancyScore = nullableScore(properties, "vacancyScore");
  if (vacancyScore !== null && vacancyScore < SIGNAL_THRESHOLDS.vacancyPresent) {
    signals.push("△ 주변 빈집 존재");
  }
  if (signals.length) {
    const signalList = document.createElement("ul");
    signalList.className = "road-popup-signals";
    for (const signal of signals) {
      const item = document.createElement("li");
      item.textContent = signal;
      signalList.append(item);
    }
    content.append(signalList);
  }

  const width = Number(properties.sidewalkWidthMeters);
  const sidewalkLabel = properties.pedestrianAccess === "yes"
    ? `인도 있음${width > 0 ? ` · 폭 약 ${width.toFixed(1)}m` : ""}`
    : properties.pedestrianAccess === "partial"
      ? "인도 일부 구간만 인접"
      : properties.pedestrianAccess === "no"
        ? "인도 없음"
        : "보행로 미검증";

  const note = document.createElement("p");
  note.className = "road-popup-note";
  note.textContent =
    `${numericProperty(properties, "lengthMeters")}m 구간 · ${String(properties.source ?? "")} · ${sidewalkLabel} · 기존 지수(v1) ${numericProperty(properties, "safetyScore")}`;

  const lightingNote = document.createElement("p");
  lightingNote.className = "road-popup-note";
  lightingNote.textContent =
    "※ 실제 조도(lux)가 아니라 보안등 위치와 거리 분포를 기반으로 계산한 상대적 추정값입니다.";
  content.append(name, label, scoreRow, metrics, note, lightingNote);
  if (nullableScore(properties, "crimeScore") !== null) {
    const crimeNote = document.createElement("p");
    crimeNote.className = "road-popup-note";
    crimeNote.textContent =
      "※ 여성밤길 치안안전은 생활안전지도의 경찰청 범죄 밀도분석(밤 시간대 20~24시) 구간 정보를 우선하고, 여성밤길 데이터가 없는 구간은 범죄주의구간(전체 시간대) 밀도분석으로 보완해 도로 주변에서 분석한 값입니다. 실제 범죄 발생 가능성을 예측하는 수치가 아닙니다.";
    content.append(crimeNote);
  }
  return content;
}

export function SafetyMap({ data, roadSegments, visibility }: SafetyMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [styleReady, setStyleReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(
    MAPTILER_STYLE_URL ? null : "Vercel 환경변수 NEXT_PUBLIC_MAPTILER_KEY를 설정해 주세요.",
  );

  useEffect(() => {
    if (!containerRef.current || mapRef.current || !MAPTILER_STYLE_URL) return;

    maplibregl.setWorkerUrl("/vendor/maplibre-gl-worker.mjs");
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAPTILER_STYLE_URL,
      center: DONGGU_CENTER,
      zoom: 14,
      minZoom: 11,
      maxZoom: 19,
      attributionControl: false,
    });

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    const handleInitialError = () => {
      setMapError("MapTiler 지도를 불러오지 못했습니다. API 키와 허용 도메인을 확인해 주세요.");
    };
    map.once("error", handleInitialError);
    map.once("load", () => {
      if (mapRef.current === map) {
        map.off("error", handleInitialError);
        setMapError(null);
        setStyleReady(true);
      }
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
    map.addSource("road-segments", {
      type: "geojson", data: roadSegments,
      attribution: '도로: 국토지리정보원 · 경계: <a href="https://sgis.kostat.go.kr">SGIS</a> / <a href="https://github.com/vuski/admdongkor">vuski/admdongkor</a> (CC BY 4.0)',
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
          // v2 참고지수 기준. 미수집(null) 구간은 최하값으로만 칠해지지 않도록 coalesce한다.
          ["coalesce", ["get", "safetyScoreV2"], 0],
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
      ["road-safety", "road-safety-casing"].forEach((id) => {
        if (map.getLayer(id)) map.removeLayer(id);
      });
      if (map.getSource("road-segments")) map.removeSource("road-segments");
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
  }, [data, styleReady, visibility]);

  return (
    <div className="map-region">
      <div ref={containerRef} className="map-canvas" aria-label="광주 동구 밤길 안심지도" />
      {mapError ? (
        <div className="map-loading map-error" role="alert">
          <strong>지도를 표시할 수 없습니다</strong>
          <span>{mapError}</span>
        </div>
      ) : !styleReady ? (
        <div className="map-loading" role="status">
          지도를 불러오는 중입니다
        </div>
      ) : null}
    </div>
  );
}
