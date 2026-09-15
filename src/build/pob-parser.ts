import { XMLParser } from "fast-xml-parser";
import type { InventoryItem, ItemProperty, ParsedItemText, PobBuildSnapshot, PobGem, PobPassiveSpec, PobSkillGroup } from "../types.js";

/**
 * Parses a PoB2 build XML into a PobBuildSnapshot. Verified against a real
 * exported build (via pobb.in), which corrected two assumptions this file
 * originally made from source-reading alone:
 *
 * 1. The root element is `<PathOfBuilding2>`, not `<PathOfBuilding>` (PoB1's
 *    root tag -- the PoE2 fork renamed it).
 * 2. PoB2 does NOT reuse the "--------"-delimited clipboard item format
 *    `item-text.ts`'s `parseItemText` handles. Its own internal item text
 *    has no section delimiters at all: `Rarity: <RARITY>`, then 1 name line
 *    (Normal/Magic) or 2 (Rare/Unique: custom name, then base type), then
 *    loose `Key: Value` lines in no fixed order (`Armour:`, `Quality:`,
 *    `Charm Slots:`, `Unique ID:`, `Item Level:`, `LevelReq:`) ending in
 *    `Implicits: N`, after which every remaining line is a mod (first N
 *    implicit, rest explicit -- not distinguished here since InventoryItem's
 *    `mods` already merges implicit/explicit/crafted for the GGG-API path
 *    too). See `parsePobItemText` below -- kept separate from
 *    `item-text.ts`'s `parseItemText`, which remains correct for its own use
 *    case (compare_item's pasted clipboard/trade-site text).
 */

