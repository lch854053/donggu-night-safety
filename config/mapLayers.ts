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
    key: "old_building",
    label: "노후건축물",
    description: "사용승인 후 30년 이상 경과한 건축물 표본",
    color: "#707b83",
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
    key: "planning_road",
    label: "도시계획 도로",
    description: "집행 상태 참고 · 안전지수 미반영",
    color: "#79568f",
    kind: "area",
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
  planning_road: false,
  // 좌표 데이터가 아직 수집되지 않은 타입. 데이터가 생기면 기본 표시로 바꾼다.
  night_activity: false,
  bus_stop: false,
  subway_entrance: false,
  vacant_house: false,
};

export const POINT_LAYER_KEYS = MAP_LAYER_DEFINITIONS.filter(
  (layer): layer is MapLayerDefinition & { key: SafetyFeatureType } => layer.kind === "point",
).map((layer) => layer.key);
