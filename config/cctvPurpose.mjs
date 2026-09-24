// 지수 산정용 상대적 감시 신뢰계수. 실제 범죄 감소율이 아니다.
export const CCTV_PURPOSE_CONFIDENCE = Object.freeze({
  crime_prevention: 1,
  child_safety: 0.9,
  unknown: 0.5,
  waste: 0.4,
  traffic: 0.3,
  other: 0.3,
});

export const CCTV_PURPOSE_LABELS = Object.freeze({
  crime_prevention: "생활방범",
  child_safety: "어린이보호",
  unknown: "확인되지 않음",
  waste: "쓰레기 불법투기 단속",
  traffic: "교통·차량 단속",
  other: "기타",
});

export function classifyCctvPurpose(label) {
  const text = String(label ?? "").replace(/\s+/g, "");
  if (!text) return "unknown";
  if (/어린이|학교주변/.test(text)) return "child_safety";
  if (/쓰레기|불법투기/.test(text)) return "waste";
  if (/교통|주정차|차량/.test(text)) return "traffic";
  if (/방범|범죄예방/.test(text)) return "crime_prevention";
  return "other";
}
