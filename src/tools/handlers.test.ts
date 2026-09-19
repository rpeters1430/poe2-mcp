import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getServerStatus,
  getSkillSetupHandler,
  importPobBuildHandler,
  importPoeNinjaCharacterHandler,
  setAccountNameHandler,
} from "./handlers.js";
import { ClientLogTailer } from "../adapters/client-log.js";

function withTempConfigDir<T>(fn: (config: string) => Promise<T>): Promise<T> {
  const previous = process.env.POE2_MCP_CONFIG_DIR;
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "poe2-mcp-handlers-test-"));
  const config = path.join(parent, "config");
  fs.mkdirSync(config);
  process.env.POE2_MCP_CONFIG_DIR = config;
  return fn(config).finally(() => {
    if (previous === undefined) delete process.env.POE2_MCP_CONFIG_DIR;
    else process.env.POE2_MCP_CONFIG_DIR = previous;
  });
}

function xml(className: string): string {
  return `<PathOfBuilding2><Build level="42" className="${className}"/><Items/><Skills/><Tree/></PathOfBuilding2>`;
}

// Regression test: the MCP tool (register.ts's import_pob_build) used to
// save the active build without an identity.characterName, unlike the REST
// path (handlers.importPobBuildHandler) -- resolveCharacterName's fallback
// chain reads that field, so the two surfaces resolved the current
// character differently after an otherwise identical import. Both now go
// through this one handler.
test("importPobBuildHandler sets identity.characterName from the parsed build", async () => {
  await withTempConfigDir(async () => {
    const result = await importPobBuildHandler(xml("Witch"), false);
    assert.equal(result.success, true);
    assert.equal(result.record.identity.characterName, "Witch");
    assert.equal(result.summary.className, "Witch");
  });
});

// Regression test: the MCP tool (register.ts's import_poe_ninja_character)
// used to skip pinActiveCharacter after saving the build, unlike the REST
// path -- importing the same character via chat vs. the dashboard left
// get_current_character pointing at different things afterward. Both now
// go through this one handler, which always pins.
test("importPoeNinjaCharacterHandler pins the active character after import", async () => {
  await withTempConfigDir(async (config) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/model/0")) {
        return new Response(
          JSON.stringify({
            type: "found",
            charModel: {
              account: "acc",
              name: "Char",
              league: "Rise of the Abyssal",
              level: 90,
              class: "Witch",
              pathOfBuildingExport: xml("Witch"),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.match(/\/characters\/[^/]+\/0$/)) {
        return new Response(
          JSON.stringify([
            { name: "Char", level: 90, className: "Witch", league: "Rise of the Abyssal", leagueUrl: "roa", isCurrent: true, updated: "2026-01-01T00:00:00.000Z" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    try {
      // accountName + characterName + league are all provided up front, to
      // exercise the "already provided" branch that refines the leagueUrl
      // slug via poe.ninja before fetching -- not just the "look it up"
      // branch.
      const result = await importPoeNinjaCharacterHandler({
        accountName: "acc",
        characterName: "Char",
        league: "roa",
      });
      assert.equal(result.record.identity.leagueUrl, "roa");
      assert.equal(result.record.identity.league, "Rise of the Abyssal");

      const activeCharacterPath = path.join(config, "active-character.json");
      const stored = JSON.parse(fs.readFileSync(activeCharacterPath, "utf8"));
      assert.equal(stored.name, "Char");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("setAccountNameHandler saves the account name even when the poe.ninja check fails", async () => {
  await withTempConfigDir(async (config) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network unreachable");
    }) as typeof fetch;
    try {
      const result = await setAccountNameHandler("rpeters1428-1042");
      assert.match(result.message, /saved as "rpeters1428-1042"/);
      const stored = JSON.parse(fs.readFileSync(path.join(config, "account-name.json"), "utf8"));
      assert.equal(stored.accountName, "rpeters1428-1042");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("getSkillSetupHandler returns the active PoB build's accurate skill/support groups", async () => {
  await withTempConfigDir(async () => {
    const xml = `<PathOfBuilding2><Build level="42" className="Witch"/><Items/>
      <Skills activeSkillSet="1">
        <SkillSet id="1">
          <Skill label="Main" slot="Body Armour" enabled="true" mainActiveSkill="1">
            <Gem nameSpec="Fireball" skillId="Fireball" level="20" quality="20" enabled="true"/>
            <Gem nameSpec="Spell Echo Support" skillId="SupportSpellEcho" level="20" quality="20" enabled="true"/>
          </Skill>
        </SkillSet>
      </Skills>
      <Tree/></PathOfBuilding2>`;
    await importPobBuildHandler(xml, false);

    const result = await getSkillSetupHandler(undefined, new ClientLogTailer("nonexistent-client-log.txt"));
    assert.equal(result.source, "pob_import");
    assert.equal(result.skillGroups.length, 1);
    assert.equal(result.skillGroups[0].mainActiveSkill, 1);
    assert.deepEqual(
      result.skillGroups[0].gems.map((g) => g.nameSpec),
      ["Fireball", "Spell Echo Support"]
    );
    assert.match(result.note, /accurate|PoB2\/poe\.ninja export/);
  });
});

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
