import type { InventoryItem, InventorySnapshot, OffenseStats, WeaponOffense } from "../types.js";
import { parseMods, sumStat } from "./mod-parser.js";
import { propertyNumber, propertyRange } from "./item-properties.js";
import { isActiveWeaponSlot } from "./slots.js";
const ELEMENTAL_DAMAGE_PROPERTIES = ["Fire Damage", "Cold Damage", "Lightning Damage", "Chaos Damage"];

function buildWeaponOffense(item: InventoryItem): WeaponOffense {
  const elementalDamage = ELEMENTAL_DAMAGE_PROPERTIES.map((name) => propertyRange(item.properties, name)).filter(
    (r): r is { min: number; max: number } => r !== null
  );
  return {
    slot: item.slot,
    name: item.name,
    physicalDamage: propertyRange(item.properties, "Physical Damage"),
    elementalDamage,
    criticalStrikeChance: propertyNumber(item.properties, "Critical Strike Chance"),
    attacksPerSecond: propertyNumber(item.properties, "Attacks per Second"),
  };
}

function isWeaponItem(item: InventoryItem): boolean {
  if (!isActiveWeaponSlot(item.slot)) return false;
  return propertyRange(item.properties, "Physical Damage") !== null ||
    ELEMENTAL_DAMAGE_PROPERTIES.some((name) => propertyRange(item.properties, name) !== null);
}

/**
 * Aggregates gear-derived offensive inputs: weapon damage ranges/crit/APS
 * from item properties, plus speed/crit/accuracy affixes and raw damage-
 * related mods from parsed affixes across all equipped items.
 *
 * Deliberately NOT a DPS number: there is no skill gem, support gem, or
 * "more" multiplier data available yet (that needs the local game-data
 * layer and/or a PoB2 bridge, both out of scope for this milestone). This
 * is the raw material an AI -- or a future calculator -- would need to
 * derive one.
 */
export function computeOffenseStats(inventory: InventorySnapshot): OffenseStats {
  const weapons = inventory.equipment
    .filter(isWeaponItem)
    .map(buildWeaponOffense);

  const allMods = parseMods(inventory.equipment.flatMap((item) => item.mods));

  return {
    source: "gear_only",
    computedAt: new Date().toISOString(),
    characterName: inventory.characterName,
    weapons,
    accuracyRating: sumStat(allMods, "accuracy_rating"),
    increasedAttackSpeedPercent: sumStat(allMods, "increased_attack_speed_percent"),
    increasedCastSpeedPercent: sumStat(allMods, "increased_cast_speed_percent"),
    increasedCriticalStrikeChancePercent: sumStat(allMods, "increased_critical_strike_chance_percent"),
    criticalDamageBonusPercent: sumStat(allMods, "critical_damage_bonus_percent"),
    otherDamageMods: allMods.filter((m) => /damage/i.test(m.raw)),
    note:
      "Gear-only aggregate: no skill gem, support gem, or 'more' multiplier data is available yet, so this is " +
      "not a DPS number -- it's the raw weapon/gear damage inputs an AI (or a future PoB2-backed calculator) " +
      "would need to compute one.",
  };
}
