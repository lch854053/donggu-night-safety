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
  const grade = document.createElement("p");
  grade.className = "road-popup-note";
  grade.textContent = properties.planningRoadGrade
    ? `계획상 도로 종류: ${String(properties.planningRoadName ?? properties.planningRoadGrade)} · ${String(properties.planningRoadStatus ?? "미확인")}${properties.planningRoadStatus === "집행완료" ? " (야간활동·자연감시의 도로 proxy에 반영)" : " (종류 점수 미반영)"}`
    : "계획상 도로 종류: 확인 불가 (폭원만 반영)";
  content.append(grade);
  if (properties.roadNameSource === "LT_L_SPRD") {
    const nameSource = document.createElement("p");
    nameSource.className = "road-popup-note";
    nameSource.textContent = "도로명주소 도로와 위치가 일치해 보강한 도로명입니다.";
    content.append(nameSource);
  }
  if (nullableScore(properties, "crimeScore") !== null) {
    const crimeNote = document.createElement("p");
    crimeNote.className = "road-popup-note";
    crimeNote.textContent =
      "※ 여성밤길 치안안전은 생활안전지도의 경찰청 범죄 밀도분석(밤 시간대 20~24시) 구간 정보를 우선하고, 여성밤길 데이터가 없는 구간은 범죄주의구간(전체 시간대) 밀도분석으로 보완해 도로 주변에서 분석한 값입니다. 실제 범죄 발생 가능성을 예측하는 수치가 아닙니다.";
    content.append(crimeNote);
  }
  return content;
}

function policePopupContent(properties: Record<string, unknown>) {
  const content = document.createElement("article");
  content.className = "road-popup";
  const name = document.createElement("p");
  name.className = "road-popup-name";
  name.textContent = String(properties.name ?? "경찰시설");
  const address = document.createElement("p");
  address.className = "road-popup-note";
  address.textContent = String(properties.address ?? "");
  const source = document.createElement("p");
  source.className = "road-popup-note";
  source.textContent = "출처: 경찰청 · 주소 기준 2025.12.31";
  content.append(name, address, source);
  return content;
}

function busStopPopupContent(properties: Record<string, unknown>) {
  const content = document.createElement("article");
  content.className = "road-popup";
  const name = document.createElement("p");
  name.className = "road-popup-name";
  name.textContent = String(properties.name ?? "버스정류장");
  const stop = document.createElement("p");
  stop.className = "road-popup-note";
  stop.textContent = `정류장 ${String(properties.arsNumber ?? properties.nodeId ?? "번호 미확인")}${properties.inDonggu === false ? " · 동구 인접" : ""}`;
  content.append(name, stop);

  if (properties.nightRidershipPeriod) {
    const title = document.createElement("p");
    title.className = "road-popup-label";
    title.textContent = "20–23시 승하차 · 하루 평균 거래건수";
    const list = document.createElement("dl");
    list.className = "road-popup-metrics";
    for (const [label, boardingKey, alightingKey] of [
      ["평일", "nightWeekdayBoarding", "nightWeekdayAlighting"],
      ["주말", "nightWeekendBoarding", "nightWeekendAlighting"],
    ]) {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = label;
      const value = document.createElement("dd");
      value.textContent = `승차 ${Number(properties[boardingKey]).toLocaleString("ko-KR")} · 하차 ${Number(properties[alightingKey]).toLocaleString("ko-KR")}`;
      row.append(term, value);
      list.append(row);
    }
    const note = document.createElement("p");
    note.className = "road-popup-note";
    note.textContent = `자료: ${String(properties.nightRidershipPeriod)} · 환승 제외. 주변 보행량이나 안전도를 뜻하지 않습니다.`;
    content.append(title, list, note);
  } else {
    const note = document.createElement("p");
    note.className = "road-popup-note";
    note.textContent = "해당 정류장과 일치하는 승하차 자료가 없습니다.";
    content.append(note);
  }
  const source = document.createElement("p");
  source.className = "road-popup-note";
  source.textContent = "정류장 위치: 국토교통부 TAGO";
  content.append(source);
  return content;
}

