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

test("aggregates flat life without reapplying local increased armour", () => {
  const inv = snapshot([
    item({
      slot: "BodyArmour",
      properties: [{ name: "Armour", values: [["400", 0]] }],
      mods: ["+60 to maximum Life"],
    }),
    item({
      slot: "Helm",
      properties: [{ name: "Armour", values: [["50", 0]] }],
      mods: ["+40 to maximum Life", "20% increased Armour"],
    }),
  ]);

  const defenses = computeDefenses(inv);
  assert.equal(defenses.life, 100);
  assert.equal(defenses.armour, 450);
  assert.equal(defenses.source, "gear_only");
});

test("does not double count local ES but includes flat ES on non-ES gear", () => {
  const defenses = computeDefenses(snapshot([
    item({
      slot: "BodyArmour",
      properties: [{ name: "Energy Shield", values: [["245", 0]] }],
      mods: ["+100 to maximum Energy Shield", "30% increased Energy Shield"],
    }),
    item({ slot: "Ring", mods: ["+20 to maximum Energy Shield"] }),
  ]));
  assert.equal(defenses.energyShield, 265);
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

test("applies increased Armour/Evasion/ES from gear with no local base as a global bonus", () => {
  const defenses = computeDefenses(snapshot([
    item({
      slot: "BodyArmour",
      properties: [{ name: "Armour", values: [["400", 0]] }],
    }),
    item({
      slot: "Boots",
      properties: [{ name: "Evasion Rating", values: [["200", 0]] }],
    }),
    // A ring has no local Armour/Evasion/ES property, so any %-increased
    // defense affix on it is a global bonus, not a local one already baked
    // into a displayed property.
    item({ slot: "Ring", mods: ["20% increased Armour", "10% increased Evasion Rating"] }),
  ]));
  assert.equal(defenses.armour, 480);
  assert.equal(defenses.evasion, 220);
});

test("blockChancePercent is null rather than 0 when no gear grants block", () => {
  const defenses = computeDefenses(snapshot([item({})]));
  assert.equal(defenses.blockChancePercent, null);
});

test("excludes swap weapons, flasks, and charms from active defense totals", () => {
  const defenses = computeDefenses(snapshot([
    item({ slot: "Ring", mods: ["+20% to Fire Resistance"] }),
    item({ slot: "Weapon2", mods: ["+40% to Fire Resistance"] }),
    item({ slot: "Flask 1", mods: ["+30% to Fire Resistance"] }),
    item({ slot: "Charm 1", mods: ["+10% to Fire Resistance"] }),
  ]));
  assert.equal(defenses.resistances.fire.raw, 20);
});
