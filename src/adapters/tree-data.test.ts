import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate this test file's on-disk cache from the user's real config dir and
// from other test files, since resolveNodeNames() persists a cache to
// configDir()/tree-data-cache.json.
process.env.POE2_MCP_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "poe2-mcp-tree-test-"));

const { resolveNodeNames } = await import("./tree-data.js");

const FAKE_TREE_DATA = {
  nodes: {
    "111": { dn: "Iron Will", not: true, sd: ["+10% increased Melee Physical Damage"] },
    "222": { name: "Golem's Blood", isKeystone: true, stats: ["Golems have 40% increased Buff Effect"] },
    "333": { dn: "Mastery Slot", m: true },
  },
};

function withFakeFetch<T>(response: unknown, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => response,
    }) as unknown as Response) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

// Order matters here: resolveNodeNames() keeps a module-level in-memory
// cache alongside the on-disk one, so this offline test must run before any
// test below populates it with FAKE_TREE_DATA (each test file runs its tests
// sequentially in one process, but shares that module state across them).
test("degrades gracefully to name: null for every id when the fetch fails and no cache exists", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network unreachable");
  }) as typeof fetch;
  try {
    const result = await resolveNodeNames([111]);
    assert.deepEqual(result.resolvedNodes, [
      { id: 111, name: null, isKeystone: false, isNotable: false, isMastery: false, ascendancyId: null, stats: [] },
    ]);
    assert.match(result.note, /Could not resolve node names/);
  } finally {
    globalThis.fetch = original;
  }
});

test("resolves both 'dn'/'not' and 'name'/'isKeystone' field spellings", async () => {
  const result = await withFakeFetch(FAKE_TREE_DATA, () => resolveNodeNames([111, 222]));
  assert.deepEqual(result.resolvedNodes[0], {
    id: 111,
    name: "Iron Will",
    isKeystone: false,
    isNotable: true,
    isMastery: false,
    ascendancyId: null,
    stats: ["+10% increased Melee Physical Damage"],
  });
  assert.deepEqual(result.resolvedNodes[1], {
    id: 222,
    name: "Golem's Blood",
    isKeystone: true,
    isNotable: false,
    isMastery: false,
    ascendancyId: null,
    stats: ["Golems have 40% increased Buff Effect"],
  });
});

test("keeps the raw id with name: null for an id not present in the dataset", async () => {
  const result = await withFakeFetch(FAKE_TREE_DATA, () => resolveNodeNames([999]));
  assert.deepEqual(result.resolvedNodes, [
    { id: 999, name: null, isKeystone: false, isNotable: false, isMastery: false, ascendancyId: null, stats: [] },
  ]);
  assert.match(result.note, /1 of 1 node id\(s\) had no match/);
});

test("returns one result per input id, in the same order, for a mix of hit and miss", async () => {
  const result = await withFakeFetch(FAKE_TREE_DATA, () => resolveNodeNames([333, 999, 111]));
  assert.deepEqual(
    result.resolvedNodes.map((n) => n.id),
    [333, 999, 111]
  );
  assert.equal(result.resolvedNodes[0].isMastery, true);
  assert.equal(result.resolvedNodes[1].name, null);
  assert.equal(result.resolvedNodes[2].name, "Iron Will");
});
