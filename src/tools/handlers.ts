// Handler bodies shared between the MCP tool layer (register.ts) and the
// REST layer (../web/api.ts) for the subset of tools the web dashboard
// needs -- kept in one place so the GGG-API-then-active-build fallback
// logic can't drift between the two surfaces. See CLAUDE.md's "Adding a
// new tool" section and PROTOCOL.md for the underlying data-source rules;
// this file doesn't change any of that, it only relocates the existing
// per-tool bodies out of register.ts's inline callbacks.

import type { ClientLogTailer } from "../adapters/client-log.js";
import {
  fetchCharacterState,
  fetchInventorySnapshot,
  fetchPassiveTree,
  listCharacterNames,
} from "../adapters/ggg-api.js";
import {
  getActiveCharacter,
  setActiveCharacter as pinActiveCharacter,
} from "../adapters/active-character.js";
import { computeDefenses } from "../build/defenses.js";
import { computeOffenseStats } from "../build/offense.js";
import { parseItemText } from "../build/item-text.js";
import { compareItem as compareItemCore } from "../build/compare.js";
import { resolveAccountName } from "../config.js";
import { fetchNinjaCharacters, fetchNinjaAsPobBuild } from "../adapters/poe-ninja.js";
import {
  resolveActiveBuildRecord,
  getActiveBuildStatus as fetchActiveBuildStatus,
  pobBuildToInventorySnapshot,
  pobBuildToPassiveTree,
  pobBuildToCharacterState,
} from "../adapters/active-build.js";
import { getLatestClipboardItem } from "../adapters/clipboard-store.js";
import { createTradeSearch } from "../adapters/trade.js";
import type { ActiveBuildRecord, GameEventType, InventorySnapshot, TradeSearchOptions } from "../types.js";

export function activeBuildContext(record: ActiveBuildRecord) {
  const ageMs = Math.max(0, Date.now() - Date.parse(record.refreshedAt));
  return {
    origin: record.origin,
    pinned: record.pinned,
    refreshedAt: record.refreshedAt,
    ageMs,
    identity: record.identity,
  };
}

export async function resolveCharacterName(explicit: string | undefined, log: ClientLogTailer): Promise<string> {
  if (explicit) return explicit;
  const active = await getActiveCharacter(log);
  if (!active.name) {
    throw new Error(active.message ?? "No active character set. Call set_active_character or pass characterName.");
  }
  return active.name;
}

export async function getCurrentCharacter(log: ClientLogTailer) {
  return getActiveCharacter(log);
}

export async function setActiveCharacter(characterName: string) {
  let names: string[];
  try {
    names = await listCharacterNames();
  } catch {
    const account = resolveAccountName();
    if (account) {
      const ninjaChars = await fetchNinjaCharacters(account);
      names = ninjaChars.map((c) => c.name);
    } else {
      names = [characterName];
    }
  }
  if (!names.includes(characterName)) {
    throw new Error(`"${characterName}" is not one of this account's characters: ${names.join(", ")}`);
  }
  return pinActiveCharacter(characterName);
}

export async function getCharacterState(characterName: string) {
  try {
    return await fetchCharacterState(characterName);
  } catch (err) {
    const account = resolveAccountName();
    if (account) {
      try {
        const chars = await fetchNinjaCharacters(account);
        const found = chars.find((c) => c.name.toLowerCase() === characterName.toLowerCase());
        if (found) {
          const build = await fetchNinjaAsPobBuild(account, found.leagueUrl, found.name);
          return pobBuildToCharacterState(build, found.name);
        }
      } catch {}
    }
    throw err;
  }
}

export async function getInventory(characterName: string | undefined, log: ClientLogTailer) {
  let primaryError: unknown;
  try {
    const name = await resolveCharacterName(characterName, log);
    return await fetchInventorySnapshot(name);
  } catch (err) {
    primaryError = err;
  }
  if (characterName) throw primaryError;
  const active = await resolveActiveBuildRecord();
  if (active) {
    return {
      ...pobBuildToInventorySnapshot(active.build, active.identity.characterName ?? undefined),
      activeBuild: activeBuildContext(active),
    };
  }
  throw primaryError;
}

