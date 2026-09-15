import { test } from "node:test";
import assert from "node:assert/strict";
import { contributesToActiveCharacter, isActiveWeaponSlot, normalizeEquipmentSlot } from "./slots.js";

test("normalizes equivalent GGG and PoB slot names", () => {
  assert.equal(normalizeEquipmentSlot("Helmet"), "Helm");
  assert.equal(normalizeEquipmentSlot("Body Armour"), "BodyArmour");
  assert.equal(normalizeEquipmentSlot("Ring 1"), "Ring");
  assert.equal(normalizeEquipmentSlot("Weapon 1"), "Weapon");
  assert.equal(normalizeEquipmentSlot("Weapon 2"), "Offhand");
  assert.equal(normalizeEquipmentSlot("Weapon2"), "Weapon2");
  assert.equal(normalizeEquipmentSlot("Weapon 1 Swap"), "Weapon2");
  assert.equal(normalizeEquipmentSlot("Weapon 2 Swap"), "Offhand2");
});

test("excludes swap weapons, flasks, and charms from active totals", () => {
  assert.equal(contributesToActiveCharacter("Weapon 1 Swap"), false);
  assert.equal(contributesToActiveCharacter("Flask 1"), false);
  assert.equal(contributesToActiveCharacter("Charm 2"), false);
  assert.equal(contributesToActiveCharacter("Body Armour"), true);
});

test("recognizes active main-hand and off-hand weapon slots", () => {
  assert.equal(isActiveWeaponSlot("Weapon 1"), true);
  assert.equal(isActiveWeaponSlot("Offhand"), true);
  assert.equal(isActiveWeaponSlot("Weapon 1 Swap"), false);
});
