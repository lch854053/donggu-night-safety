import type { LayerKey, LayerVisibility, SafetyFeatureType } from "@/types/safety";

export interface MapLayerDefinition {
  key: LayerKey;
  label: string;
  description: string;
  color: string;
  kind: "point" | "area";
}

export const MAP_LAYER_DEFINITIONS: readonly MapLayerDefinition[] = [
  {
    key: "streetlight",
    label: "보안등",
    description: "야간 보행로 조명 시설",
    color: "#e5a617",
    kind: "point",
  },
  {
    key: "cctv",
    label: "방범 CCTV",
    description: "생활방범 목적의 영상정보처리기기",
    color: "#255c99",
    kind: "point",
  },
  {
    key: "cpted",
    label: "CPTED 시설",
    description: "범죄예방 환경설계 적용 시설",
    color: "#087f8c",
    kind: "point",
  },
  {
    key: "convenience_store",
    label: "편의점",
    description: "야간 이용 가능한 생활시설",
    color: "#358f64",
    kind: "point",
  },
  {
    key: "emergency_bell",
    label: "비상벨",
    description: "긴급상황 신고 지원 시설",
    color: "#d97706",
    kind: "point",
  },
  {
    key: "old_building",
    label: "노후건축물",
    description: "사용승인 후 30년 이상 경과한 건축물 표본",
    color: "#707b83",
    kind: "point",
  },
  {
    key: "police_station",
    label: "경찰시설",
    description: "경찰서·지구대·파출소",
    color: "#1f4e79",
    kind: "point",
  },
  {
    key: "night_activity",
    label: "야간 운영시설",
    description: "OSM 영업시간 기반 심야 생활시설",
    color: "#6d28d9",
    kind: "point",
  },
] as const;

/**
 * 야간 운영시설 점 색상 구분. nightTier 속성 기준.
 * 미확인(영업시간 미기재)은 회색 — 영업 안 함과 다르게 취급한다.
 */
export const NIGHT_ACTIVITY_TIERS = [
  { tier: "24h", label: "24시간 운영", color: "#6d28d9" },
  { tier: "02", label: "02시 이후 운영", color: "#8b5cf6" },
  { tier: "00", label: "00시 이후 운영", color: "#a78bfa" },
  { tier: "22", label: "22시 이후 운영", color: "#c4b5fd" },
  { tier: "unknown", label: "영업시간 미확인", color: "#94a3b8" },
] as const satisfies readonly { tier: string; label: string; color: string }[];

export const NIGHT_ACTIVITY_CATEGORY_LABELS: Record<string, string> = {
  convenience_store: "편의점",
  supermarket: "슈퍼마켓",
  restaurant: "음식점",
  cafe: "카페",
  fast_food: "패스트푸드",
  pharmacy: "약국",
  hospital: "병원",
};

export const INITIAL_LAYER_VISIBILITY: LayerVisibility = {
  streetlight: true,
  cctv: true,
  emergency_bell: true,
  convenience_store: true,
  cpted: true,
  old_building: false,
  police_station: true,
  // 야간 운영시설은 점이 많아(음식점·카페 포함) 기본 표시는 끈다. 필요 시 켜서 확인.
  night_activity: false,
  bus_stop: false,
  subway_entrance: false,
  vacant_house: false,
};

export const POINT_LAYER_KEYS = MAP_LAYER_DEFINITIONS.filter(
  (layer): layer is MapLayerDefinition & { key: SafetyFeatureType } => layer.kind === "point",
).map((layer) => layer.key);