const ARRAY_ELEMENTS = new Set(["Item", "Slot", "ItemSet", "SkillSet", "Skill", "Gem", "Spec", "PlayerStat"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseAttributeValue: false,
  isArray: (name) => ARRAY_ELEMENTS.has(name),
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function num(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bool(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value === true || value === "true";
}

/**
 * PoB2's own internal item text format -- see the file-level doc comment
 * above for why this isn't `item-text.ts`'s `parseItemText`.
 */
function parsePobItemText(raw: string): ParsedItemText {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return { name: "Unknown", baseType: "Unknown", rarity: null, itemLevel: null, identified: true, corrupted: false, properties: [], mods: [] };
  }

  const rarityMatch = lines[0].match(/^Rarity:\s*(.+)$/i);
  const rarity = rarityMatch ? rarityMatch[1].trim() : null;
  const nameLineCount = rarity && /^(RARE|UNIQUE)$/i.test(rarity) ? 2 : 1;

  const name = lines[1] ?? "Unknown";
  const baseType = nameLineCount === 2 ? lines[2] ?? name : name;

  let idx = 1 + nameLineCount;
  let itemLevel: number | null = null;
  const properties: ItemProperty[] = [];

  while (idx < lines.length) {
    const kv = lines[idx].match(/^([A-Za-z][A-Za-z ]*):\s*(.*)$/);
    if (!kv) break;
    const key = kv[1].trim();
    const value = kv[2].trim();
    idx++;
    if (key === "Item Level") {
      const n = Number(value);
      if (Number.isFinite(n)) itemLevel = n;
      continue;
    }
    if (key === "Implicits") break; // remaining lines are mods -- see doc comment above
    properties.push({ name: key, values: [[value, 0]] }); // Unique ID, LevelReq, Quality, Armour, Charm Slots, ...
  }

  let corrupted = false;
  let identified = true;
  const mods: string[] = [];
  for (; idx < lines.length; idx++) {
    if (/^corrupted$/i.test(lines[idx])) {
      corrupted = true;
    } else if (/^unidentified$/i.test(lines[idx])) {
      identified = false;
    } else {
      mods.push(lines[idx]);
    }
  }

  return { name, baseType, rarity, itemLevel, identified, corrupted, properties, mods };
}

function parseEquipment(itemsNode: any): InventoryItem[] {
  if (!itemsNode) return [];

  const itemsById = new Map<string, ParsedItemText>();
  for (const item of asArray<any>(itemsNode.Item)) {
    const id = String(item["@_id"]);
    const raw = typeof item === "object" ? String(item["#text"] ?? "") : String(item);
    itemsById.set(id, parsePobItemText(raw));
  }

  const itemSets = asArray<any>(itemsNode.ItemSet);
  const activeItemSetId = itemsNode["@_activeItemSet"] != null ? String(itemsNode["@_activeItemSet"]) : null;
  const activeItemSet = itemSets.find((set) => String(set["@_id"]) === activeItemSetId) ?? itemSets[0];

  if (!activeItemSet) {
    return [...itemsById.values()].map((item) => ({ ...item, slot: null }));
  }

  const equipment: InventoryItem[] = [];
  for (const slot of asArray<any>(activeItemSet.Slot)) {
    const item = itemsById.get(String(slot["@_itemId"]));
    if (item) equipment.push({ ...item, slot: slot["@_name"] ?? null });
  }
  return equipment;
}

function parseSkills(skillsNode: any): PobSkillGroup[] {
  if (!skillsNode) return [];
  const skillSets = asArray<any>(skillsNode.SkillSet);
  const activeSkillSetId = skillsNode["@_activeSkillSet"] != null ? String(skillsNode["@_activeSkillSet"]) : null;
  const activeSkillSet = skillSets.find((set) => String(set["@_id"]) === activeSkillSetId) ?? skillSets[0];
  if (!activeSkillSet) return [];

  return asArray<any>(activeSkillSet.Skill).map(
    (skill): PobSkillGroup => ({
      label: skill["@_label"] ?? null,
      slot: skill["@_slot"] ?? null,
      enabled: bool(skill["@_enabled"], true),
      mainActiveSkill: num(skill["@_mainActiveSkill"]),
      gems: asArray<any>(skill.Gem).map(
        (gem): PobGem => ({
          nameSpec: gem["@_nameSpec"] ?? "Unknown",
          skillId: gem["@_skillId"] ?? null,
          level: num(gem["@_level"]),
          quality: num(gem["@_quality"]),
          enabled: bool(gem["@_enabled"], true),
        })
      ),
    })
  );
}

function parsePassiveTree(treeNode: any): PobPassiveSpec {
  const empty: PobPassiveSpec = { classId: null, ascendClassId: null, allocatedNodeIds: [], masteryEffects: null };
  if (!treeNode) return empty;

  const specs = asArray<any>(treeNode.Spec);
  if (specs.length === 0) return empty;

  // <Spec> has no id attribute of its own -- select by the (assumed 1-based,
  // Lua convention) activeSpec index, clamped into range rather than thrown
  // on if that assumption is ever wrong.
  const activeIndex = num(treeNode["@_activeSpec"]) ?? 1;
  const spec = specs[Math.min(Math.max(activeIndex - 1, 0), specs.length - 1)];

  const nodesAttr = spec["@_nodes"];
  const allocatedNodeIds =
    typeof nodesAttr === "string"
      ? nodesAttr
          .split(",")
          .map((n: string) => Number(n.trim()))
          .filter((n: number) => Number.isFinite(n))
      : [];

  return {
    classId: num(spec["@_classID"] ?? spec["@_classId"]),
    ascendClassId: num(spec["@_ascendClassID"] ?? spec["@_ascendClassId"]),
    allocatedNodeIds,
    masteryEffects: spec["@_masteryEffects"] ?? null,
  };
}

export function parsePobXml(xml: string): PobBuildSnapshot {
  const doc = parser.parse(xml);
  const root = doc.PathOfBuilding2 ?? doc.PathOfBuilding ?? doc;
  const buildNode = root.Build ?? {};

  const playerStats: PobBuildSnapshot["playerStats"] = [];
  for (const ps of asArray<any>(buildNode.PlayerStat)) {
    const stat = ps["@_stat"];
    const value = num(ps["@_value"]);
    if (typeof stat === "string" && value !== null) playerStats.push({ stat, value });
  }

  return {
    source: "pob_import",
    importedAt: new Date().toISOString(),
    className: buildNode["@_className"] ?? buildNode["@_class"] ?? null,
    ascendClassName: buildNode["@_ascendClassName"] ?? null,
    level: num(buildNode["@_level"]),
    equipment: parseEquipment(root.Items),
    skills: parseSkills(root.Skills),
    passiveTree: parsePassiveTree(root.Tree),
    playerStats,
    note:
      "playerStats are PoB2's own computed numbers as of whenever this build was last calculated/exported in " +
      "PoB2 -- they reflect full skill/support/passive-tree interactions, not a gear-only approximation -- but " +
      "may be stale relative to any in-game changes since. Passive tree node IDs are not resolved to " +
      "names/effects (same limitation as get_passive_tree).",
  };
}
