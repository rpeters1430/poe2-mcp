import type { DefenseStats, InventoryItem, InventorySnapshot, ItemComparison, ParsedItemText, StatDelta } from "../types.js";
import { parseMods, sumStat } from "./mod-parser.js";
import { computeDefenses } from "./defenses.js";
import { normalizeEquipmentSlot } from "./slots.js";

/**
 * Best-effort equipment-slot inference from an item's base type, used when
 * the caller doesn't specify `slot` explicitly. Keyed loosely on common base
 * type words -- extend if a base type category isn't matching.
 */
const SLOT_KEYWORDS: Array<{ pattern: RegExp; slot: string }> = [
  { pattern: /\b(Amulet|Talisman|Torc|Pendant)\b/i, slot: "Amulet" },
  { pattern: /\bRing\b/i, slot: "Ring" },
  { pattern: /\b(Belt|Sash|Girdle)\b/i, slot: "Belt" },
  { pattern: /\b(Boots|Greaves|Sabatons|Sollerets|Shoes|Slippers|Footwraps)\b/i, slot: "Boots" },
  { pattern: /\b(Gloves|Gauntlets|Mitts|Bracers|Cuffs|Wraps)\b/i, slot: "Gloves" },
  { pattern: /\b(Helmet|Helm|Hood|Circlet|Bascinet|Burgonet|Tiara|Crown|Cowl|Mask|Greathelm|Sallet|Coif)\b/i, slot: "Helm" },
  {
    pattern: /\b(Body Armour|Plate|Vest|Robe|Jacket|Chainmail|Hauberk|Wyrmscale|Ringmail|Leather|Coat|Garb|Doublet|Tunic|Vestment|Mail|Cuirass|Brigandine)\b/i,
    slot: "BodyArmour",
  },
  { pattern: /\b(Shield|Buckler|Tower Shield|Kite Shield|Focus|Foci|Quiver)\b/i, slot: "Offhand" },
  { pattern: /\b(Bow|Wand|Staff|Sword|Axe|Mace|Dagger|Claw|Spear|Crossbow|Flail|Sceptre|Quarterstaff)\b/i, slot: "Weapon" },
];

export function inferSlotFromItemClass(itemClass?: string | null): string | null {
  if (!itemClass) return null;
  const lower = itemClass.trim().toLowerCase();
  if (lower.includes("helmet")) return "Helm";
  if (lower.includes("body armour") || lower.includes("body armor")) return "BodyArmour";
  if (lower.includes("glove")) return "Gloves";
  if (lower.includes("boot")) return "Boots";
  if (lower.includes("amulet")) return "Amulet";
  if (lower.includes("ring")) return "Ring";
  if (lower.includes("belt")) return "Belt";
  if (
    lower.includes("shield") ||
    lower.includes("buckler") ||
    lower.includes("foci") ||
    lower.includes("focus") ||
    lower.includes("quiver")
  ) {
    return "Offhand";
  }
  if (
    lower.includes("bow") ||
    lower.includes("crossbow") ||
    lower.includes("sword") ||
    lower.includes("axe") ||
    lower.includes("mace") ||
    lower.includes("dagger") ||
    lower.includes("claw") ||
    lower.includes("sceptre") ||
    lower.includes("staff") ||
    lower.includes("staves") ||
    lower.includes("quarterstaff") ||
    lower.includes("quarterstaves") ||
    lower.includes("wand") ||
    lower.includes("flail") ||
    lower.includes("spear")
  ) {
    return "Weapon";
  }
  return null;
}

export function inferSlot(baseType: string): string | null {
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

function scoreRingComparison(comp: ItemComparison): number {
  let score = 0;
  for (const delta of comp.statDeltas) {
    if (delta.delta === null) continue;
    if (delta.stat === "maximum_life") score += delta.delta * 2;
    else if (delta.stat === "maximum_energy_shield") score += delta.delta * 1.5;
    else if (delta.stat.endsWith("_resistance")) score += delta.delta * 1.5;
    else score += delta.delta;
  }
  return score;
}

function compareSingleSlot(
  inventory: InventorySnapshot,
  candidate: ParsedItemText,
  slot: string | null
): ItemComparison {
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

/**
 * Diffs a pasted candidate item (already parsed by `item-text.ts`) against
 * whatever the given character currently has equipped in the matching slot,
 * both per-affix (`statDeltas`) and as a whole-loadout gear-only defense
 * swap (`defensesBefore`/`defensesAfter`, via `computeDefenses`).
 *
 * When comparing a ring and no `slotOverride` is provided, compares against
 * both Ring 1 and Ring 2, selects the optimal replacement, and includes
 * detailed dual-ring comparison data in `ringComparisons`.
 */
export function compareItem(
  inventory: InventorySnapshot,
  candidate: ParsedItemText,
  slotOverride?: string
): ItemComparison {
  const inferred =
    inferSlotFromItemClass(candidate.itemClass) ?? inferSlot(candidate.baseType);
  const slot = normalizeEquipmentSlot(slotOverride ?? inferred);

  // Dual-ring comparison: when comparing a ring without an explicit slot override
  if (!slotOverride && slot === "Ring") {
    const ring1Comp = compareSingleSlot(inventory, candidate, "Ring");
    const ring2Comp = compareSingleSlot(inventory, candidate, "Ring2");

    const ring1Equipped = inventory.equipment.some((i) => normalizeEquipmentSlot(i.slot) === "Ring");
    const ring2Equipped = inventory.equipment.some((i) => normalizeEquipmentSlot(i.slot) === "Ring2");

    let recommendedSlot: "Ring" | "Ring2" = "Ring";
    let recommendationReason = "Defaulting to Ring slot.";

    if (ring1Equipped && ring2Equipped) {
      const score1 = scoreRingComparison(ring1Comp);
      const score2 = scoreRingComparison(ring2Comp);
      if (score2 > score1) {
        recommendedSlot = "Ring2";
        recommendationReason = `Replacing Ring 2 (${ring2Comp.current?.name ?? "Ring 2"}) gives a greater net improvement than replacing Ring 1 (${ring1Comp.current?.name ?? "Ring 1"}).`;
      } else {
        recommendedSlot = "Ring";
        recommendationReason = `Replacing Ring 1 (${ring1Comp.current?.name ?? "Ring 1"}) gives a greater or equal net improvement than replacing Ring 2 (${ring2Comp.current?.name ?? "Ring 2"}).`;
      }
    } else if (ring1Equipped && !ring2Equipped) {
      recommendedSlot = "Ring";
      recommendationReason = "Ring 2 is not equipped; comparing against equipped Ring.";
    } else if (!ring1Equipped && ring2Equipped) {
      recommendedSlot = "Ring2";
      recommendationReason = "Ring 1 is not equipped; comparing against equipped Ring 2.";
    } else {
      recommendedSlot = "Ring";
      recommendationReason = "No rings currently equipped; defaulting to Ring slot.";
    }

    const primary = recommendedSlot === "Ring2" ? ring2Comp : ring1Comp;
    return {
      ...primary,
      note:
        `${primary.note} Dual-ring comparison: evaluated against both Ring and Ring2. ` +
        `Showing recommended slot: ${recommendedSlot}. See 'ringComparisons' for full breakdown.`,
      ringComparisons: {
        ring1: ring1Comp,
        ring2: ring2Comp,
        recommendedSlot,
        recommendationReason,
      },
    };
  }

  return compareSingleSlot(inventory, candidate, slot);
}
