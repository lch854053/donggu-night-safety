import assert from "node:assert/strict";
import test from "node:test";

import { computeNightState, MIN_NIGHT_DAYS, representativeWeekMonday } from "../scripts/lib/night-hours.mjs";

// 모든 판정은 고정된 대표 주에서 수행한다 (2026-09-21(월) KST 기준 주).
const FIXED_NOW = new Date("2026-09-23T12:00:00+09:00");

test("representativeWeekMonday returns a KST Monday midnight", () => {
  const monday = representativeWeekMonday(FIXED_NOW);
  const kst = new Date(monday + 9 * 60 * 60 * 1000);
  assert.equal(kst.getUTCDay(), 1, "월요일");
  assert.equal(kst.getUTCHours(), 0, "KST 자정");
  assert.equal(kst.toISOString().slice(0, 10), "2026-09-21");
});

test("24/7 explicit and effective 24h both score 1.0", () => {
  const explicit = computeNightState("24/7", { now: FIXED_NOW });
  assert.equal(explicit.nightTier, "24h");
  assert.equal(explicit.nightScore, 1);
  assert.equal(explicit.confidence, 0.9, "24/7 명시는 신뢰도가 높다");
  assert.ok(explicit.nightOpen02 && explicit.nightOpen00 && explicit.nightOpen22);

  const effective = computeNightState("Mo-Su 00:00-24:00", { now: FIXED_NOW });
  assert.equal(effective.nightTier, "24h", "새벽 내내 영업은 실질 24시간");
  assert.equal(effective.nightScore, 1);
  assert.equal(effective.confidence, 0.8);
});

test("late-night cutoffs map to their tiers", () => {
  const until01 = computeNightState("Mo-Su 09:00-01:00", { now: FIXED_NOW });
  assert.equal(until01.nightTier, "00", "자정은 지나지만 02시 전 종료");
  assert.equal(until01.nightScore, 0.75);
  assert.ok(until01.nightOpen00 && !until01.nightOpen02);

  const until23 = computeNightState("Mo-Su 08:00-23:00", { now: FIXED_NOW });
  assert.equal(until23.nightTier, "22");
  assert.equal(until23.nightScore, 0.5);
  assert.ok(until23.nightOpen22 && !until23.nightOpen00);
});

test("weekday-only business hours still count as night-open", () => {
  // 평일 5일(≥4) 영업이면 22시 이후 운영으로 인정된다.
  const weekdays = computeNightState("Mo-Fr 08:00-23:00", { now: FIXED_NOW });
  assert.equal(weekdays.nightTier, "22");
  assert.equal(weekdays.nightScore, 0.5);
});

test("weekend-only or daytime-only facilities contribute nothing", () => {
  const weekend = computeNightState("Sa-Su 10:00-22:00", { now: FIXED_NOW });
  assert.equal(weekend.nightTier, "day", `주 2일은 ${MIN_NIGHT_DAYS}일 미만`);
  assert.equal(weekend.nightScore, 0);

  const daytime = computeNightState("Mo-Su 08:00-20:00", { now: FIXED_NOW });
  assert.equal(daytime.nightTier, "day", "22시 이전 종료");
  assert.equal(daytime.nightScore, 0);
});

test("PH/SH selectors are stripped, not fatal (no Korean holidays in opening_hours.js)", () => {
  const withPhOff = computeNightState("Mo-Sa 09:00-23:00; PH off", { now: FIXED_NOW });
  assert.equal(withPhOff.nightTier, "22", "주간 패턴은 보존된다");
  assert.equal(withPhOff.nightScore, 0.5);

  const mixed = computeNightState("Mo-Su,PH 07:00-01:00", { now: FIXED_NOW });
  assert.equal(mixed.nightTier, "00");

  const holidayOnly = computeNightState("PH 09:00-18:00", { now: FIXED_NOW });
  assert.equal(holidayOnly.nightTier, "unknown", "공휴일 전용 규칙은 판단 불가");
});

test("missing or unparseable opening_hours is unknown, not closed", () => {
  for (const hours of [undefined, "", "   ", "항상 영업", "Mo-Su 25:00-99:00"]) {
    const state = computeNightState(hours as string, { now: FIXED_NOW });
    assert.equal(state.nightTier, "unknown", JSON.stringify(hours));
    assert.equal(state.nightScore, 0.15);
    assert.equal(state.confidence, 0.3);
    assert.equal(state.nightOpen22, false);
  }
});
