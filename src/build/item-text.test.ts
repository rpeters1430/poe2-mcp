import { test } from "node:test";
import assert from "node:assert/strict";
import { parseItemText } from "./item-text.js";

const RARE_ITEM = `Item Class: Body Armours
Rarity: Rare
Doom Weave
Vaal Regalia
--------
Quality: +20% (augmented)
Energy Shield: 245 (augmented)
--------
Requires: Level 65, 128 Int
--------
Item Level: 82
--------
+45 to maximum Life
+30% increased Energy Shield
--------
Corrupted`;

test("parses name/base type for a rare item with two header lines", () => {
  const parsed = parseItemText(RARE_ITEM);
  assert.equal(parsed.rarity, "Rare");
  assert.equal(parsed.name, "Doom Weave");
  assert.equal(parsed.baseType, "Vaal Regalia");
  assert.equal(parsed.itemClass, "Body Armours");
  assert.equal(parsed.itemLevel, 82);
  assert.equal(parsed.corrupted, true);
});

test("strips '(augmented)' suffix from property values", () => {
  const parsed = parseItemText(RARE_ITEM);
  const es = parsed.properties.find((p) => p.name === "Energy Shield");
  assert.equal(es?.values[0][0], "245");
});

test("keeps unrecognized mod lines in mods, not dropped", () => {
  const parsed = parseItemText(RARE_ITEM);
  assert.deepEqual(parsed.mods, ["+45 to maximum Life", "+30% increased Energy Shield"]);
});

test("a Magic item with one header line uses it as both name and base type", () => {
  const magic = `Rarity: Magic\nHeavy Belt of the Fox\n--------\n+20 to maximum Life`;
  const parsed = parseItemText(magic);
  assert.equal(parsed.name, "Heavy Belt of the Fox");
  assert.equal(parsed.baseType, "Heavy Belt of the Fox");
});

test("Unidentified marks identified false", () => {
  const parsed = parseItemText(`Rarity: Rare\nMystery\nAmulet\n--------\nUnidentified`);
  assert.equal(parsed.identified, false);
});

test("strips advanced mod headers and cleans roll range brackets", () => {
  const advancedText = `Item Class: Body Armours
Rarity: Rare
Kraken Coat
Hexer's Robe
--------
Energy Shield: 121 (augmented)
--------
Requires: Level 26, 21 Int
--------
Item Level: 43
--------
{ Prefix Modifier "Resolute" (Tier: 6) — Energy Shield }
53(43-55)% increased Energy Shield
{ Prefix Modifier "Glowing" (Tier: 8) — Energy Shield }
+34(31-35) to maximum Energy Shield
{ Suffix Modifier "of Iron Skin" (Tier: 7) }
+50(50-72) to Stun Threshold
{ Suffix Modifier "of the Storm" (Tier: 6) — Elemental, Lightning, Resistance }
+20(16-20)% to Lightning Resistance`;

  const parsed = parseItemText(advancedText);
  assert.equal(parsed.name, "Kraken Coat");
  assert.equal(parsed.baseType, "Hexer's Robe");
  assert.equal(parsed.itemClass, "Body Armours");
  assert.deepEqual(parsed.mods, [
    "53% increased Energy Shield",
    "+34 to maximum Energy Shield",
    "+50 to Stun Threshold",
    "+20% to Lightning Resistance",
  ]);
});
