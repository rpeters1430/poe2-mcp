import { test } from "node:test";
import assert from "node:assert/strict";
import { findProperty, propertyNumber, propertyRange } from "./item-properties.js";
import type { ItemProperty } from "../types.js";

const properties: ItemProperty[] = [
  { name: "Armour", values: [["350", 1]] },
  { name: "Critical Strike Chance", values: [["+6.50%", 0]] },
  { name: "Physical Damage", values: [["20-40", 0]] },
];

test("findProperty is case-insensitive", () => {
  assert.equal(findProperty(properties, "armour")?.name, "Armour");
  assert.equal(findProperty(properties, "Nonexistent"), null);
});

test("propertyNumber strips +/%/, and parses a bare or augmented number", () => {
  assert.equal(propertyNumber(properties, "Armour"), 350);
  assert.equal(propertyNumber(properties, "Critical Strike Chance"), 6.5);
  assert.equal(propertyNumber(properties, "Nonexistent"), null);
});

test("propertyRange parses 'min-max' and falls back to min === max for a bare number", () => {
  assert.deepEqual(propertyRange(properties, "Physical Damage"), { min: 20, max: 40 });
  assert.deepEqual(propertyRange(properties, "Armour"), { min: 350, max: 350 });
  assert.equal(propertyRange(properties, "Nonexistent"), null);
});
