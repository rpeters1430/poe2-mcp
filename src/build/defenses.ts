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
  let globalIncreasedArmourPercent = 0;
  let globalIncreasedEvasionPercent = 0;
  let globalIncreasedEnergyShieldPercent = 0;
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
    const displayedArmour = propertyNumber(item.properties, "Armour");
    const displayedEvasion = propertyNumber(item.properties, "Evasion Rating");
    const displayedEnergyShield = propertyNumber(item.properties, "Energy Shield");
    baseArmour += displayedArmour ?? 0;
    baseEvasion += displayedEvasion ?? 0;
    baseEnergyShield += displayedEnergyShield ?? 0;
    blockChancePercent += propertyNumber(item.properties, "Chance to Block") ?? 0;

    const parsed = parseMods(item.mods);
    // Runes/Soul Cores/Talismans socketed into this item (see InventoryItem.
    // socketedMods): their granted stats are never reflected in the
    // displayed properties above the way the item's own affixes are, so
    // they must always be treated as a global bonus below, never gated on
    // whether the item happens to have a matching local property.
    const socketed = parseMods(item.socketedMods ?? []);
    const allParsed = [...parsed, ...socketed];

    flatLife += sumStat(allParsed, "maximum_life");
    flatMana += sumStat(allParsed, "maximum_mana");
    // A displayed Armour/Evasion/ES property already reflects that item's own
    // local %-increased affixes, so reapplying them would double count.
    // Percent/flat defense affixes on an item with no matching displayed
    // property (for example, jewellery or a belt), or granted by a socketed
    // Rune/Soul Core regardless of the item's own displayed property, have
    // nothing local to scale and are global bonuses applied to the totals
    // below instead.
    if (displayedArmour === null) globalIncreasedArmourPercent += sumStat(parsed, "increased_armour_percent");
    globalIncreasedArmourPercent += sumStat(socketed, "increased_armour_percent");
    if (displayedEvasion === null) globalIncreasedEvasionPercent += sumStat(parsed, "increased_evasion_percent");
    globalIncreasedEvasionPercent += sumStat(socketed, "increased_evasion_percent");
    if (displayedEnergyShield === null) {
      baseEnergyShield += sumStat(parsed, "maximum_energy_shield");
      globalIncreasedEnergyShieldPercent += sumStat(parsed, "increased_energy_shield_percent");
    }
    baseEnergyShield += sumStat(socketed, "maximum_energy_shield");
    globalIncreasedEnergyShieldPercent += sumStat(socketed, "increased_energy_shield_percent");
    blockChancePercent += sumStat(allParsed, "block_chance_percent");
    fire += sumStat(allParsed, "fire_resistance_percent");
    cold += sumStat(allParsed, "cold_resistance_percent");
    lightning += sumStat(allParsed, "lightning_resistance_percent");
    chaos += sumStat(allParsed, "chaos_resistance_percent");
    strength += sumStat(allParsed, "strength");
    dexterity += sumStat(allParsed, "dexterity");
    intelligence += sumStat(allParsed, "intelligence");
  }

  const cap = (v: number) => Math.min(v, RESISTANCE_CAP);

  return {
    source: "gear_only",
    computedAt: new Date().toISOString(),
    characterName: inventory.characterName,
    life: flatLife,
    mana: flatMana,
    energyShield: Math.round(baseEnergyShield * (1 + globalIncreasedEnergyShieldPercent / 100)),
    armour: Math.round(baseArmour * (1 + globalIncreasedArmourPercent / 100)),
    evasion: Math.round(baseEvasion * (1 + globalIncreasedEvasionPercent / 100)),
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
      "are already locally modified and are not multiplied by their affix text again; %-increased defense " +
      "affixes on the item's own text only apply as a global bonus when found on an item with no matching " +
      "displayed property, while defense affixes granted by a socketed Rune/Soul Core always apply globally.",
  };
}
