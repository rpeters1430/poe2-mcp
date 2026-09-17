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
