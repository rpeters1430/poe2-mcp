// Handler bodies shared between the MCP tool layer (register.ts) and the
// REST layer (../web/api.ts) for the subset of tools the web dashboard
// needs -- kept in one place so the GGG-API-then-active-build fallback
// logic can't drift between the two surfaces. See CLAUDE.md's "Adding a
// new tool" section and PROTOCOL.md for the underlying data-source rules;
// this file doesn't change any of that, it only relocates the existing
// per-tool bodies out of register.ts's inline callbacks.

import fs from "node:fs";
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
import { resolveAccountName, resolvePobBuildsDir, saveAccountName } from "../config.js";
import { fetchNinjaCharacters, fetchNinjaAsPobBuild, parseNinjaProfileUrl } from "../adapters/poe-ninja.js";
import {
  resolveActiveBuildRecord,
  getActiveBuildStatus as fetchActiveBuildStatus,
  pobBuildToInventorySnapshot,
  pobBuildToPassiveTree,
  pobBuildToCharacterState,
  saveActiveBuild,
  refreshActiveBuild,
  updateActiveBuildProgress,
  type UpdateActiveBuildProgressOptions,
} from "../adapters/active-build.js";
import { parsePobXml } from "../build/pob-parser.js";
import { resolvePobXml } from "../build/pob-decode.js";
import { validatePobBuildFile, readPobBuildFile } from "../adapters/pob.js";
import { getLatestClipboardItem } from "../adapters/clipboard-store.js";
import { createTradeSearch, findTradeUpgrades, type FindTradeUpgradesOptions } from "../adapters/trade.js";
import { resolveNodeNames, searchNodesByName, findNearbyPassiveUpgrades } from "../adapters/tree-data.js";
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
  if (explicit && explicit.trim()) return explicit.trim();
  const active = await getActiveCharacter(log);
  if (active.name) return active.name;

  const build = await resolveActiveBuildRecord();
  if (build?.identity.characterName) {
    return build.identity.characterName;
  }
  if (build?.build.className) {
    return build.build.className;
  }

  throw new Error(active.message ?? "No active character set. Call set_active_character or pass characterName.");
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

export async function getCharacterState(characterName?: string) {
  if (characterName) {
    try {
      return await fetchCharacterState(characterName);
    } catch {}
  }

  // Check active build first
  const active = await resolveActiveBuildRecord();
  if (active) {
    if (!characterName || active.identity.characterName?.toLowerCase() === characterName.toLowerCase()) {
      const state = pobBuildToCharacterState(active.build, active.identity.characterName ?? characterName);
      if (active.identity.league) state.league = active.identity.league;
      return state;
    }
  }

  // Check poe.ninja for account
  const account = resolveAccountName();
  if (account) {
    try {
      const chars = await fetchNinjaCharacters(account);
      const found = characterName
        ? chars.find((c) => c.name.toLowerCase() === characterName.toLowerCase())
        : chars.find((c) => c.isCurrent) ?? chars[0];
      if (found) {
        const build = await fetchNinjaAsPobBuild(account, found.leagueUrl, found.name);
        const state = pobBuildToCharacterState(build, found.name);
        state.league = found.league;
        return state;
      }
    } catch {}
  }

  throw new Error(
    characterName
      ? `Could not find character "${characterName}" via GGG API, active build, or poe.ninja.`
      : "No active character found. Please import a build from PoB or poe.ninja, or configure an account."
  );
}

export async function getInventory(characterName: string | undefined, log: ClientLogTailer) {
  let primaryError: unknown;
  try {
    const name = await resolveCharacterName(characterName, log);
    return await fetchInventorySnapshot(name);
  } catch (err) {
    primaryError = err;
  }
  const active = await resolveActiveBuildRecord();
  if (active) {
    if (!characterName || active.identity.characterName?.toLowerCase() === characterName.toLowerCase()) {
      return {
        ...pobBuildToInventorySnapshot(active.build, active.identity.characterName ?? undefined),
        activeBuild: activeBuildContext(active),
      };
    }
  }
  throw primaryError;
}

