import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { booleanPointInPolygon, pointOnFeature } from "@turf/turf";

const SOURCE_URL = "https://raw.githubusercontent.com/lch854053/donggu-building/main/apt_geo.json";
const OUTPUT = fileURLToPath(new URL("../public/data/apartment-pois.geojson", import.meta.url));
const META = fileURLToPath(new URL("../public/data/meta.json", import.meta.url));

/** 단지 필지 폴리곤에서 내부 참고점 하나만 추출한다. 출입구·개별 동 좌표가 아니다. */
export function buildApartmentPois(rows) {
  if (!Array.isArray(rows) || rows.length < 100) throw new Error("공동주택 원자료가 비정상적으로 적습니다.");
  const features = rows.map((row) => {
    const { geometry, pnu, complexNm } = row;
    if (!pnu || !complexNm || !["Polygon", "MultiPolygon"].includes(geometry?.type)) {
      throw new Error(`공동주택 필지·단지명 누락: ${pnu || complexNm || "미확인"}`);
    }
    const polygon = { type: "Feature", properties: {}, geometry };
    const point = pointOnFeature(polygon);
    const [lon, lat] = point.geometry.coordinates;
    if (!booleanPointInPolygon(point, polygon) || !Number.isFinite(lon) || !Number.isFinite(lat)
      || lon < 126.88 || lon > 127.02 || lat < 35.06 || lat > 35.19) {
      throw new Error(`공동주택 참고점 검증 실패: ${complexNm} (${pnu})`);
    }
    return {
      type: "Feature", geometry: point.geometry,
      properties: { id: `${pnu}-${complexNm}`, name: complexNm, kind: row.kind || "공동주택",
        pnu, address: row.addr || row.jibun || "", source: row.source || "unknown",
        households: Number(row.hhld) > 0 ? Number(row.hhld) : null },
    };
  });
  if (new Set(features.map((feature) => feature.properties.id)).size !== features.length) {
    throw new Error("공동주택 단지 식별자 중복");
  }
  return { type: "FeatureCollection", metadata: {
    source: SOURCE_URL, positionMeaning: "point within mapped cadastral parcel, not entrance or building location",
  }, features };
}

async function main() {
  const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`공동주택 원자료 HTTP ${response.status}`);
  const collection = buildApartmentPois(await response.json());
  const content = `${JSON.stringify(collection)}\n`;
  const previous = await readFile(OUTPUT, "utf8").catch(() => "");
  if (previous !== content) {
    await writeFile(`${OUTPUT}.tmp`, content);
    await rename(`${OUTPUT}.tmp`, OUTPUT);
  }
  const meta = JSON.parse(await readFile(META, "utf8"));
  if (!meta.sources?.apartment_poi) throw new Error("공동주택 출처 메타데이터 누락");
  if (meta.sources.apartment_poi.count !== collection.features.length) {
    meta.sources.apartment_poi.count = collection.features.length;
    await writeFile(`${META}.tmp`, `${JSON.stringify(meta, null, 2)}\n`);
    await rename(`${META}.tmp`, META);
  }
  console.log(`공동주택 단지 참고점 ${collection.features.length}건${previous === content ? " (변경 없음)" : " 저장"}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
