import type { ItemProperty, ParsedItemText } from "../types.js";

/**
 * Parses the standard PoE clipboard item format (Ctrl+C on an item in-game,
 * or copied from a trade site) into the same shape `InventoryItem` uses, so
 * it can be diffed against gear fetched from the GGG API (see `compare.ts`).
 *
 * Format (sections separated by a line of dashes):
 *   Item Class: ...
 *   Rarity: Rare
 *   <Name>          <- only present for Rare/Unique; Normal/Magic have one line
 *   <Base Type>
 *   --------
 *   Quality: +20% (augmented)
 *   Armour: 456 (augmented)
 *   --------
 *   Requires: Level 60, 128 Str
 *   --------
 *   Item Level: 82
 *   --------
 *   +45 to maximum Life
 *   --------
 *   Corrupted
 *
 * This is a stable, widely-relied-upon text format (every PoE trading tool
 * parses it), but not one GGG formally specs -- unrecognized lines are kept
 * in `mods` rather than dropped, same safety-valve philosophy as
 * `client-log.ts` and `mod-parser.ts`.
 */

const PROPERTY_LINE = /^([A-Za-z][A-Za-z ]*):\s*(.+)$/;
const SKIP_PREFIXES = ["Requires:", "Item Class:", "Level:"];

function stripAugmented(value: string): string {
  return value.replace(/\s*\(augmented\)\s*$/i, "").trim();
}

export function parseItemText(clipboard: string): ParsedItemText {
  const sections = clipboard
    .replace(/\r\n/g, "\n")
    .split(/^-{5,}$/m)
    .map((section) =>
      section
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    )
    .filter((lines) => lines.length > 0);

  const header = sections[0] ?? [];
  let rarity: string | null = null;
  let name = "Unknown";
  let baseType = "Unknown";

  const rarityLineIndex = header.findIndex((line) => line.startsWith("Rarity:"));
  if (rarityLineIndex >= 0) {
    rarity = header[rarityLineIndex].slice("Rarity:".length).trim();
    const rest = header.slice(rarityLineIndex + 1);
    if ((rarity === "Rare" || rarity === "Unique") && rest.length >= 2) {
      name = rest[0];
      baseType = rest[1];
    } else if (rest.length >= 1) {
      name = rest[0];
      baseType = rest[0];
    }
  } else if (header.length > 0) {
    baseType = header[header.length - 1];
    name = baseType;
  }

  let itemLevel: number | null = null;
  let identified = true;
  let corrupted = false;
  const properties: ItemProperty[] = [];
  const mods: string[] = [];

  for (const section of sections.slice(1)) {
    for (const line of section) {
      if (line === "Corrupted") {
        corrupted = true;
        continue;
      }
      if (line === "Unidentified") {
        identified = false;
        continue;
      }
      if (line.startsWith("Item Level:")) {
        const n = Number(line.slice("Item Level:".length).trim());
        if (Number.isFinite(n)) itemLevel = n;
        continue;
      }
      if (SKIP_PREFIXES.some((prefix) => line.startsWith(prefix))) {
        continue;
      }
      const propMatch = line.match(PROPERTY_LINE);
      if (propMatch) {
        properties.push({ name: propMatch[1].trim(), values: [[stripAugmented(propMatch[2]), 0]] });
        continue;
      }
      mods.push(line);
    }
  }

  return { name, baseType, rarity, itemLevel, identified, corrupted, properties, mods };
}
