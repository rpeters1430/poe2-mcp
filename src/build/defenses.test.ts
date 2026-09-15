import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDefenses } from "./defenses.js";
import type { InventoryItem, InventorySnapshot } from "../types.js";

function item(partial: Partial<InventoryItem>): InventoryItem {
  return {
    slot: null,
    name: "Test Item",
    baseType: "Test Base",
    rarity: null,
    itemLevel: null,
    identified: true,
    mods: [],
    properties: [],
    corrupted: null,
    ...partial,
  };
}

function snapshot(equipment: InventoryItem[]): InventorySnapshot {
  return { source: "pob_import", fetchedAt: new Date().toISOString(), characterName: "Test", equipment, skills: [] };
}

test("aggregates flat life across items and rounds ES/armour with increased%", () => {
  const inv = snapshot([
    item({
      slot: "BodyArmour",
      properties: [{ name: "Armour", values: [["400", 0]] }],
      mods: ["+60 to maximum Life"],
    }),
    item({ slot: "Helm", mods: ["+40 to maximum Life", "20% increased Armour"] }),
  ]);

  const defenses = computeDefenses(inv);
  assert.equal(defenses.life, 100);
  assert.equal(defenses.armour, 480); // 400 * 1.2
  assert.equal(defenses.source, "gear_only");
});

test("caps resistances at 75% but keeps the raw uncapped sum", () => {
  const inv = snapshot([
    item({ mods: ["+40% to Fire Resistance"] }),
    item({ mods: ["+50% to Fire Resistance"] }),
  ]);
  const defenses = computeDefenses(inv);
  assert.equal(defenses.resistances.fire.raw, 90);
  assert.equal(defenses.resistances.fire.capped, 75);
});

test("blockChancePercent is null rather than 0 when no gear grants block", () => {
  const defenses = computeDefenses(snapshot([item({})]));
  assert.equal(defenses.blockChancePercent, null);
});