export async function getDefenses(characterName: string | undefined, log: ClientLogTailer) {
  try {
    const name = await resolveCharacterName(characterName, log);
    return computeDefenses(await fetchInventorySnapshot(name));
  } catch (err) {
    if (characterName) throw err;
    const active = await resolveActiveBuildRecord();
    if (active) {
      const inventory = pobBuildToInventorySnapshot(active.build, active.identity.characterName ?? undefined);
      const computed = computeDefenses(inventory);
      return {
        ...computed,
        pobComputedStats: active.build.playerStats?.slice(0, 30),
        activeBuild: activeBuildContext(active),
        note:
          "Computed from active PoB / poe.ninja build. Includes PoB's simulated stats alongside gear-only aggregations.",
      };
    }
    throw err;
  }
}

export async function getOffenseStats(characterName: string | undefined, log: ClientLogTailer) {
  try {
    const name = await resolveCharacterName(characterName, log);
    return computeOffenseStats(await fetchInventorySnapshot(name));
  } catch (err) {
    if (characterName) throw err;
    const active = await resolveActiveBuildRecord();
    if (active) {
      return {
        ...computeOffenseStats(pobBuildToInventorySnapshot(active.build, active.identity.characterName ?? undefined)),
        activeBuild: activeBuildContext(active),
      };
    }
    throw err;
  }
}

export async function getPassiveTree(characterName: string | undefined, log: ClientLogTailer) {
  try {
    const name = await resolveCharacterName(characterName, log);
    return await fetchPassiveTree(name);
  } catch (err) {
    if (characterName) throw err;
    const active = await resolveActiveBuildRecord();
    if (active) {
      return {
        ...(await pobBuildToPassiveTree(active.build, active.identity.characterName ?? undefined)),
        activeBuild: activeBuildContext(active),
      };
    }
    throw err;
  }
}

export async function getActiveBuildStatus() {
  return fetchActiveBuildStatus();
}

export function getLatestClipboardItemTool() {
  const latest = getLatestClipboardItem();
  if (!latest) {
    return {
      available: false,
      message:
        "No item has been copied yet via Ctrl+C. Ensure the clipboard watcher is running on your gaming PC (npm run watch-clipboard) and copy an item in Path of Exile 2 using Ctrl+C.",
    };
  }
  const diffMs = Date.now() - new Date(latest.copiedAt).getTime();
  return {
    available: true,
    copiedAt: latest.copiedAt,
    secondsAgo: Math.max(0, Math.round(diffMs / 1000)),
    itemName: latest.parsed.name,
    baseType: latest.parsed.baseType,
    rarity: latest.parsed.rarity,
    itemText: latest.text,
    parsed: latest.parsed,
  };
}

export async function compareItem(
  itemText: string | undefined,
  slot: string | undefined,
  characterName: string | undefined,
  log: ClientLogTailer
) {
  let text = itemText?.trim();
  let clipboardInfo: { copiedAt: string; secondsAgo: number } | undefined;
  if (!text || text.toLowerCase() === "latest") {
    const latest = getLatestClipboardItem();
    if (!latest) {
      throw new Error(
        "No itemText was provided, and no item has been copied with Ctrl+C yet. " +
          "Copy an item in Path of Exile 2 using Ctrl+C (with 'npm run watch-clipboard' running on your gaming PC), " +
          "or pass itemText explicitly."
      );
    }
    text = latest.text;
    const diffMs = Date.now() - new Date(latest.copiedAt).getTime();
    clipboardInfo = {
      copiedAt: latest.copiedAt,
      secondsAgo: Math.max(0, Math.round(diffMs / 1000)),
    };
  }

  let inventory: InventorySnapshot;
  let activeBuildCtx: ReturnType<typeof activeBuildContext> | undefined;
  try {
    const name = await resolveCharacterName(characterName, log);
    inventory = await fetchInventorySnapshot(name);
  } catch (primaryError) {
    if (characterName) throw primaryError;
    const active = await resolveActiveBuildRecord();
    if (!active) {
      throw new Error(
        "No inventory available from GGG API and no active PoB/poe.ninja build found. " +
          "Import a build using import_pob_build or configure an account with set_account_name."
      );
    }
    inventory = pobBuildToInventorySnapshot(active.build, active.identity.characterName ?? undefined);
    activeBuildCtx = activeBuildContext(active);
  }
  const result = compareItemCore(inventory, parseItemText(text), slot);
  return {
    ...result,
    ...(clipboardInfo ? { clipboard: clipboardInfo } : {}),
    ...(activeBuildCtx ? { activeBuild: activeBuildCtx } : {}),
  };
}

