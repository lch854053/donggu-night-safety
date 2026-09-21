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
    key: "risk_zone",
    label: "상대적 주의구간",
    description: "여러 지표로 표현한 비교용 주의 범위",
    color: "#c85d43",
    kind: "area",
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
] as const;

export const INITIAL_LAYER_VISIBILITY: LayerVisibility = {
  streetlight: true,
  cctv: true,
  emergency_bell: true,
  convenience_store: true,
  cpted: true,
  old_building: false,
  risk_zone: true,
  // WMS 원본 오버레이는 시각 참고용이라 기본 꺼짐 — 지도 성능 유지.
  crime_overlay: false,
};

export const POINT_LAYER_KEYS = MAP_LAYER_DEFINITIONS.filter(
  (layer): layer is MapLayerDefinition & { key: SafetyFeatureType } => layer.kind === "point",
).map((layer) => layer.key);
