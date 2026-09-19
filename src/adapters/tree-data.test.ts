import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate this test file's on-disk cache from the user's real config dir and
// from other test files, since resolveNodeNames() persists a cache to
// configDir()/tree-data-cache.json.
process.env.POE2_MCP_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "poe2-mcp-tree-test-"));

const { resolveNodeNames, searchNodesByName, findNearbyPassiveUpgrades } = await import("./tree-data.js");

const FAKE_TREE_DATA = {
  nodes: {
    "111": { dn: "Iron Will", not: true, sd: ["+10% increased Melee Physical Damage"], out: ["500", "502", "333"], in: [] },
    "222": { name: "Golem's Blood", isKeystone: true, stats: ["Golems have 40% increased Buff Effect"] },
    "333": { dn: "Mastery Slot", m: true, in: ["111"] },
    "444": { name: "Vitality Node A", sd: [] },
    "445": { name: "Vitality Node B", sd: [] },
    "446": { name: "Vitality Node C", sd: [] },
    // A small connected graph off node 111, for findNearbyPassiveUpgrades:
    // 111 --(1 hop)-- 502 (keystone) and 111 --(1 hop)-- 500 (plain) --(2 hops)-- 501 (notable).
    "500": { name: "Path Node", sd: [], out: ["501"], in: ["111"] },
    "501": { name: "Ember's Wake", not: true, sd: ["+20% increased Fire Damage"], out: [], in: ["500"] },
    "502": { name: "Corrupted Blood Immunity", isKeystone: true, stats: ["Immune to Bleeding"], out: [], in: ["111"] },
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

test("searchNodesByName finds a node by case-insensitive partial name", async () => {
  const result = await withFakeFetch(FAKE_TREE_DATA, () => searchNodesByName("golem"));
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].id, 222);
  assert.equal(result.matches[0].name, "Golem's Blood");
  assert.equal(result.matches[0].isKeystone, true);
  assert.match(result.note, /1 match\(es\) for "golem"/);
});

test("searchNodesByName resolves the 'dn' field spelling too and returns no matches for an unknown query", async () => {
  const hit = await withFakeFetch(FAKE_TREE_DATA, () => searchNodesByName("iron will"));
  assert.deepEqual(hit.matches.map((n) => n.id), [111]);

  const miss = await withFakeFetch(FAKE_TREE_DATA, () => searchNodesByName("nonexistent passive"));
  assert.deepEqual(miss.matches, []);
});

test("searchNodesByName caps results at the given limit", async () => {
  const result = await withFakeFetch(FAKE_TREE_DATA, () => searchNodesByName("vitality", 2));
  assert.equal(result.matches.length, 2);
  assert.match(result.note, /limit reached/);
});

test("findNearbyPassiveUpgrades finds a 1-hop keystone and a 2-hop notable, excluding the plain connector and the allocated node itself", async () => {
  const result = await withFakeFetch(FAKE_TREE_DATA, () => findNearbyPassiveUpgrades([111], { maxHops: 2 }));
  const ids = result.candidates.map((c) => c.id);
  assert.ok(ids.includes(502), "expected the 1-hop keystone");
  assert.ok(ids.includes(501), "expected the 2-hop notable");
  assert.ok(!ids.includes(500), "plain connector node should be excluded");
  assert.ok(!ids.includes(111), "already-allocated node should be excluded");

  const keystone = result.candidates.find((c) => c.id === 502)!;
  assert.equal(keystone.hops, 1);
  assert.equal(keystone.isKeystone, true);
  const notable = result.candidates.find((c) => c.id === 501)!;
  assert.equal(notable.hops, 2);
  assert.equal(notable.isNotable, true);

  // Closest first.
  assert.deepEqual(result.candidates.map((c) => c.id).slice(0, 2), [502, 501]);
});

test("findNearbyPassiveUpgrades respects maxHops and excludes masteries unless requested", async () => {
  const oneHop = await withFakeFetch(FAKE_TREE_DATA, () => findNearbyPassiveUpgrades([111], { maxHops: 1 }));
  assert.deepEqual(oneHop.candidates.map((c) => c.id), [502]);

  const withMasteries = await withFakeFetch(FAKE_TREE_DATA, () =>
    findNearbyPassiveUpgrades([111], { maxHops: 1, includeMasteries: true })
  );
  assert.ok(withMasteries.candidates.some((c) => c.id === 333 && c.isMastery));
});
