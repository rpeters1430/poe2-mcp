import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMods, sumStat } from "./mod-parser.js";

test("parses flat life/mana/ES affixes", () => {
  const [life] = parseMods(["+45 to maximum Life"]);
  assert.deepEqual(life.matches, [{ stat: "maximum_life", value: 45 }]);
});

test("parses combined armour and evasion percent affix into two stats", () => {
  const [mod] = parseMods(["30% increased Armour and Evasion"]);
  assert.deepEqual(mod.matches, [
    { stat: "increased_armour_percent", value: 30 },
    { stat: "increased_evasion_percent", value: 30 },
  ]);
});

test("parses all-elemental-resistance affix into three stats", () => {
  const [mod] = parseMods(["+20% to all Elemental Resistances"]);
  assert.deepEqual(mod.matches, [
    { stat: "fire_resistance_percent", value: 20 },
    { stat: "cold_resistance_percent", value: 20 },
    { stat: "lightning_resistance_percent", value: 20 },
  ]);
});

test("parses added damage range affix into min/max stats", () => {
  const [mod] = parseMods(["Adds 10 to 20 Fire Damage"]);
  assert.deepEqual(mod.matches, [
    { stat: "added_fire_damage_min", value: 10 },
    { stat: "added_fire_damage_max", value: 20 },
  ]);
});

test("keeps unrecognized affix text with empty matches, never dropped", () => {
  const [mod] = parseMods(["Some future affix wording nobody has seen yet"]);
  assert.equal(mod.raw, "Some future affix wording nobody has seen yet");
  assert.deepEqual(mod.matches, []);
});

test("sumStat sums a stat across multiple parsed mods", () => {
  const parsed = parseMods(["+45 to maximum Life", "+30 to maximum Life", "+10 to Strength"]);
  assert.equal(sumStat(parsed, "maximum_life"), 75);
  assert.equal(sumStat(parsed, "strength"), 10);
  assert.equal(sumStat(parsed, "maximum_mana"), 0);
});
