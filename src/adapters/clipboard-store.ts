import fs from "node:fs";
import path from "node:path";
import { configDir } from "../config.js";
import { parseItemText } from "../build/item-text.js";
import type { ParsedItemText } from "../types.js";

export interface StoredClipboardItem {
  text: string;
  copiedAt: string;
  parsed: ParsedItemText;
}

let inMemoryLatestItem: StoredClipboardItem | null = null;

function clipboardStorePath(): string {
  return path.join(configDir(), "latest-clipboard-item.json");
}

/**
 * Saves the latest item text copied via Ctrl+C, parses it, and persists
 * it so that both in-process memory and other tools/instances can read it.
 */
export function saveLatestClipboardItem(text: string): StoredClipboardItem {
  const parsed = parseItemText(text);
  const record: StoredClipboardItem = {
    text,
    copiedAt: new Date().toISOString(),
    parsed,
  };
  inMemoryLatestItem = record;
  try {
    fs.writeFileSync(clipboardStorePath(), JSON.stringify(record, null, 2), "utf8");
  } catch (err) {
    console.error("[poe2-mcp-server] Failed to persist latest clipboard item:", err);
  }
  return record;
}

/**
 * Retrieves the most recent clipboard item. Checks memory first, then disk.
 */
export function getLatestClipboardItem(): StoredClipboardItem | null {
  if (inMemoryLatestItem) return inMemoryLatestItem;
  try {
    const file = clipboardStorePath();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as StoredClipboardItem;
      inMemoryLatestItem = data;
      return data;
    }
  } catch {}
  return null;
}

/**
 * Clears the latest clipboard item cache.
 */
export function clearLatestClipboardItem(): void {
  inMemoryLatestItem = null;
  try {
    const file = clipboardStorePath();
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {}
}
