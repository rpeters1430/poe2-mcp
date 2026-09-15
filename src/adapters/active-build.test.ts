import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearActiveBuild, getActiveBuildStatus, loadActiveBuildRecord, resolveActiveBuildRecord, saveActiveBuild } from "./active-build.js";
import { parsePobXml } from "../build/pob-parser.js";

function xml(level: number): string {
  return `<PathOfBuilding2><Build level="${level}" className="Witch"/><Items/><Skills/><Tree/></PathOfBuilding2>`;
}

test("stores provenance and refreshes a pinned file without changing its identity", async () => {
  const previousConfig = process.env.POE2_MCP_CONFIG_DIR;
  const previousBuilds = process.env.POE2_POB_BUILDS_PATH;
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "poe2-mcp-active-test-"));
  const config = path.join(parent, "config");
  const builds = path.join(parent, "Builds");
  fs.mkdirSync(config);
  fs.mkdirSync(builds);
  process.env.POE2_MCP_CONFIG_DIR = config;
  process.env.POE2_POB_BUILDS_PATH = builds;
  const file = path.join(builds, "example.xml");
  fs.writeFileSync(file, xml(10));
  const firstMtime = fs.statSync(file).mtime.toISOString();

  try {
    saveActiveBuild(parsePobXml(xml(10)), {
      origin: "explicit_file",
      pinned: true,
      sourcePath: file,
      sourceModifiedAt: firstMtime,
      identity: { characterName: "Example", league: "Standard" },
    });
    const stored = loadActiveBuildRecord();
    assert.equal(stored?.origin, "explicit_file");
    assert.equal(stored?.identity.characterName, "Example");

    fs.writeFileSync(file, xml(11));
    const future = new Date(Date.now() + 2_000);
    fs.utimesSync(file, future, future);
    const refreshed = await resolveActiveBuildRecord();
    assert.equal(refreshed?.build.level, 11);
    assert.equal(refreshed?.pinned, true);
    assert.equal(refreshed?.identity.characterName, "Example");

    const status = await getActiveBuildStatus();
    assert.equal(status.sourceFile, "example.xml");
    assert.equal(status.refreshable, true);
    assert.equal(clearActiveBuild(), true);
    assert.equal(clearActiveBuild(), false);
  } finally {
    if (previousConfig === undefined) delete process.env.POE2_MCP_CONFIG_DIR;
    else process.env.POE2_MCP_CONFIG_DIR = previousConfig;
    if (previousBuilds === undefined) delete process.env.POE2_POB_BUILDS_PATH;
    else process.env.POE2_POB_BUILDS_PATH = previousBuilds;
  }
});
