import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAccountName, parseNinjaProfileUrl } from "./poe-ninja.js";

test("normalizeAccountName converts the '#' discriminator to '-'", () => {
  assert.equal(normalizeAccountName("rpeters1428#1042"), "rpeters1428-1042");
  assert.equal(normalizeAccountName(" rpeters1428-1042 "), "rpeters1428-1042");
});

test("parseNinjaProfileUrl extracts account/league/character from a poe2 profile URL", () => {
  const parsed = parseNinjaProfileUrl("https://poe.ninja/poe2/profile/rpeters1428-1042/forbiddenrites/character/crossbowlol");
  assert.deepEqual(parsed, { account: "rpeters1428-1042", league: "forbiddenrites", character: "crossbowlol" });
});

// Regression test: this regex used to accept `poe1` too and silently build
// a `/poe2/api/...` fetch URL regardless, instead of clearly rejecting a
// pasted poe1 profile URL. This server only supports Path of Exile 2.
test("parseNinjaProfileUrl rejects a poe1 profile URL instead of misreading it as poe2", () => {
  const parsed = parseNinjaProfileUrl("https://poe.ninja/poe1/profile/someaccount-1234/standard/character/somechar");
  assert.equal(parsed, null);
});

test("parseNinjaProfileUrl returns null for an unrelated URL", () => {
  assert.equal(parseNinjaProfileUrl("https://example.com/not-a-profile"), null);
});
