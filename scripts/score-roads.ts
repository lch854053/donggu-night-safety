import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { calculateRoadSafety } from "../lib/scoring/calculateRoadSafety";
import { createRoadPointIndex } from "../lib/scoring/roadPointIndex";
import type { SafetyDataset, ScoredRoadFile } from "../types/safety";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function scoreRoads() {
  const paths = ["scripts/data/road-segments.geojson", "public/data/safety-features.geojson",
    "public/data/risk-zones.geojson", "config/safetyWeights.ts", "lib/scoring/calculateRoadSafety.ts",
    "lib/scoring/roadPointIndex.ts", "lib/scoring/lighting.ts", "lib/scoring/crimeRisk.ts",
    "lib/scoring/weightedAverage.ts", "lib/scoring/proximityScore.ts",
    "lib/scoring/surveillance.ts", "lib/scoring/activity.ts", "lib/scoring/environment.ts",
    "scripts/score-roads.ts"];
  // WMS 샘플링 결과가 있을 때만 점수 입력에 포함한다. 없으면 crimeScore는 null(미수집).
  const crimeRiskPath = resolve(root, "public/data/crime-risk.json");
  const hasCrimeRisk = existsSync(crimeRiskPath);
  if (hasCrimeRisk) paths.push("public/data/crime-risk.json");
  // 야간 운영시설도 선택적 입력. 파일이 없으면 nightActivityScore는 null(미수집)로 남는다.
  const nightFacilitiesPath = resolve(root, "public/data/night-facilities.geojson");
  const hasNightFacilities = existsSync(nightFacilitiesPath);
  if (hasNightFacilities) paths.push("public/data/night-facilities.geojson");
  const contents = await Promise.all(paths.map((path) => readFile(resolve(root, path), "utf8")));
  const contentAt = (path: string) => JSON.parse(contents[paths.indexOf(path)]);
  const dataset: SafetyDataset = {
    roadSegments: contentAt("scripts/data/road-segments.geojson"),
    features: contentAt("public/data/safety-features.geojson"),
    riskZones: contentAt("public/data/risk-zones.geojson"),
    metadata: { sourceKind: "static", scoreKind: "client", updatedAt: "" },
    ...(hasCrimeRisk ? { crimeRiskByRoad: contentAt("public/data/crime-risk.json").roads } : {}),
  };
  // 야간 운영시설은 features에 병합만 하면 night_activity 타입 경로로 자동 반영된다.
  if (hasNightFacilities && contentAt("public/data/night-facilities.geojson").features?.length) {
    dataset.features.features.push(...contentAt("public/data/night-facilities.geojson").features);
  }
  if (!dataset.roadSegments.features.length || !dataset.features.features.length) {
    throw new Error("Cannot score empty roads or facilities");
  }
  if (dataset.riskZones.features.some((f) => /sample|mock|샘플/i.test(f.properties.source))) {
    throw new Error("Sample risk zones cannot be used with real roads");
  }
  const start = performance.now();
  const scored = calculateRoadSafety(dataset, createRoadPointIndex(dataset));
  const output: ScoredRoadFile = {
    ...scored,
    scoreMetadata: {
      kind: "precomputed", generatedAt: new Date().toISOString(),
      inputHashes: Object.fromEntries(paths.map((path, i) => [path, createHash("sha256").update(contents[i]).digest("hex")])),
    },
  };
  const target = resolve(root, "public/data/road-segments.geojson");
  await writeFile(`${target}.tmp`, `${JSON.stringify(output)}\n`);
  await rename(`${target}.tmp`, target);
  console.log(`Scored ${scored.features.length.toLocaleString()} roads in ${((performance.now() - start) / 1000).toFixed(2)}s`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  scoreRoads().catch((error) => { console.error(error); process.exitCode = 1; });
}
