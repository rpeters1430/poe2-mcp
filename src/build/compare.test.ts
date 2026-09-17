import { test } from "node:test";
import assert from "node:assert/strict";
import { compareItem } from "./compare.js";
import { parseItemText } from "./item-text.js";
import type { InventoryItem, InventorySnapshot } from "../types.js";

function item(partial: Partial<InventoryItem>): InventoryItem {
  return {
    slot: null,
    name: "Old Ring",
    baseType: "Gold Ring",
    rarity: "Magic",
    itemLevel: null,
    identified: true,
    mods: ["+20 to maximum Life"],
    properties: [],
    corrupted: null,
    ...partial,
  };
}

function snapshot(equipment: InventoryItem[]): InventorySnapshot {
  return { source: "pob_import", fetchedAt: new Date().toISOString(), characterName: "Test", equipment, skills: [] };
}

test("infers slot from base type and computes a statDelta for a recognized affix", () => {
  const inv = snapshot([item({ slot: "Ring" })]);
  const candidate = parseItemText(`Rarity: Magic\nNew Ring of Vigour\nGold Ring\n--------\n+50 to maximum Life`);
  const result = compareItem(inv, candidate);
  assert.equal(result.slot, "Ring");
  const lifeDelta = result.statDeltas.find((d) => d.stat === "maximum_life");
  assert.deepEqual(lifeDelta, { stat: "maximum_life", before: 20, after: 50, delta: 30 });
  assert.ok(result.defensesBefore);
  assert.ok(result.defensesAfter);
  assert.equal(result.defensesAfter!.life - result.defensesBefore!.life, 30);
});

test("current is null when nothing is equipped in the inferred slot", () => {
  const inv = snapshot([]);
  const candidate = parseItemText(`Rarity: Magic\nNew Ring\nGold Ring\n--------\n+50 to maximum Life`);
  const result = compareItem(inv, candidate);
  assert.equal(result.current, null);
  const lifeDelta = result.statDeltas.find((d) => d.stat === "maximum_life");
  assert.equal(lifeDelta?.before, null);
  assert.equal(lifeDelta?.delta, null);
});

test("unresolvable slot skips the defense comparison but keeps raw mods", () => {
  const inv = snapshot([item({ slot: "Ring" })]);
  const candidate = parseItemText(`Rarity: Rare\nMystery Thing\nSome Unknown Base\n--------\n+10 to Strength`);
  const result = compareItem(inv, candidate);
  assert.equal(result.slot, null);
  assert.equal(result.defensesBefore, null);
  assert.equal(result.defensesAfter, null);
});

test("matches PoB and GGG variants of the same slot", () => {
  const inv = snapshot([item({ slot: "Helmet", name: "Old Helm", baseType: "Iron Helmet" })]);
  const candidate = parseItemText(`Rarity: Magic\nNew Helm\nIron Helmet\n--------\n+50 to maximum Life`);
  const result = compareItem(inv, candidate);
  assert.equal(result.slot, "Helm");
  assert.equal(result.current?.name, "Old Helm");
  assert.equal(result.defensesAfter!.life, 50);
});

test("infers slot from PoE 2 Item Class header", () => {
  const inv = snapshot([item({ slot: "Offhand", name: "Old Quiver", baseType: "Broadhead Quiver" })]);
  const candidate = parseItemText(
    `Item Class: Quivers\nRarity: Rare\nStorm Flight\nFire Arrow Quiver\n--------\n+40 to maximum Life`
  );
  const result = compareItem(inv, candidate);
  assert.equal(result.slot, "Offhand");
  assert.equal(result.current?.name, "Old Quiver");
});

test("evaluates both rings and recommends replacing the weaker ring when both are equipped", () => {
  const ring1 = item({ slot: "Ring", name: "Ring 1 (Strong)", mods: ["+80 to maximum Life"] });
  const ring2 = item({ slot: "Ring2", name: "Ring 2 (Weak)", mods: ["+10 to maximum Life"] });
  const inv = snapshot([ring1, ring2]);

  const candidate = parseItemText(`Item Class: Rings\nRarity: Rare\nOmega Band\nRuby Ring\n--------\n+60 to maximum Life`);
  const result = compareItem(inv, candidate);

  assert.ok(result.ringComparisons);
  assert.equal(result.ringComparisons.recommendedSlot, "Ring2");
  assert.equal(result.slot, "Ring2");
  assert.equal(result.current?.name, "Ring 2 (Weak)");
  const lifeDelta = result.statDeltas.find((d) => d.stat === "maximum_life");
  assert.equal(lifeDelta?.delta, 50); // 60 - 10 = +50 gain
});

