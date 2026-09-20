import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mapLibreDistribution = resolve(projectRoot, "node_modules/maplibre-gl/dist");
const destinationDirectory = resolve(projectRoot, "public/vendor");

await mkdir(destinationDirectory, { recursive: true });
await Promise.all(
  ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"].map((fileName) =>
    copyFile(resolve(mapLibreDistribution, fileName), resolve(destinationDirectory, fileName)),
  ),
);
