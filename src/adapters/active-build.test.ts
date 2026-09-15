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

test("does not mark a file-backed build stale just because it hasn't been re-checked recently", async () => {
  const previousConfig = process.env.POE2_MCP_CONFIG_DIR;
  const previousBuilds = process.env.POE2_POB_BUILDS_PATH;
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "poe2-mcp-active-stale-test-"));
  const config = path.join(parent, "config");
  const builds = path.join(parent, "Builds");
  fs.mkdirSync(config);
  fs.mkdirSync(builds);
  process.env.POE2_MCP_CONFIG_DIR = config;
  process.env.POE2_POB_BUILDS_PATH = builds;
  const file = path.join(builds, "example.xml");
  fs.writeFileSync(file, xml(10));
  const mtime = fs.statSync(file).mtime.toISOString();

  try {
    saveActiveBuild(parsePobXml(xml(10)), {
      origin: "explicit_file",
      pinned: true,
      sourcePath: file,
      sourceModifiedAt: mtime,
    });

    // Simulate the record having sat unchanged well past the poe.ninja TTL --
    // the source file itself hasn't changed, so this must not be reported stale.
    const recordPath = path.join(config, "active-build.json");
    const stored = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    stored.refreshedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    fs.writeFileSync(recordPath, JSON.stringify(stored, null, 2));

    const status = await getActiveBuildStatus();
    assert.equal(status.stale, false);
  } finally {
    if (previousConfig === undefined) delete process.env.POE2_MCP_CONFIG_DIR;
    else process.env.POE2_MCP_CONFIG_DIR = previousConfig;
    if (previousBuilds === undefined) delete process.env.POE2_POB_BUILDS_PATH;
    else process.env.POE2_POB_BUILDS_PATH = previousBuilds;
  }
});

test("refreshes poe.ninja identity metadata alongside the build once the TTL expires", async () => {
  const previousConfig = process.env.POE2_MCP_CONFIG_DIR;
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "poe2-mcp-active-ninja-test-"));
  const config = path.join(parent, "config");
  fs.mkdirSync(config);
  process.env.POE2_MCP_CONFIG_DIR = config;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/model/0")) {
      return new Response(JSON.stringify({
        type: "found",
        charModel: {
          account: "acc", name: "Char", league: "Standard", level: 90, class: "Witch",
          pathOfBuildingExport: xml(91),
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.match(/\/characters\/[^/]+\/0$/)) {
      return new Response(JSON.stringify([
        { name: "Char", level: 91, className: "Witch", league: "Standard", leagueUrl: "standard", isCurrent: true, updated: "2026-09-15T18:00:00Z" },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  try {
    saveActiveBuild(parsePobXml(xml(90)), {
      origin: "poe_ninja",
      pinned: true,
      sourceUpdatedAt: "2026-09-01T00:00:00Z",
      identity: { accountName: "acc", characterName: "Char", league: "Standard" },
    });

    const recordPath = path.join(config, "active-build.json");
    const stored = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    stored.refreshedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    fs.writeFileSync(recordPath, JSON.stringify(stored, null, 2));

    const refreshed = await resolveActiveBuildRecord();
    assert.equal(refreshed?.build.level, 91);
    assert.equal(refreshed?.sourceUpdatedAt, "2026-09-15T18:00:00Z");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousConfig === undefined) delete process.env.POE2_MCP_CONFIG_DIR;
    else process.env.POE2_MCP_CONFIG_DIR = previousConfig;
  }
});
