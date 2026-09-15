import type { DefenseStats, InventorySnapshot } from "../types.js";
import { parseMods, sumStat } from "./mod-parser.js";
import { propertyNumber } from "./item-properties.js";

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
  let flatEnergyShield = 0;
  let baseArmour = 0;
  let baseEvasion = 0;
  let baseEnergyShield = 0;
  let increasedArmourPercent = 0;
  let increasedEvasionPercent = 0;
  let increasedEnergyShieldPercent = 0;
  let blockChancePercent = 0;
  let fire = 0;
  let cold = 0;
  let lightning = 0;
  let chaos = 0;
  let strength = 0;
  let dexterity = 0;
  let intelligence = 0;

  for (const item of inventory.equipment) {
    baseArmour += propertyNumber(item.properties, "Armour") ?? 0;
    baseEvasion += propertyNumber(item.properties, "Evasion Rating") ?? 0;
    baseEnergyShield += propertyNumber(item.properties, "Energy Shield") ?? 0;
    blockChancePercent += propertyNumber(item.properties, "Chance to Block") ?? 0;

    const parsed = parseMods(item.mods);
    flatLife += sumStat(parsed, "maximum_life");
    flatMana += sumStat(parsed, "maximum_mana");
    flatEnergyShield += sumStat(parsed, "maximum_energy_shield");
    increasedArmourPercent += sumStat(parsed, "increased_armour_percent");
    increasedEvasionPercent += sumStat(parsed, "increased_evasion_percent");
    increasedEnergyShieldPercent += sumStat(parsed, "increased_energy_shield_percent");
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
    energyShield: Math.round((baseEnergyShield + flatEnergyShield) * (1 + increasedEnergyShieldPercent / 100)),
    armour: Math.round(baseArmour * (1 + increasedArmourPercent / 100)),
    evasion: Math.round(baseEvasion * (1 + increasedEvasionPercent / 100)),
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
      "75% display cap; `raw` shows the uncapped gear-only sum.",
  };
}
