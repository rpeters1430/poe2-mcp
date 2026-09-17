import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  saveLatestClipboardItem,
  getLatestClipboardItem,
  clearLatestClipboardItem,
} from "./clipboard-store.js";

const sampleItem = `Item Class: Boots
Rarity: Rare
Bramble Sole
Titan Greaves
--------
Armour: 142
--------
Requirements:
Level: 65
Str: 120
--------
Item Level: 78
--------
+75 to maximum Life
+32% to Cold Resistance
+28% to Lightning Resistance
25% increased Movement Speed`;

test("stores, parses, and retrieves the latest copied item", () => {
  const previousConfig = process.env.POE2_MCP_CONFIG_DIR;
  const tempConfig = fs.mkdtempSync(path.join(os.tmpdir(), "poe2-mcp-clip-test-"));
  process.env.POE2_MCP_CONFIG_DIR = tempConfig;

  try {
    clearLatestClipboardItem();
    assert.equal(getLatestClipboardItem(), null);

    const saved = saveLatestClipboardItem(sampleItem);
    assert.equal(saved.parsed.name, "Bramble Sole");
    assert.equal(saved.parsed.baseType, "Titan Greaves");
    assert.equal(saved.parsed.rarity, "Rare");

    const retrieved = getLatestClipboardItem();
    assert.ok(retrieved);
    assert.equal(retrieved?.parsed.name, "Bramble Sole");
    assert.equal(retrieved?.parsed.baseType, "Titan Greaves");

    clearLatestClipboardItem();
    assert.equal(getLatestClipboardItem(), null);
  } finally {
    if (previousConfig === undefined) delete process.env.POE2_MCP_CONFIG_DIR;
    else process.env.POE2_MCP_CONFIG_DIR = previousConfig;
    fs.rmSync(tempConfig, { recursive: true, force: true });
  }
});