export function getRecentEvents(
  log: ClientLogTailer,
  opts: { sinceIso?: string; limit?: number; types?: GameEventType[] }
) {
  return {
    source: "client_log" as const,
    queriedAt: new Date().toISOString(),
    logAvailable: log.getLogPath() !== null,
    events: log.getRecentEvents(opts),
  };
}

export function getCurrentArea(log: ClientLogTailer) {
  return log.getCurrentArea();
}

export function getSessionSummary(log: ClientLogTailer) {
  return log.getSessionSummary();
}

export async function getServerStatus(log: ClientLogTailer) {
  const uptimeSeconds = Math.floor(process.uptime());

  let activeCharacterName: string | null = null;
  let activeCharacterSource = "none";
  try {
    const charState = await getActiveCharacter(log);
    activeCharacterName = charState.name;
    activeCharacterSource = charState.source;
  } catch {}

  let buildStatus = null;
  try {
    buildStatus = await fetchActiveBuildStatus();
  } catch {}

  const logPath = log.getLogPath();
  const currentArea = log.getCurrentArea();
  const sessionSummary = log.getSessionSummary();

  const latestItem = getLatestClipboardItem();
  const clipboardStatus = latestItem
    ? {
        hasItem: true,
        copiedAt: latestItem.copiedAt,
        secondsAgo: Math.max(0, Math.round((Date.now() - new Date(latestItem.copiedAt).getTime()) / 1000)),
        name: latestItem.parsed.name,
        baseType: latestItem.parsed.baseType,
        rarity: latestItem.parsed.rarity,
        itemClass: latestItem.parsed.itemClass ?? null,
      }
    : {
        hasItem: false,
        copiedAt: null,
        secondsAgo: null,
        name: null,
        baseType: null,
        rarity: null,
        itemClass: null,
      };

  const accountName = resolveAccountName();

  return {
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: "0.1.0",
    uptimeSeconds,
    account: {
      accountName: accountName ?? null,
    },
    activeCharacter: {
      name: activeCharacterName,
      source: activeCharacterSource,
    },
    activeBuild: buildStatus,
    gameLog: {
      tailing: logPath !== null,
      logConfigured: logPath !== null,
      currentArea: currentArea.area,
      enteredAreaAt: currentArea.enteredAt,
      session: {
        startedAt: sessionSummary.sessionStartedAt,
        areasVisited: sessionSummary.areasVisited,
        deaths: sessionSummary.deaths,
        levelUps: sessionSummary.levelUps,
      },
    },
    clipboard: clipboardStatus,
    endpoints: {
      mcpHttp: "/mcp",
      webDashboard: "/",
      webSocket: "/ws",
      restApi: {
        status: "/api/status",
        clipboard: "/api/clipboard-item",
        compare: "/api/compare-item",
        activeBuild: "/api/active-build-status",
        events: "/api/recent-events",
        tradeSearch: "/api/trade/search",
      },
    },
  };
}

export async function createTradeSearchHandler(options: TradeSearchOptions) {
  let resolvedLeague = options.league;
  if (!resolvedLeague) {
    const active = await resolveActiveBuildRecord();
    resolvedLeague = active?.identity.league ?? "Standard";
  }
  return createTradeSearch({ ...options, league: resolvedLeague });
}
