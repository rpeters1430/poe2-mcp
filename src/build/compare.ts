import type { DefenseStats, InventoryItem, InventorySnapshot, ItemComparison, ParsedItemText, StatDelta } from "../types.js";
import { parseMods, sumStat } from "./mod-parser.js";
import { computeDefenses } from "./defenses.js";
import { normalizeEquipmentSlot } from "./slots.js";

/**
 * Best-effort equipment-slot inference from an item's base type, used when
 * the caller doesn't specify `slot` explicitly. Keyed loosely on common base
 * type words -- extend if a base type category isn't matching. Ring slot
 * ambiguity (Ring vs Ring2) can't be resolved from text alone; callers with
 * two rings equipped should pass `slot` explicitly to target the right one.
 */
const SLOT_KEYWORDS: Array<{ pattern: RegExp; slot: string }> = [
  { pattern: /\bAmulet\b/i, slot: "Amulet" },
  { pattern: /\bRing\b/i, slot: "Ring" },
  { pattern: /\bBelt\b/i, slot: "Belt" },
  { pattern: /\b(Boots|Greaves)\b/i, slot: "Boots" },
  { pattern: /\b(Gloves|Gauntlets|Mitts)\b/i, slot: "Gloves" },
  { pattern: /\b(Helmet|Helm|Hood|Circlet|Bascinet|Burgonet)\b/i, slot: "Helm" },
  {
    pattern: /\b(Body Armour|Plate|Vest|Robe|Jacket|Chainmail|Hauberk|Wyrmscale|Ringmail|Leather|Coat|Garb)\b/i,
    slot: "BodyArmour",
  },
  { pattern: /\b(Shield|Buckler|Tower Shield|Kite Shield)\b/i, slot: "Offhand" },
  { pattern: /\b(Bow|Wand|Staff|Sword|Axe|Mace|Dagger|Claw|Spear|Crossbow|Flail|Sceptre|Quarterstaff)\b/i, slot: "Weapon" },
];

function inferSlot(baseType: string): string | null {
  for (const { pattern, slot } of SLOT_KEYWORDS) {
    if (pattern.test(baseType)) return slot;
  }
  return null;
}

function toInventoryItem(candidate: ParsedItemText, slot: string | null): InventoryItem {
  return {
    slot,
    name: candidate.name,
    baseType: candidate.baseType,
    rarity: candidate.rarity,
    itemLevel: candidate.itemLevel,
    identified: candidate.identified,
    mods: candidate.mods,
    properties: candidate.properties,
    corrupted: candidate.corrupted,
  };
}

/**
 * Diffs a pasted candidate item (already parsed by `item-text.ts`) against
 * whatever the given character currently has equipped in the matching slot,
 * both per-affix (`statDeltas`) and as a whole-loadout gear-only defense
 * swap (`defensesBefore`/`defensesAfter`, via `computeDefenses`).
 *
 * Only affixes `mod-parser.ts` recognizes produce a statDelta entry; every
 * mod's raw text is still returned in `current`/`candidate` regardless, so
 * nothing is silently lost -- the AI can still reason over unrecognized
 * affix text itself, same as everywhere else in this project.
 */
export function compareItem(
  inventory: InventorySnapshot,
  candidate: ParsedItemText,
  slotOverride?: string
): ItemComparison {
  const slot = normalizeEquipmentSlot(slotOverride ?? inferSlot(candidate.baseType));
  const current = slot
    ? inventory.equipment.find((item) => normalizeEquipmentSlot(item.slot) === slot) ?? null
    : null;

  const currentParsed = current ? parseMods(current.mods) : [];
  const candidateParsed = parseMods(candidate.mods);

  const stats = new Set<string>();
  for (const mod of currentParsed) for (const match of mod.matches) stats.add(match.stat);
  for (const mod of candidateParsed) for (const match of mod.matches) stats.add(match.stat);

  const statDeltas: StatDelta[] = [...stats].sort().map((stat) => {
    const before = current ? sumStat(currentParsed, stat) : null;
    const after = sumStat(candidateParsed, stat);
    return { stat, before, after, delta: before !== null ? after - before : null };
  });

  let defensesBefore: DefenseStats | null = null;
  let defensesAfter: DefenseStats | null = null;
  if (slot) {
    defensesBefore = computeDefenses(inventory);
    const swapped: InventorySnapshot = {
      ...inventory,
      equipment: [
        ...inventory.equipment.filter((item) => normalizeEquipmentSlot(item.slot) !== slot),
        toInventoryItem(candidate, slot),
      ],
    };
    defensesAfter = computeDefenses(swapped);
  }

  return {
    source: "computed",
    comparedAt: new Date().toISOString(),
    characterName: inventory.characterName,
    slot,
    current: current ? { name: current.name, mods: current.mods } : null,
    candidate: { name: candidate.name, mods: candidate.mods },
    statDeltas,
    defensesBefore,
    defensesAfter,
    note: slot
      ? "Gear-only comparison (see computeDefenses' note). Only recognized affixes produce a statDelta entry; " +
        "check `current`/`candidate` raw mods for anything that didn't."
      : "Could not determine which equipment slot this item belongs in from its base type -- pass `slot` " +
        "explicitly (e.g. 'Ring2' to target the second ring). No before/after comparison was computed.",
  };
}