export async function getDefenses(characterName: string | undefined, log: ClientLogTailer) {
  let primaryError: unknown;
  try {
    const name = await resolveCharacterName(characterName, log);
    return computeDefenses(await fetchInventorySnapshot(name));
  } catch (err) {
    primaryError = err;
  }
  const active = await resolveActiveBuildRecord();
  if (active) {
    if (!characterName || active.identity.characterName?.toLowerCase() === characterName.toLowerCase()) {
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
  }
  throw primaryError;
}

export async function getOffenseStats(characterName: string | undefined, log: ClientLogTailer) {
  let primaryError: unknown;
  try {
    const name = await resolveCharacterName(characterName, log);
    return computeOffenseStats(await fetchInventorySnapshot(name));
  } catch (err) {
    primaryError = err;
  }
  const active = await resolveActiveBuildRecord();
  if (active) {
    if (!characterName || active.identity.characterName?.toLowerCase() === characterName.toLowerCase()) {
      return {
        ...computeOffenseStats(pobBuildToInventorySnapshot(active.build, active.identity.characterName ?? undefined)),
        activeBuild: activeBuildContext(active),
      };
    }
  }
  throw primaryError;
}

export async function getPassiveTree(characterName: string | undefined, log: ClientLogTailer) {
  let primaryError: unknown;
  try {
    const name = await resolveCharacterName(characterName, log);
    return await fetchPassiveTree(name);
  } catch (err) {
    primaryError = err;
  }
  const active = await resolveActiveBuildRecord();
  if (active) {
    if (!characterName || active.identity.characterName?.toLowerCase() === characterName.toLowerCase()) {
      return {
        ...(await pobBuildToPassiveTree(active.build, active.identity.characterName ?? undefined)),
        activeBuild: activeBuildContext(active),
      };
    }
  }
  throw primaryError;
}

export async function findPassiveTreeUpgradesHandler(
  characterName: string | undefined,
  log: ClientLogTailer,
  options: { maxHops?: number; limit?: number; includeMasteries?: boolean }
) {
  const tree = await getPassiveTree(characterName, log);
  const result = await findNearbyPassiveUpgrades(tree.allocatedHashes, options);
  return {
    ...result,
    characterName: tree.characterName,
    allocatedCount: tree.allocatedHashes.length,
  };
}

export async function getSkillSetupHandler(characterName: string | undefined, log: ClientLogTailer) {
  const active = await resolveActiveBuildRecord();
  if (active && (!characterName || active.identity.characterName?.toLowerCase() === characterName.toLowerCase())) {
    return {
      source: active.build.source,
      fetchedAt: active.build.importedAt,
      characterName: active.identity.characterName ?? active.build.className ?? characterName ?? "Current Character",
      skillGroups: active.build.skills,
      activeBuild: activeBuildContext(active),
      note:
        "Each group is one linked skill setup, from a PoB2/poe.ninja export: 'mainActiveSkill' is the index " +
        "(into 'gems') of the active skill gem, and every other entry in that group's 'gems' is a support gem " +
        "attached to it. Not available for GGG-API-only characters with no active build imported.",
    };
  }

  // No PoB/poe.ninja build to fall back on -- GGG's API returns skill/support
  // gems as a flat item list with no confirmed support-to-skill link data for
  // PoE2, so this can only heuristically flag likely support gems by name
  // (GGG consistently suffixes support gem names with "Support"), not group
  // them by the skill they're attached to.
  const name = await resolveCharacterName(characterName, log);
  const inventory = await fetchInventorySnapshot(name);
  return {
    source: inventory.source,
    fetchedAt: inventory.fetchedAt,
    characterName: inventory.characterName,
    gems: inventory.skills.map((item) => ({
      name: item.name,
      baseType: item.baseType,
      likelySupport: /support/i.test(item.baseType) || /support/i.test(item.name),
      properties: item.properties,
    })),
    note:
      "GGG's official API returns skill/support gems as a flat list with no verified support-to-skill link data " +
      "for PoE2 -- 'likelySupport' is a name-based heuristic, not confirmed grouping. Import a build via " +
      "import_pob_build or import_poe_ninja_character for accurate per-skill support setups.",
  };
}

export async function importPobBuildHandler(codeOrFilePath: string, isFilePath = false) {
  let raw: string;
  let sourceFile: string | null = null;
  let sourceModifiedAt: string | null = null;
  if (isFilePath) {
    const buildsDir = resolvePobBuildsDir();
    if (!buildsDir) {
      throw new Error("Set POE2_POB_BUILDS_PATH before importing a local build file.");
    }
    sourceFile = validatePobBuildFile(codeOrFilePath, buildsDir);
    sourceModifiedAt = fs.statSync(sourceFile).mtime.toISOString();
    raw = readPobBuildFile(sourceFile, buildsDir);
  } else {
    raw = codeOrFilePath;
  }
  const xml = await resolvePobXml(raw);
  const parsed = parsePobXml(xml);
  const record = saveActiveBuild(parsed, {
    origin: isFilePath ? "explicit_file" : "explicit_code",
    pinned: true,
    sourcePath: sourceFile,
    sourceModifiedAt,
    identity: {
      characterName: parsed.className ? `${parsed.className}` : null,
    },
  });
  return {
    success: true,
    record,
    summary: {
      className: parsed.className,
      ascendClassName: parsed.ascendClassName,
      level: parsed.level,
      equipmentCount: parsed.equipment.length,
      skillsCount: parsed.skills.length,
      playerStatsCount: parsed.playerStats?.length ?? 0,
    },
  };
}

export async function importPoeNinjaCharacterHandler(options: {
  profileUrl?: string;
  accountName?: string;
  characterName?: string;
  league?: string;
}) {
  let acc = options.accountName ?? resolveAccountName();
  let l = options.league;
  let char = options.characterName;
  let identityLeague: string | undefined;
  let sourceUpdatedAt: string | undefined;

  if (options.profileUrl) {
    const parsed = parseNinjaProfileUrl(options.profileUrl);
    if (!parsed) {
      throw new Error(
        "Invalid poe.ninja URL format. Expected: https://poe.ninja/poe2/profile/<account>/<league>/character/<name>"
      );
    }
    acc = parsed.account;
    l = parsed.league;
    char = parsed.character;
  }

  if (!acc) {
    throw new Error("No account name provided. Pass accountName, a full poe.ninja profileUrl, or configure an account.");
  }

  if (!char || !l) {
    const chars = await fetchNinjaCharacters(acc);
    const match = char
      ? chars.find((c) => c.name.toLowerCase() === char!.toLowerCase())
      : chars.find((c) => c.isCurrent) ?? chars[0];
    if (!match) {
      throw new Error(
        `Character "${char ?? "current"}" not found on poe.ninja for account "${acc}". Available: ${chars
          .map((c) => c.name)
          .join(", ")}`
      );
    }
    char = match.name;
    l = match.leagueUrl;
    identityLeague = match.league;
    sourceUpdatedAt = match.updated;
  } else {
    // Both were already provided -- still prefer poe.ninja's own leagueUrl
    // slug over whatever the caller passed before fetching, since a display
    // name like "Rise of the Abyssal" does not reliably normalize to the
    // real slug ("roa"). Best-effort: an unreachable poe.ninja here just
    // means the caller-provided `l` is used as-is below.
    try {
      const match = (await fetchNinjaCharacters(acc)).find(
        (candidate) => candidate.name.toLowerCase() === char!.toLowerCase()
      );
      if (match) {
        l = match.leagueUrl;
        identityLeague = match.league;
        sourceUpdatedAt = match.updated;
      }
    } catch {}
  }

  const build = await fetchNinjaAsPobBuild(acc, l, char);
  const displayLeague = identityLeague ?? l;

  const record = saveActiveBuild(build, {
    origin: "poe_ninja",
    pinned: true,
    sourceUpdatedAt,
    identity: {
      accountName: acc,
      characterName: char,
      league: displayLeague,
      leagueUrl: l,
    },
  });

  pinActiveCharacter(char);

  return {
    success: true,
    record,
    summary: {
      account: acc,
      character: char,
      league: displayLeague,
      className: build.className,
      ascendClassName: build.ascendClassName,
      level: build.level,
      equipmentCount: build.equipment.length,
      skillsCount: build.skills.length,
      playerStatsCount: build.playerStats?.length ?? 0,
    },
  };
}

export async function setAccountNameHandler(accountName: string) {
  try {
    saveAccountName(accountName);
    const chars = await fetchNinjaCharacters(accountName);
    return {
      message: `Account name saved as "${accountName}". Verified on poe.ninja: found ${chars.length} characters.`,
      characters: chars,
    };
  } catch (err) {
    // Still saved -- poe.ninja may just be unreachable, or the account's
    // character tab may be private. Report the check's failure without
    // treating the save itself as failed.
    saveAccountName(accountName);
    return {
      message: `Account name saved as "${accountName}". Note: poe.ninja check returned: ${
        err instanceof Error ? err.message : String(err)
      }. Ensure your PoE profile character tab is set to public.`,
    };
  }
}

export interface FindTradeUpgradesHandlerOptions {
  slot: FindTradeUpgradesOptions["slot"];
  priorities: FindTradeUpgradesOptions["priorities"];
  minimumGain?: number;
  maxPrice: number;
  currency: string;
  maxRequiredLevel?: number;
  league?: string;
  characterName?: string;
  resultLimit?: number;
}

export async function findTradeUpgradesHandler(options: FindTradeUpgradesHandlerOptions, log: ClientLogTailer) {
  let inventory: InventorySnapshot;
  let resolvedLeague = options.league;
  let activeBuild: ActiveBuildRecord | null = null;
  try {
    const name = await resolveCharacterName(options.characterName, log);
    inventory = await fetchInventorySnapshot(name);
    if (!resolvedLeague) resolvedLeague = (await fetchCharacterState(name)).league ?? undefined;
  } catch (primaryError) {
    if (options.characterName) throw primaryError;
    const record = await resolveActiveBuildRecord();
    if (record) {
      activeBuild = record;
      inventory = pobBuildToInventorySnapshot(record.build, record.identity.characterName ?? undefined);
      resolvedLeague ??= record.identity.league ?? undefined;
    } else {
      // When GGG OAuth tokens and active build are both unavailable, fall back to a baseline
      // empty inventory so the trade search and official link generation can still proceed!
      inventory = {
        source: "pob_import",
        fetchedAt: new Date().toISOString(),
        characterName: "Player",
        equipment: [],
        skills: [],
      };
      resolvedLeague ??= "Standard";
    }
  }
  resolvedLeague ??= "Standard";
  const result = await findTradeUpgrades({
    inventory,
    league: resolvedLeague,
    slot: options.slot,
    priorities: options.priorities,
    minimumGain: options.minimumGain,
    maxPrice: options.maxPrice,
    currency: options.currency,
    maxRequiredLevel: options.maxRequiredLevel,
    resultLimit: options.resultLimit,
  });
  return activeBuild ? { ...result, activeBuild: activeBuildContext(activeBuild) } : result;
}

export async function refreshActiveBuildHandler() {
  const record = await refreshActiveBuild();
  return {
    success: true,
    record,
    status: await fetchActiveBuildStatus(),
  };
}

export async function getActiveBuildStatus() {
  return fetchActiveBuildStatus();
}

export async function updateActiveBuildProgressHandler(options: UpdateActiveBuildProgressOptions) {
  const record = updateActiveBuildProgress(options);
  const [addedNodes, removedNodes] = await Promise.all([
    options.addPassiveNodeIds?.length ? resolveNodeNames(options.addPassiveNodeIds) : null,
    options.removePassiveNodeIds?.length ? resolveNodeNames(options.removePassiveNodeIds) : null,
  ]);
  return {
    success: true,
    record,
    status: await fetchActiveBuildStatus(),
    applied: {
      level: options.level ?? null,
      className: options.className ?? null,
      ascendClassName: options.ascendClassName ?? null,
      addedNodes: addedNodes?.resolvedNodes ?? [],
      removedNodes: removedNodes?.resolvedNodes ?? [],
    },
  };
}

export async function searchPassiveTreeNodesHandler(query: string, limit?: number) {
  return searchNodesByName(query, limit);
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
    const active = await resolveActiveBuildRecord();
    if (!active) {
      throw new Error(
        "No inventory available from GGG API and no active PoB/poe.ninja build found. " +
          "Import a build using import_pob_build or configure an account with set_account_name."
      );
    }
    if (characterName && active.identity.characterName && active.identity.characterName.toLowerCase() !== characterName.toLowerCase()) {
      throw primaryError;
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
