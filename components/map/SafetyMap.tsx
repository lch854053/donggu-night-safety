"use client";

import * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

import { MAP_LAYER_DEFINITIONS, NIGHT_ACTIVITY_CATEGORY_LABELS, NIGHT_ACTIVITY_TIERS, POINT_LAYER_KEYS } from "@/config/mapLayers";
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

/** 야간 운영시설 점 색상: nightTier별 구분. 미확인은 영업 안 함이 아니라 회색으로 구분한다. */
const NIGHT_TIER_COLOR = [
  "match",
  ["get", "nightTier"],
  ...NIGHT_ACTIVITY_TIERS.flatMap(({ tier, color }) => [tier, color]),
  "#94a3b8",
] as unknown as maplibregl.ExpressionSpecification;

const NIGHT_ACTIVITY_LAYER_FILTER: maplibregl.FilterSpecification = [
  "all",
  ["==", ["get", "type"], "night_activity"],
  // 주간 전용 시설(nightScore 0)은 야간 지도에서 소음이라 표시하지 않는다(데이터 파일에는 유지).
  ["!=", ["get", "nightScore"], 0],
];

const nightTierLabel = (tier: unknown) =>
  NIGHT_ACTIVITY_TIERS.find(({ tier: t }) => t === tier)?.label ?? "영업시간 미확인";

function facilityPopupContent(properties: Record<string, unknown>) {
  const content = document.createElement("article");
  content.className = "road-popup";

  const name = document.createElement("p");
  name.className = "road-popup-name";
  name.textContent = String(properties.name ?? "시설");

  const label = document.createElement("p");
  label.className = "road-popup-label";
  label.textContent = `야간 운영시설 · ${NIGHT_ACTIVITY_CATEGORY_LABELS[String(properties.category)] ?? String(properties.category ?? "시설")}`;

  const tier = document.createElement("div");
  tier.className = "road-popup-score";
  const tierColor = NIGHT_ACTIVITY_TIERS.find(({ tier: t }) => t === properties.nightTier)?.color ?? "#94a3b8";
  tier.innerHTML = `<span style="--band-color:${tierColor}" class="road-popup-band">●</span><strong>${nightTierLabel(properties.nightTier)}</strong>`;

  const hours = document.createElement("dl");
  hours.className = "road-popup-metrics";
  (
    [
      ["영업시간", properties.openingHours ? String(properties.openingHours) : "미확인"],
      ["신뢰도", properties.confidence != null ? `${Math.round(Number(properties.confidence) * 100)}%` : "-"],
    ] as const
  ).forEach(([term, detail]) => {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = detail;
    row.append(dt, dd);
    hours.append(row);
  });

  const note = document.createElement("p");
  note.className = "road-popup-note";
  note.textContent = `출처: OpenStreetMap · 영업시간은 공개데이터 기준이며 실제 영업 여부와 다를 수 있습니다.`;

  content.append(name, label, tier, hours, note);
  return content;
}

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
      ["범죄 상대주의도", "crimeScore", "미수집"],
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
      "※ 상대적 주의도는 생활안전지도에서 제공하는 경찰청 범죄 밀도분석 기반 구간 정보를 도로 주변에서 분석한 값이며, 실제 범죄 발생 가능성을 예측하는 수치가 아닙니다.";
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
      const isNightActivity = type === "night_activity";

      map.addLayer({
        id: pointLayerId(type),
        type: "circle",
        source: "safety-features",
        filter: isNightActivity
          ? NIGHT_ACTIVITY_LAYER_FILTER
          : ["==", ["get", "type"], type],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 4, 16, 7],
          "circle-color": isNightActivity ? NIGHT_TIER_COLOR : definition.color,
          "circle-stroke-color": "#fffdf8",
          "circle-stroke-width": 1.5,
          "circle-opacity": type === "old_building" ? 0.72 : 0.94,
        },
      });
    });

    // 시설 점이 도로 위에 겹치므로 시설 클릭이면 도로 팝업은 열지 않는다.
    // (레이어가 숨겨져 있으면 queryRenderedFeatures가 비어 도로 팝업이 그대로 동작한다.)
    const showRoadDetails = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature?.properties) return;
      if (map.getLayer(pointLayerId("night_activity")) &&
          map.queryRenderedFeatures(event.point, { layers: [pointLayerId("night_activity")] }).length) {
        return;
      }

      new maplibregl.Popup({ closeButton: true, offset: 10, maxWidth: "310px" })
        .setLngLat(event.lngLat)
        .setDOMContent(roadPopupContent(feature.properties))
        .addTo(map);
    };

    const showFacilityDetails = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature?.properties) return;
      new maplibregl.Popup({ closeButton: true, offset: 10, maxWidth: "310px" })
        .setLngLat(event.lngLat)
        .setDOMContent(facilityPopupContent(feature.properties))
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
    map.on("click", pointLayerId("night_activity"), showFacilityDetails);
    map.on("mouseenter", pointLayerId("night_activity"), showPointer);
    map.on("mouseleave", pointLayerId("night_activity"), hidePointer);

    return () => {
      map.off("click", "road-safety", showRoadDetails);
      map.off("mouseenter", "road-safety", showPointer);
      map.off("mouseleave", "road-safety", hidePointer);
      map.off("click", pointLayerId("night_activity"), showFacilityDetails);
      map.off("mouseenter", pointLayerId("night_activity"), showPointer);
      map.off("mouseleave", pointLayerId("night_activity"), hidePointer);
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
