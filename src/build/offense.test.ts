import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOffenseStats } from "./offense.js";
import type { InventoryItem, InventorySnapshot } from "../types.js";

function item(partial: Partial<InventoryItem>): InventoryItem {
  return {
    slot: null,
    name: "Test Weapon",
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

test("builds weapon offense from a Weapon-slot item's properties", () => {
  const inv = snapshot([
    item({
      slot: "Weapon",
      properties: [
        { name: "Physical Damage", values: [["10-20", 0]] },
        { name: "Critical Strike Chance", values: [["+5%", 0]] },
        { name: "Attacks per Second", values: [["1.5", 0]] },
      ],
    }),
    item({ slot: "Offhand" }),
  ]);
  const stats = computeOffenseStats(inv);
  assert.equal(stats.weapons.length, 1);
  assert.deepEqual(stats.weapons[0].physicalDamage, { min: 10, max: 20 });
  assert.equal(stats.weapons[0].criticalStrikeChance, 5);
  assert.equal(stats.weapons[0].attacksPerSecond, 1.5);
});

test("aggregates speed/crit affixes across all equipped items, not just weapons", () => {
  const inv = snapshot([
    item({ slot: "Weapon", mods: ["15% increased Attack Speed"] }),
    item({ slot: "Gloves", mods: ["10% increased Attack Speed", "+50 to Accuracy Rating"] }),
  ]);
  const stats = computeOffenseStats(inv);
  assert.equal(stats.increasedAttackSpeedPercent, 25);
  assert.equal(stats.accuracyRating, 50);
});

test("otherDamageMods keeps any raw mod text mentioning damage", () => {
  const inv = snapshot([item({ mods: ["Adds 5 to 10 Physical Damage", "+10 to Strength"] })]);
  const stats = computeOffenseStats(inv);
  assert.equal(stats.otherDamageMods.length, 1);
  assert.equal(stats.otherDamageMods[0].raw, "Adds 5 to 10 Physical Damage");
});
