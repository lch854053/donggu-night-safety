import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { calculateRoadSafety } from "../lib/scoring/calculateRoadSafety";
import { createRoadPointIndex } from "../lib/scoring/roadPointIndex";
import { computeEnvironmentScore } from "../lib/scoring/environment";
import { combineDimensionScores } from "../lib/scoring/weightedAverage";
import type { SafetyDataset, ScoredRoadFile } from "../types/safety";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function scoreRoads() {
  const paths = ["scripts/data/road-segments.geojson", "public/data/safety-features.geojson",
    "public/data/risk-zones.geojson", "config/safetyWeights.ts", "lib/scoring/calculateRoadSafety.ts",
    "lib/scoring/roadPointIndex.ts", "lib/scoring/lighting.ts", "lib/scoring/crimeRisk.ts",
    "lib/scoring/weightedAverage.ts", "lib/scoring/proximityScore.ts",
    "lib/scoring/surveillance.ts", "lib/scoring/activity.ts", "lib/scoring/environment.ts",
    "config/cctvPurpose.mjs", "scripts/score-roads.ts"];
  // WMS 샘플링 결과가 있을 때만 점수 입력에 포함한다. 없으면 crimeScore는 null(미수집).
  const crimeRiskPath = resolve(root, "public/data/crime-risk.json");
  const hasCrimeRisk = existsSync(crimeRiskPath);
  if (hasCrimeRisk) paths.push("public/data/crime-risk.json");
  const contents = await Promise.all(paths.map((path) => readFile(resolve(root, path), "utf8")));
  const dataset: SafetyDataset = {
    roadSegments: JSON.parse(contents[0]), features: JSON.parse(contents[1]), riskZones: JSON.parse(contents[2]),
    metadata: { sourceKind: "static", scoreKind: "client", updatedAt: "" },
    ...(hasCrimeRisk ? { crimeRiskByRoad: JSON.parse(contents[contents.length - 1]).roads } : {}),
  };
  if (!dataset.roadSegments.features.length || !dataset.features.features.length) {
    throw new Error("Cannot score empty roads or facilities");
  }
  if (dataset.riskZones.features.some((f) => /sample|mock|샘플/i.test(f.properties.source))) {
    throw new Error("Sample risk zones cannot be used with real roads");
  }
  const start = performance.now();
  let scored: ScoredRoadFile | ReturnType<typeof calculateRoadSafety>;
  if (process.argv.includes("--only=vacant")) {
    const previous: ScoredRoadFile = JSON.parse(await readFile(resolve(root, "public/data/road-segments.geojson"), "utf8"));
    const previousHashes = previous.scoreMetadata?.inputHashes;
    if (!previousHashes || paths.some((path, index) =>
      path !== "public/data/safety-features.geojson" && path !== "scripts/score-roads.ts" &&
      previousHashes[path] !== createHash("sha256").update(contents[index]).digest("hex"))) {
      throw new Error("기존 도로 점수의 입력 파일이 변경되었습니다. 전체 점수 재계산이 필요합니다.");
    }
    const byId = new Map(previous.features.map((road) => [road.properties.id, road]));
    const candidatesForRoad = createRoadPointIndex(dataset);
    const availableTypes = new Set(dataset.features.features.map((feature) => feature.properties.type));
    scored = {
      type: "FeatureCollection",
      features: dataset.roadSegments.features.map((road) => {
        const old = byId.get(road.properties.id);
        if (!old) throw new Error(`기존 도로 점수 누락: ${road.properties.id}`);
        const environment = computeEnvironmentScore(road, candidatesForRoad(road), availableTypes);
        const properties = {
          ...old.properties,
          environmentScore: environment.score,
          vacancyScore: environment.vacancyScore ?? undefined,
          safetyScoreV2: combineDimensionScores({
            lighting: old.properties.lightingScore,
            surveillance: old.properties.surveillanceScore,
            activity: old.properties.activityScore,
            environment: environment.score,
            crime: old.properties.crimeScore,
          }),
        };
        return { ...old, properties };
      }),
    };
  } else {
    scored = calculateRoadSafety(dataset, createRoadPointIndex(dataset));
  }
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
