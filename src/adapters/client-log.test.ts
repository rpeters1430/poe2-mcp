import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClientLogTailer, parseLine } from "./client-log.js";

const prefix = "2026/09/15 12:34:56 123456789 abcdef [INFO Client 1234] ";

test("parses a genuine system area event", () => {
  const event = parseLine(`${prefix}: You have entered Riverbank.`);
  assert.equal(event.type, "area_entered");
  assert.equal(event.data.area, "Riverbank");
});

test("a whisper cannot spoof a death event", () => {
  const event = parseLine(`${prefix}: @From Troll: Ryan has been slain.`);
  assert.equal(event.type, "trade_whisper");
  assert.equal(event.data.untrusted, true);
  assert.equal(event.data.message, "Ryan has been slain.");
});

test("global chat cannot spoof an area event", () => {
  const event = parseLine(`${prefix}: #Troll: You have entered Hideout.`);
  assert.equal(event.type, "player_message");
  assert.equal(event.data.untrusted, true);
});

test("guild chat cannot spoof a death event", () => {
  const event = parseLine(`${prefix}: <Guild> Troll: Ryan has been slain.`);
  assert.equal(event.type, "player_message");
  assert.equal(event.data.untrusted, true);
});

test("raw diagnostics cannot evict recognized events from session state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poe2-mcp-log-test-"));
  const logPath = path.join(dir, "Client.txt");
  const lines = [`${prefix}: You have entered Riverbank.`];
  for (let i = 0; i < 501; i += 1) lines.push(`${prefix}: unrelated diagnostic ${i}`);
  fs.writeFileSync(logPath, `${lines.join("\n")}\n`);

  const tailer = new ClientLogTailer(logPath);
  await (tailer as unknown as { pollOnce(): Promise<void> }).pollOnce();
  assert.equal(tailer.getCurrentArea().area, "Riverbank");
  assert.equal(tailer.getSessionSummary().areasVisited, 1);
  assert.equal(tailer.getRecentEvents().some((event) => event.type === "raw_unmatched"), false);
  assert.equal(
    tailer.getRecentEvents({ types: ["raw_unmatched"], limit: 500 }).length,
    500
  );
});

test("waits for full newline and handles split chunk writes cleanly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poe2-mcp-log-split-test-"));
  const logPath = path.join(dir, "Client.txt");
  fs.writeFileSync(logPath, "");

  const tailer = new ClientLogTailer(logPath);
  tailer.start();

  // Write first half of a line (without newline)
  fs.appendFileSync(logPath, `${prefix}: You have en`);
  await (tailer as unknown as { pollOnce(): Promise<void> }).pollOnce();

  // Nothing should be parsed yet
  assert.equal(tailer.getCurrentArea().area, null);

  // Write the remaining part with newline
  fs.appendFileSync(logPath, `tered The Riverbank.\n`);
  await (tailer as unknown as { pollOnce(): Promise<void> }).pollOnce();

  // Now it successfully parsed the full line
  assert.equal(tailer.getCurrentArea().area, "The Riverbank");
  tailer.stop();
});

