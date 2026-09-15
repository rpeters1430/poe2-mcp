import type { ItemProperty } from "../types.js";

/**
 * Helpers for reading GGG's `properties`/`additionalProperties` shape: an
 * array of { name, values: [[valueString, augmentedFlag], ...] } entries.
 * These carry an item's BASE numeric stats (Armour, Evasion Rating, Energy
 * Shield, Physical/Elemental Damage ranges, Critical Strike Chance, Attacks
 * per Second, Chance to Block) -- distinct from the affix text in `mods`,
 * which `mod-parser.ts` handles separately.
 */

export function findProperty(properties: ItemProperty[], name: string): ItemProperty | null {
  return properties.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null;
}

function firstValueString(property: ItemProperty | null): string | null {
  if (!property) return null;
  const first = property.values[0];
  if (!first || first.length === 0) return null;
  return String(first[0]);
}

/** Parses a single numeric property value, e.g. "350" or "+12%" or "6.50". */
export function propertyNumber(properties: ItemProperty[], name: string): number | null {
  const raw = firstValueString(findProperty(properties, name));
  if (raw == null) return null;
  const cleaned = raw.replace(/[+%,]/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Parses a range property value like "20-40" into { min, max }; a bare number becomes min === max. */
export function propertyRange(properties: ItemProperty[], name: string): { min: number; max: number } | null {
  const raw = firstValueString(findProperty(properties, name));
  if (raw == null) return null;
  const cleaned = raw.replace(/[+%,]/g, "").trim();
  const rangeMatch = cleaned.match(/^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/);
  if (rangeMatch) return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
  const n = Number(cleaned);
  return Number.isFinite(n) ? { min: n, max: n } : null;
}
