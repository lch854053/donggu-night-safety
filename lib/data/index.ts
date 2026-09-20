import type { SafetyDataSource } from "@/lib/data/SafetyDataSource";
import { MockSafetyDataSource } from "@/lib/data/mockSafetyDataSource";

const dataSources: Record<string, SafetyDataSource> = {
  mock: new MockSafetyDataSource(),
};

export function getSafetyDataSource() {
  const sourceName = process.env.NEXT_PUBLIC_SPATIAL_DATA_SOURCE ?? "mock";
  const source = dataSources[sourceName];

  if (!source) {
    throw new Error(`지원하지 않는 공간 데이터 공급자입니다: ${sourceName}`);
  }

  return source;
}