function cctvPopupContent(properties: Record<string, unknown>) {
  const content = document.createElement("article");
  content.className = "road-popup";
  const name = document.createElement("p");
  name.className = "road-popup-name";
  name.textContent = String(properties.name ?? "CCTV");
  const purpose = document.createElement("p");
  purpose.className = "road-popup-note";
  purpose.textContent = `설치목적: ${String(properties.purposeLabel ?? "확인되지 않음")}`;
  const confidence = Number(properties.confidence);
  const contribution = document.createElement("p");
  contribution.className = "road-popup-note";
  contribution.textContent = `상대적 감시 기여도: ${confidence >= 0.9 ? "높음" : confidence >= 0.5 ? "보통" : "제한적"}`;
  content.append(name, purpose, contribution);
  if (properties.address) {
    const address = document.createElement("p");
    address.className = "road-popup-note";
    address.textContent = String(properties.address);
    content.append(address);
  }
  if (Number(properties.cameraCount) > 0) {
    const count = document.createElement("p");
    count.className = "road-popup-note";
    count.textContent = `카메라 수: ${properties.cameraCount}`;
    content.append(count);
  }
  const note = document.createElement("p");
  note.className = "road-popup-note";
  note.textContent = properties.purpose === "unknown"
    ? "최신 위치 자료에는 설치목적이 없어 안전지수에 제한적으로 반영됩니다."
    : properties.purpose === "waste"
      ? "방범 전용 CCTV는 아니므로 감시·긴급대응 점수에 제한적으로 반영됩니다."
      : properties.purposeSource === "historical"
        ? "설치목적은 과거 동일 주소 자료를 참고했으며 현재 운영 목적은 확인되지 않았습니다."
        : "설치목적별 기여도는 지수 산정용 보정값입니다.";
  content.append(note);
  if (properties.purposeSource === "historical" && properties.purpose === "waste") {
    const source = document.createElement("p");
    source.className = "road-popup-note";
    source.textContent = "설치목적은 과거 동일 주소 자료를 참고했으며 현재 운영 목적은 확인되지 않았습니다.";
    content.append(source);
  }
  if (properties.sourceYear) {
    const date = document.createElement("p");
    date.className = "road-popup-note";
    date.textContent = `자료기준: ${properties.sourceYear}.06.30`;
    content.append(date);
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
        filter: type === "police_station"
          ? ["in", ["get", "type"], ["literal", ["police_station", "police_center"]]]
          : ["==", ["get", "type"], type],
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

    const policeLayer = pointLayerId("police_station");
    const showPoliceDetails = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature?.properties) return;
      new maplibregl.Popup({ closeButton: true, offset: 10, maxWidth: "310px" })
        .setLngLat(event.lngLat)
        .setDOMContent(policePopupContent(feature.properties))
        .addTo(map);
    };
    map.on("click", policeLayer, showPoliceDetails);
    map.on("mouseenter", policeLayer, showPointer);
    map.on("mouseleave", policeLayer, hidePointer);
    const cctvLayer = pointLayerId("cctv");
    const showCctvDetails = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature?.properties) return;
      new maplibregl.Popup({ closeButton: true, offset: 10, maxWidth: "310px" })
        .setLngLat(event.lngLat)
        .setDOMContent(cctvPopupContent(feature.properties))
        .addTo(map);
    };
    map.on("click", cctvLayer, showCctvDetails);
    map.on("mouseenter", cctvLayer, showPointer);
    map.on("mouseleave", cctvLayer, hidePointer);
    const busLayer = pointLayerId("bus_stop");
    const showBusDetails = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature?.properties) return;
      new maplibregl.Popup({ closeButton: true, offset: 10, maxWidth: "310px" })
        .setLngLat(event.lngLat)
        .setDOMContent(busStopPopupContent(feature.properties))
        .addTo(map);
    };
    map.on("click", busLayer, showBusDetails);
    map.on("mouseenter", busLayer, showPointer);
    map.on("mouseleave", busLayer, hidePointer);

    return () => {
      map.off("click", "road-safety", showRoadDetails);
      map.off("mouseenter", "road-safety", showPointer);
      map.off("mouseleave", "road-safety", hidePointer);
      map.off("click", policeLayer, showPoliceDetails);
      map.off("mouseenter", policeLayer, showPointer);
      map.off("mouseleave", policeLayer, hidePointer);
      map.off("click", cctvLayer, showCctvDetails);
      map.off("mouseenter", cctvLayer, showPointer);
      map.off("mouseleave", cctvLayer, hidePointer);
      map.off("click", busLayer, showBusDetails);
      map.off("mouseenter", busLayer, showPointer);
      map.off("mouseleave", busLayer, hidePointer);
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
