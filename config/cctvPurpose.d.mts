export type CctvPurpose = "crime_prevention" | "child_safety" | "unknown" | "waste" | "traffic" | "other";
export const CCTV_PURPOSE_CONFIDENCE: Readonly<Record<CctvPurpose, number>>;
export const CCTV_PURPOSE_LABELS: Readonly<Record<CctvPurpose, string>>;
export function classifyCctvPurpose(label: unknown): CctvPurpose;
