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
    label: "CCTV",
    description: "설치 목적에 따라 감시 기여도 보정",
    color: "#255c99",
    kind: "point",
  },
  {
    key: "cpted",
    label: "CPTED 사업지",
    description: "환경개선 완료 사업지(주소 대표점)",
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
    key: "vacant_house",
    label: "빈집",
    description: "동구 빈집 현황 (2025년 기준)",
    color: "#9b4c8b",
    kind: "point",
  },
  {
    key: "police_station",
    label: "지구대·파출소·치안센터",
    description: "경찰청 치안시설 주소 (2025.12 기준)",
    color: "#1f4e79",
    kind: "point",
  },
  {
    key: "bus_stop",
    label: "버스정류장",
    description: "TAGO 정류장 위치 · 2026년 4–6월 야간 승하차",
    color: "#6258a5",
    kind: "point",
  },
] as const;

export const INITIAL_LAYER_VISIBILITY: LayerVisibility = {
  streetlight: true,
  cctv: true,
  emergency_bell: true,
  convenience_store: true,
  cpted: true,
  old_building: false,
  police_station: true,
  // 좌표 데이터가 아직 수집되지 않은 타입. 데이터가 생기면 기본 표시로 바꾼다.
  night_activity: false,
  bus_stop: true,
  subway_entrance: false,
  vacant_house: true,
};

export const POINT_LAYER_KEYS = MAP_LAYER_DEFINITIONS.filter(
  (layer): layer is MapLayerDefinition & { key: SafetyFeatureType } => layer.kind === "point",
).map((layer) => layer.key);
