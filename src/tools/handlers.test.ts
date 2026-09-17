import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getServerStatus } from "./handlers.js";
import { ClientLogTailer } from "../adapters/client-log.js";

test("getServerStatus returns structured diagnostic status", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poe2-server-status-test-"));
  const logPath = path.join(dir, "Client.txt");
  fs.writeFileSync(logPath, "2026/09/16 12:00:00 123 456 [INFO Client 1] : You have entered Lioneye's Watch.\n");

  const tailer = new ClientLogTailer(logPath);
  await (tailer as unknown as { pollOnce(): Promise<void> }).pollOnce();

  const status = await getServerStatus(tailer);

  assert.equal(status.status, "healthy");
  assert.equal(typeof status.version, "string");
  assert.equal(typeof status.uptimeSeconds, "number");
  assert.equal(status.gameLog.tailing, true);
  assert.equal(status.gameLog.currentArea, "Lioneye's Watch");
  assert.equal(status.gameLog.session.areasVisited, 1);
  assert.ok(status.endpoints.restApi.status);
  assert.ok(status.endpoints.mcpHttp);
});
