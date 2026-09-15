import type { DefenseStats, InventorySnapshot } from "../types.js";
import { parseMods, sumStat } from "./mod-parser.js";
import { propertyNumber } from "./item-properties.js";
import { contributesToActiveCharacter } from "./slots.js";

/** Standard PoE display cap for resistances. Applied uniformly to fire/cold/lightning/chaos. */
const RESISTANCE_CAP = 75;

/**
 * Aggregates equipped-item base properties (Armour/Evasion/Energy Shield
 * ratings) and parsed affixes (flat life/mana/ES, %-increased defenses,
 * resistances, attributes, block) into gear-only totals.
 *
 * Deliberately NOT a full character sheet: base life/mana from level and
 * class, and any passive-tree-granted life/ES/resistance/attribute nodes,
 * are not included -- GGG's API exposes only allocated passive node hashes,
 * not their stat effects (see PassiveTreeSnapshot). Callers should treat
 * this as "what the current gear contributes," not "the character's actual
 * totals in-game."
 */
export function computeDefenses(inventory: InventorySnapshot): DefenseStats {
  let flatLife = 0;
  let flatMana = 0;
  let baseArmour = 0;
  let baseEvasion = 0;
  let baseEnergyShield = 0;
  let blockChancePercent = 0;
  let fire = 0;
  let cold = 0;
  let lightning = 0;
  let chaos = 0;
  let strength = 0;
  let dexterity = 0;
  let intelligence = 0;

  for (const item of inventory.equipment) {
    if (!contributesToActiveCharacter(item.slot)) continue;
    baseArmour += propertyNumber(item.properties, "Armour") ?? 0;
    baseEvasion += propertyNumber(item.properties, "Evasion Rating") ?? 0;
    const displayedEnergyShield = propertyNumber(item.properties, "Energy Shield");
    baseEnergyShield += displayedEnergyShield ?? 0;
    blockChancePercent += propertyNumber(item.properties, "Chance to Block") ?? 0;

    const parsed = parseMods(item.mods);
    flatLife += sumStat(parsed, "maximum_life");
    flatMana += sumStat(parsed, "maximum_mana");
    // Armour pieces report their final local defensive value in properties;
    // reapplying their flat/% affixes would double count. Flat ES on an item
    // with no displayed ES property (for example, jewellery) is character-wide.
    if (displayedEnergyShield === null) baseEnergyShield += sumStat(parsed, "maximum_energy_shield");
    blockChancePercent += sumStat(parsed, "block_chance_percent");
    fire += sumStat(parsed, "fire_resistance_percent");
    cold += sumStat(parsed, "cold_resistance_percent");
    lightning += sumStat(parsed, "lightning_resistance_percent");
    chaos += sumStat(parsed, "chaos_resistance_percent");
    strength += sumStat(parsed, "strength");
    dexterity += sumStat(parsed, "dexterity");
    intelligence += sumStat(parsed, "intelligence");
  }

  const cap = (v: number) => Math.min(v, RESISTANCE_CAP);

  return {
    source: "gear_only",
    computedAt: new Date().toISOString(),
    characterName: inventory.characterName,
    life: flatLife,
    mana: flatMana,
    energyShield: Math.round(baseEnergyShield),
    armour: Math.round(baseArmour),
    evasion: Math.round(baseEvasion),
    blockChancePercent: blockChancePercent > 0 ? blockChancePercent : null,
    resistances: {
      fire: { raw: fire, capped: cap(fire) },
      cold: { raw: cold, capped: cap(cold) },
      lightning: { raw: lightning, capped: cap(lightning) },
      chaos: { raw: chaos, capped: cap(chaos) },
    },
    attributes: { strength, dexterity, intelligence },
    note:
      "Gear-only aggregate: base life/mana/attributes from character level and class, and any passive-tree-" +
      "granted life/ES/resistance/attribute nodes, are NOT included -- GGG's API exposes only allocated " +
      "passive node hashes, not their effects (see get_passive_tree). Resistances are capped at the standard " +
      "75% display cap; `raw` shows the uncapped gear-only sum. Displayed Armour/Evasion/ES item properties " +
      "are already locally modified and are not multiplied by their affix text again.",
  };
}
