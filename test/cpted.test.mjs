import assert from "node:assert/strict";
import test from "node:test";
import { collectCptedFeatures, geocodeAddress } from "../scripts/cpted.mjs";

const address = "광주광역시 동구 동명동 1-1";
const row = (props = {}) => ({ jibun_addr: address, imprvm_pro: "완료", ...props });
const inBbox = (lon, lat) => lon >= 126.86 && lon <= 127.03 && lat >= 35.08 && lat <= 35.22;

test("VWORLD uses parcel WGS84 and keeps credentials out of result", async () => {
  const result = await geocodeAddress(address, "parcel", {
    key: "test-secret", domain: "https://example.com",
    getText: async (url) => {
      assert.equal(url.origin, "https://api.vworld.kr");
      assert.equal(url.searchParams.get("address"), address);
      assert.equal(url.searchParams.get("type"), "parcel");
      assert.equal(url.searchParams.get("crs"), "EPSG:4326");
      assert.equal(url.searchParams.get("domain"), "https://example.com");
      return JSON.stringify({ response: { status: "OK", result: { point: { x: "126.925", y: "35.15" } } } });
    },
  });
  assert.deepEqual(result, [126.925, 35.15]);
});

test("NOT_FOUND is skippable but auth errors and malformed coordinates abort", async () => {
  const call = (response) => geocodeAddress(address, "parcel", {
    key: "test-secret", getText: async () => JSON.stringify({ response }),
  });
  assert.equal(await call({ status: "NOT_FOUND" }), null);
  await assert.rejects(call({ status: "ERROR", error: { code: "INVALID_KEY", text: "test-secret" } }), /INVALID_KEY/);
  await assert.rejects(call({ status: "OK", result: { point: { x: "35.15", y: "126.925" } } }), /좌표/);
  await assert.rejects(call({ status: "OK", result: {} }), /좌표/);
  await assert.rejects(geocodeAddress(address, "parcel", { getText: async () => "" }), /VWORLD_API_KEY/);
});

test("address cache avoids repeated API calls; invalid coordinates and expired misses are refreshed", async () => {
  const cache = { [`parcel:${address}`]: { crs: "EPSG:4326", coordinates: [35.15, 126.925] } };
  let calls = 0;
  const options = { key: "test-secret", cache, getText: async () => {
    calls++;
    return JSON.stringify({ response: { status: "OK", result: { point: { x: "126.925", y: "35.15" } } } });
  } };
  await geocodeAddress(address, "parcel", options);
  assert.equal(calls, 1);
  const result = await geocodeAddress(address, "parcel", options);
  assert.equal(calls, 1);
  assert.deepEqual(result, [126.925, 35.15]);
  result[0] = 0;
  assert.deepEqual(cache[`parcel:${address}`].coordinates, [126.925, 35.15]);
  await geocodeAddress("missing", "parcel", { ...options,
    getText: async () => JSON.stringify({ response: { status: "NOT_FOUND" } }),
  });
  assert.equal(cache["parcel:missing"].status, "NOT_FOUND");
  assert.equal(await geocodeAddress("missing", "parcel", options), null);
  assert.equal(calls, 1);
  cache["parcel:missing"].geocodedAt = "2000-01-01";
  assert.deepEqual(await geocodeAddress("missing", "parcel", options), [126.925, 35.15]);
  assert.equal(calls, 2);
});

test("only completed Gwangju projects count; duplicates, plans, other regions and off-map points do not", async () => {
  let calls = 0;
  const result = await collectCptedFeatures([
    row(), row(), row({ imprvm_pro: "계획" }), row({ imprvm_pro: "진행중" }),
    row({ jibun_addr: "경기도 광주시 경안동 1" }),
    row({ jibun_addr: "광주광역시 광산구 우산동 1" }),
  ], { inBbox, geocode: async (a) => { calls++; return a === address ? [126.925, 35.15] : [126.8, 35.15]; } });
  assert.equal(calls, 2);
  assert.equal(result.features.length, 1);
  assert.equal(result.metadata.incomplete, 2);
  assert.equal(result.metadata.duplicates, 1);
  assert.equal(result.metadata.outsideBbox, 1);
  assert.equal(result.features[0].properties.locationAccuracy, "address");
  assert.equal(result.features[0].properties.source, "safemap:IF_0023");
});

test("road fallback, unmatched reporting and stable IDs across source order", async () => {
  const road = "광주광역시 동구 동계천로 1";
  const geocode = async (a, type) => type === "road" ? [126.925, 35.15] : null;
  const rows = [row({ roadnm_add: road }), row({ jibun_addr: "광주광역시 동구 동명동 9999" })];
  const result = await collectCptedFeatures(rows, { inBbox, geocode });
  assert.equal(result.features[0].properties.addressType, "road");
  assert.equal(result.metadata.unresolvedCount, 1);
  assert.equal(result.metadata.unresolved[0].reason, "NOT_FOUND");
  const reversed = await collectCptedFeatures([...rows].reverse(), { inBbox, geocode });
  assert.equal(result.features[0].properties.id, reversed.features[0].properties.id);
});

test("zero results and provider failures cannot replace existing data with an empty collection", async () => {
  await assert.rejects(collectCptedFeatures([row()], { inBbox, geocode: async () => null }), /0건/);
  await assert.rejects(collectCptedFeatures([row()], {
    inBbox, geocode: async () => { throw new Error("VWORLD unavailable"); },
  }), /VWORLD unavailable/);
});
