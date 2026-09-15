import { test } from "node:test";
import assert from "node:assert/strict";
import type { InventorySnapshot } from "../types.js";
import { findTradeUpgrades, resetTradeMetadataCacheForTests } from "./trade.js";

test("builds and ranks a helmet search for cold resistance, life, budget, and required level", async () => {
  resetTradeMetadataCacheForTests();
  const inventory: InventorySnapshot = {
    source: "pob_import",
    fetchedAt: new Date().toISOString(),
    characterName: "Example",
    skills: [],
    equipment: [{
      slot: "Helm", name: "Old Helm", baseType: "Iron Crown", rarity: "Rare", itemLevel: 20,
      identified: true, corrupted: false, properties: [],
      mods: ["+20% to Cold Resistance", "+30 to maximum Life"],
    }],
  };

  const originalFetch = globalThis.fetch;
  let postedQuery: any;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/trade2/data/stats")) {
      return new Response(JSON.stringify({ result: [{ label: "Pseudo", entries: [
        { id: "pseudo.life", text: "+# total maximum Life" },
        { id: "pseudo.cold", text: "+#% total to Cold Resistance" },
      ] }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/api/trade2/search/poe2/Standard")) {
      postedQuery = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: "search-id", result: ["listing-id"], total: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json", "x-rate-limit-account": "5:10:60" },
      });
    }
    if (url.includes("/api/trade2/fetch/listing-id?query=search-id")) {
      return new Response(JSON.stringify({ result: [{
        id: "listing-id",
        item: {
          name: "Healthy Crown", typeLine: "Iron Crown", baseType: "Iron Crown", rarity: "Rare", ilvl: 40,
          identified: true, explicitMods: ["+25% to Cold Resistance", "+45 to maximum Life"], properties: [],
        },
        listing: { price: { amount: 1, currency: "exalted" } },
      }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const result = await findTradeUpgrades({
      inventory,
      league: "Standard",
      slot: "Helm",
      priorities: ["cold_resistance", "maximum_life"],
      maxPrice: 1,
      currency: "exalted",
      maxRequiredLevel: 40,
    }) as any;

    assert.equal(result.searchUrl, "https://www.pathofexile.com/trade2/search/poe2/Standard/search-id");
    assert.equal(postedQuery.query.filters.type_filters.filters.category.option, "armour.helmet");
    assert.equal(postedQuery.query.filters.req_filters.filters.lvl.max, 40);
    assert.deepEqual(postedQuery.query.filters.trade_filters.filters.price, { max: 1, option: "exalted" });
    assert.deepEqual(postedQuery.query.stats[0].filters, [
      { id: "pseudo.cold", value: { min: 21 } },
      { id: "pseudo.life", value: { min: 31 } },
    ]);
    assert.equal(result.candidates[0].improvesAllPriorities, true);
    assert.deepEqual(result.candidates[0].priorityDeltas, { cold_resistance: 5, maximum_life: 15 });
  } finally {
    globalThis.fetch = originalFetch;
    resetTradeMetadataCacheForTests();
  }
});

test("computes full stat gains against a zero baseline when the slot is empty", async () => {
  resetTradeMetadataCacheForTests();
  const inventory: InventorySnapshot = {
    source: "pob_import",
    fetchedAt: new Date().toISOString(),
    characterName: "Example",
    skills: [],
    equipment: [],
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/trade2/data/stats")) {
      return new Response(JSON.stringify({ result: [{ label: "Pseudo", entries: [
        { id: "pseudo.life", text: "+# total maximum Life" },
      ] }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/api/trade2/search/poe2/Standard")) {
      return new Response(JSON.stringify({ id: "search-id", result: ["listing-id"], total: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/trade2/fetch/listing-id?query=search-id")) {
      return new Response(JSON.stringify({ result: [{
        id: "listing-id",
        item: {
          name: "Fresh Ring", typeLine: "Iron Ring", baseType: "Iron Ring", rarity: "Rare", ilvl: 40,
          identified: true, explicitMods: ["+45 to maximum Life"], properties: [],
        },
        listing: { price: { amount: 1, currency: "exalted" } },
      }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const result = await findTradeUpgrades({
      inventory,
      league: "Standard",
      slot: "Ring",
      priorities: ["maximum_life"],
      maxPrice: 1,
      currency: "exalted",
    }) as any;

    assert.equal(result.currentItem, null);
    assert.deepEqual(result.candidates[0].priorityDeltas, { maximum_life: 45 });
    assert.equal(result.candidates[0].improvesAllPriorities, true);
  } finally {
    globalThis.fetch = originalFetch;
    resetTradeMetadataCacheForTests();
  }
});
