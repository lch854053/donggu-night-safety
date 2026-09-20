import type { SafetyDataset } from "@/types/safety";

export interface SafetyDataSource {
  load(): Promise<SafetyDataset>;
}
