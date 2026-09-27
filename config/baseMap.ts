import type { StyleSpecification } from "maplibre-gl";

// VersaTiles Gray uses OpenStreetMap Shortbread vector tiles (no API key).
// Replace this URL and the source attribution to switch providers; only the
// Shortbread pois symbols are kept as optional map context, separate from scoring.
export const BASEMAP_STYLE_URL = "https://tiles.versatiles.org/assets/styles/gray/style.json";
export const BASEMAP_ATTRIBUTION =
  '<a href="https://versatiles.org">VersaTiles</a> · <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> · <a href="https://esa-worldcover.org/en/data-access">ESA WorldCover (CC BY 4.0)</a>';

const BASEMAP_SOURCE = "versatiles-shortbread";
const FILL_SOURCE_LAYERS = new Set([
  "land", "ocean", "water_polygons", "buildings", "street_polygons", "bridges",
]);
const LINE_SOURCE_LAYERS = new Set(["water_lines", "streets", "boundaries"]);
const PLACE_CLASSES = [
  "city", "town", "village", "suburb", "neighbourhood", "quarter",
  "hamlet", "state", "country", "continent",
];

/** Match by source-layer, not by upstream layer IDs, which can change between styles. */
export function isOsmPoiLayer(layer: StyleSpecification["layers"][number]) {
  return layer.type === "symbol" && "source" in layer && layer.source === BASEMAP_SOURCE
    && "source-layer" in layer && layer["source-layer"] === "pois";
}

/** Muted geography plus OSM POIs; other third-party symbols stay out of the safety map. */
export function simplifyBaseMapStyle(style: StyleSpecification): StyleSpecification {
  const source = style.sources?.[BASEMAP_SOURCE];
  if (style.version !== 8 || source?.type !== "vector" || !Array.isArray(style.layers)) {
    throw new Error("베이스맵 스타일에 OSM 벡터 소스가 없습니다.");
  }

  const layers: StyleSpecification["layers"] = [];
  for (const layer of style.layers) {
    if (layer.type === "background" && layer.id === "background") {
      layers.push({ ...layer, paint: { ...layer.paint, "background-color": "#f4f2ed" } });
      continue;
    }
    if (!("source" in layer) || layer.source !== BASEMAP_SOURCE || !("source-layer" in layer)) continue;
    const sourceLayer = layer["source-layer"];
    if (!sourceLayer) continue;
    if (layer.type === "fill" && FILL_SOURCE_LAYERS.has(sourceLayer)) {
      const paint = { ...layer.paint };
      if (sourceLayer === "land") paint["fill-color"] = layer.id === "land-park" || layer.id === "land-forest"
        ? "#e6eee5" : "#eeece7";
      if (sourceLayer === "ocean" || sourceLayer === "water_polygons") paint["fill-color"] = "#deebee";
      if (sourceLayer === "buildings" && layer.id === "building") {
        paint["fill-color"] = "#e7e5e0";
        paint["fill-outline-color"] = "#d8d8d4";
        paint["fill-opacity"] = 0.9;
        paint["fill-translate"] = [0, 0];
      }
      if (sourceLayer === "buildings" && layer.id !== "building") continue;
      if (sourceLayer === "street_polygons" || sourceLayer === "bridges") paint["fill-color"] = "#faf9f6";
      layers.push({ ...layer, paint });
      continue;
    }
    if (layer.type === "line" && LINE_SOURCE_LAYERS.has(sourceLayer)) {
      const paint = { ...layer.paint };
      if (sourceLayer === "streets") {
        paint["line-color"] = layer.id.endsWith(":outline") ? "#dcdedb" : "#faf9f6";
        paint["line-width"] = ["interpolate", ["linear"], ["zoom"], 11, 0.7, 14, 2, 16, 3, 19, 7];
      }
      if (sourceLayer === "water_lines") paint["line-color"] = "#cddfe4";
      if (sourceLayer === "boundaries") paint["line-color"] = "#d9d8d2";
      layers.push({ ...layer, paint });
      continue;
    }
    if (layer.type === "symbol" && isOsmPoiLayer(layer)) {
      layers.push({ ...layer,
        layout: { ...layer.layout,
          "text-size": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, 9, 17, 11, 19, 12] },
        paint: { ...layer.paint,
          "icon-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0.45, 16, 0.55, 18, 0.65],
          "text-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, 0.45, 17, 0.65],
          "text-color": "#5b625f", "text-halo-color": "#f4f2ed", "text-halo-width": 1.2 },
      });
      continue;
    }
    if (layer.type === "symbol" && sourceLayer === "place_labels") {
      layers.push({
        ...layer,
        filter: ["all", ...(layer.filter ? [layer.filter] : []),
          ["match", ["get", "kind"], PLACE_CLASSES, true, false]] as typeof layer.filter,
        layout: {
          ...layer.layout,
          "icon-image": "",
          "text-field": ["coalesce", ["get", "name_ko"], ["get", "name"]],
        },
        paint: { ...layer.paint, "text-color": "#737b78", "text-halo-color": "#f4f2ed" },
      });
    }
  }

  if (!layers.some((layer) => layer.type === "fill" && layer.id === "building")
    || !layers.some((layer) => layer.type === "line" && "source-layer" in layer
      && layer["source-layer"] === "streets")) {
    throw new Error("베이스맵의 건물 또는 도로 레이어가 없습니다.");
  }

  const { sky: _sky, projection: _projection, ...flatStyle } = style;
  return {
    ...flatStyle,
    sprite: layers.some(isOsmPoiLayer) ? style.sprite : undefined,
    sources: { [BASEMAP_SOURCE]: { ...source, attribution: BASEMAP_ATTRIBUTION } },
    layers,
  };
}

export async function loadBaseMapStyle(): Promise<StyleSpecification> {
  const response = await fetch(BASEMAP_STYLE_URL, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`베이스맵 스타일 HTTP ${response.status}`);
  return simplifyBaseMapStyle(await response.json() as StyleSpecification);
}
