import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { decodePobCode, resolvePobXml } from "./pob-decode.js";

function toShareCode(xml: string): string {
  const deflated = zlib.deflateRawSync(Buffer.from(xml, "utf8"));
  return deflated.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

test("decodePobCode round-trips a URL-safe base64 raw-DEFLATE share code", () => {
  const xml = "<PathOfBuilding2><Build level=\"90\" /></PathOfBuilding2>";
  const code = toShareCode(xml);
  assert.equal(decodePobCode(code), xml);
});

test("decodePobCode strips wrapping quotes before decoding", () => {
  const xml = "<PathOfBuilding2 />";
  const code = `"${toShareCode(xml)}"`;
  assert.equal(decodePobCode(code), xml);
});

test("decodePobCode throws a clear error for garbage input", () => {
  assert.throws(() => decodePobCode("not-a-real-share-code"));
});

test("resolvePobXml passes through raw XML unchanged", async () => {
  const xml = "<PathOfBuilding2><Build level=\"1\" /></PathOfBuilding2>";
  assert.equal(await resolvePobXml(xml), xml);
});

test("resolvePobXml strips markdown code fences around raw XML", async () => {
  const xml = "<PathOfBuilding2 />";
  assert.equal(await resolvePobXml("```xml\n" + xml + "\n```"), xml);
});

// Regression test: this used to match poe1 profile URLs too, but always
// queried the poe2 API endpoint regardless -- silently returning the wrong
// (or a poe2-shaped 404) response instead of a clear error. This server
// only supports Path of Exile 2 characters.
test("resolvePobXml rejects a poe.ninja poe1 profile URL with a clear error instead of misreading it as poe2", async () => {
  await assert.rejects(
    () => resolvePobXml("https://poe.ninja/poe1/profile/someaccount-1234/standard/character/somechar"),
    /only supports Path of Exile 2/
  );
});

test("resolvePobXml decodes a share code when nothing else matches", async () => {
  const xml = "<PathOfBuilding2><Build level=\"50\" /></PathOfBuilding2>";
  const code = toShareCode(xml);
  assert.equal(await resolvePobXml(code), xml);
});

test("resolvePobXml rejects generic URLs before fetching them", async () => {
  await assert.rejects(
    resolvePobXml("http://127.0.0.1:8080/private"),
    /Generic URL imports are disabled/
  );
});

test("decodePobCode limits decompressed output", () => {
  const oversizedXml = `<PathOfBuilding2>${"x".repeat(20 * 1024 * 1024)}</PathOfBuilding2>`;
  const code = toShareCode(oversizedXml);
  assert.throws(() => decodePobCode(code), /Could not decompress/);
});
