import { createHash } from "node:crypto";
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
    "lib/scoring/roadPointIndex.ts", "lib/scoring/lighting.ts", "scripts/score-roads.ts"];
  const contents = await Promise.all(paths.map((path) => readFile(resolve(root, path), "utf8")));
  const dataset: SafetyDataset = {
    roadSegments: JSON.parse(contents[0]), features: JSON.parse(contents[1]), riskZones: JSON.parse(contents[2]),
    metadata: { sourceKind: "static", scoreKind: "client", updatedAt: "" },
  };
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
