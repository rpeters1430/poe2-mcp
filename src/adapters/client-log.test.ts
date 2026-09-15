import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLine } from "./client-log.js";

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
