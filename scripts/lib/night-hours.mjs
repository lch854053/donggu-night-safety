// OSM opening_hours 문자열을 야간 운영 수준으로 환산한다.
// 문자열 비교 대신 opening_hours.js(검증된 파서)로 KST 대표 주 7일을 실제로 평가한다.
//
// 판정 기준(주간 대표값):
//   - 체크 시각 22:00·00:00·02:00·04:00에 영업 중인 "일수"를 센다(요일별 차이 반영).
//   - 주 4일 이상 → 해당 시간대 운영으로 인정한다. 한국 상가는 주 7일 영업이 기본이고
//     요일별 차이는 대개 주 1일 휴무라 4일(과반) 커트라인은 휴무 2일 이상·주말 전용
//     시설만 걸러낸다. 7일 전부 요구하면 하루 휴무만으로 제외되어 과도하게 보수적이다.
//   - 22·00·02·04시가 7일 전부 true면 새벽 내내 영업하는 24시간 운영으로 본다.
//     ("24/7" 문자열은 파서 없이도 동일하게 1.0이며 신뢰도만 높게 잡는다.)
//   - opening_hours 미기재·파싱 실패는 확인 안 됨(unknown)이지 영업 안 함이 아니다.
//
// bar·pub·nightclub 등 유흥시설은 애초 수집 쿼리에서 제외한다
// (밤 인파 ≠ 보행자 자연감시. scripts/fetch-night-facilities.mjs 참고).
import "./tz-kst.mjs"; // opening_hours 평가 전에 KST로 고정 (import 선언 순서 보장)
import opening_hours from "opening_hours";

const KST_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 주 4일 이상 해당 시간대 영업이면 운영으로 인정한다. */
export const MIN_NIGHT_DAYS = 4;

/** 영업시간 미확인 기본값. 점수 산식(config의 unknownNightScore)과 함께 유지. */
export const UNKNOWN_NIGHT = Object.freeze({
  nightTier: "unknown",
  nightScore: 0.15,
  confidence: 0.3,
  nightOpen22: false,
  nightOpen00: false,
  nightOpen02: false,
});

/** 이번 주(KST 기준) 월요일 00:00 KST의 UTC epoch ms. opening_hours는 반복 패턴이라 임의 주로 충분하다. */
export function representativeWeekMonday(now = new Date()) {
  const kstToday = new Date(now.getTime() + KST_MS);
  const daysSinceMonday = (kstToday.getUTCDay() + 6) % 7;
  return (
    Date.UTC(kstToday.getUTCFullYear(), kstToday.getUTCMonth(), kstToday.getUTCDate()) -
    daysSinceMonday * DAY_MS -
    KST_MS
  );
}

/**
 * PH(공휴일)·SH(학교방학) 선택자를 제거한다. opening_hours.js는 한국 공휴일을
 * 정의하지 않아 "Mo-Sa 09:00-22:00; PH off" 같은 흔한 표현이 통째로 파싱 실패하기
 * 때문이다. 공휴일 하루의 영업 여부 오차는 남지만, 전체를 미확인(0.15)으로 두는
 * 것보다 주간 영업 패턴을 보존하는 편이 정확하다.
 */
function stripHolidaySelectors(value) {
  return value
    .replace(/;\s*(PH|SH)\b[^;]*/gi, "")   // 규칙 전체가 PH/SH인 경우: "; PH off"
    .replace(/^\s*(PH|SH)\b[^;]*;\s*/gi, "")
    .replace(/,\s*(PH|SH)\b/gi, "")        // 선택자 목록에 섞인 경우: "Mo-Su,PH 24/7"
    .replace(/\b(PH|SH)\s*,/gi, "")
    .trim();
}

/**
 * opening_hours → { nightTier, nightScore, confidence, nightOpen22/00/02 }.
 * nightTier: "24h" | "02" | "00" | "22" | "day"(22시 이전 종료) | "unknown"(미확인).
 * confidence: 24/7 명시 0.9 · 시간대 판별 성공 0.8 · 미확인 0.3.
 * TODO(confidence): OSM lastcheck_date 등 원본 메타데이터를 받으면 최신성에 따라 보정한다.
 */
export function computeNightState(openingHours, { now = new Date() } = {}) {
  if (!openingHours || typeof openingHours !== "string") return { ...UNKNOWN_NIGHT };

  let oh;
  try {
    oh = new opening_hours(stripHolidaySelectors(openingHours), { address: { country_code: "kr" } });
  } catch {
    return { ...UNKNOWN_NIGHT };
  }

  const monday = representativeWeekMonday(now);
  const daysOpen = { h22: 0, h00: 0, h02: 0, h04: 0 };
  for (let day = 0; day < 7; day++) {
    // Date.UTC 계산으로 만들므로 CI(UTC 러너)에서도 KST 시각으로 평가된다.
    for (const [key, hour] of [["h22", 22], ["h00", 0], ["h02", 2], ["h04", 4]]) {
      if (oh.getState(new Date(monday + day * DAY_MS + hour * 60 * 60 * 1000))) daysOpen[key]++;
    }
  }

  const alwaysOpen = daysOpen.h22 === 7 && daysOpen.h00 === 7 && daysOpen.h02 === 7 && daysOpen.h04 === 7;
  const open = (days) => days >= MIN_NIGHT_DAYS;
  if (alwaysOpen) {
    const explicit = openingHours.replace(/\s/g, "") === "24/7";
    return {
      nightTier: "24h",
      nightScore: 1,
      confidence: explicit ? 0.9 : 0.8,
      nightOpen22: true,
      nightOpen00: true,
      nightOpen02: true,
    };
  }
  if (open(daysOpen.h02)) return { nightTier: "02", nightScore: 0.9, confidence: 0.8, nightOpen22: true, nightOpen00: true, nightOpen02: true };
  if (open(daysOpen.h00)) return { nightTier: "00", nightScore: 0.75, confidence: 0.8, nightOpen22: true, nightOpen00: true, nightOpen02: false };
  if (open(daysOpen.h22)) return { nightTier: "22", nightScore: 0.5, confidence: 0.8, nightOpen22: true, nightOpen00: false, nightOpen02: false };
  return { nightTier: "day", nightScore: 0, confidence: 0.8, nightOpen22: false, nightOpen00: false, nightOpen02: false };
}
