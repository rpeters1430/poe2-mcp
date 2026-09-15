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

test("resolvePobXml decodes a share code when nothing else matches", async () => {
  const xml = "<PathOfBuilding2><Build level=\"50\" /></PathOfBuilding2>";
  const code = toShareCode(xml);
  assert.equal(await resolvePobXml(code), xml);
});
