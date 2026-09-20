import type { SafetyDataSource } from "@/lib/data/SafetyDataSource";
import { StaticSafetyDataSource } from "@/lib/data/staticSafetyDataSource";

const staticProvider = new StaticSafetyDataSource();

const dataSources: Record<string, SafetyDataSource> = {
  static: staticProvider,
  // Vercel 등 배포 환경에 이전 값(mock)이 남아 있어도 같은 정적 공급자로 동작하게 함
  mock: staticProvider,
};

export function getSafetyDataSource() {
  const sourceName = process.env.NEXT_PUBLIC_SPATIAL_DATA_SOURCE?.trim() || "static";
  const source = dataSources[sourceName];

  if (!source) {
    throw new Error(`지원하지 않는 공간 데이터 공급자입니다: ${sourceName}`);
  }

  return source;
}
