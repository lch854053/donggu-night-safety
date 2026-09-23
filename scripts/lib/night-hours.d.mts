// scripts/lib/night-hours.mjs의 타입 선언. 수집·테스트 코드에서 공유한다.
export interface NightState {
  nightTier: "24h" | "02" | "00" | "22" | "day" | "unknown";
  nightScore: number;
  confidence: number;
  nightOpen22: boolean;
  nightOpen00: boolean;
  nightOpen02: boolean;
}

export declare const MIN_NIGHT_DAYS: number;
export declare const UNKNOWN_NIGHT: Readonly<NightState>;
export declare function representativeWeekMonday(now?: Date): number;
export declare function computeNightState(
  openingHours: string | undefined | null,
  options?: { now?: Date },
): NightState;
