import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { configDir, resolveAccountName, resolvePobBuildsDir } from "../config.js";
import type {
  ActiveBuildIdentity,
  ActiveBuildOrigin,
  ActiveBuildRecord,
  ActiveBuildStatus,
  CharacterState,
  InventorySnapshot,
  PassiveTreeSnapshot,
  PobBuildSnapshot,
} from "../types.js";
import { listRecentPobBuilds, readPobBuildFile } from "./pob.js";
import { parsePobXml } from "../build/pob-parser.js";
import { resolvePobXml } from "../build/pob-decode.js";
import { fetchNinjaAsPobBuild, fetchNinjaCharacters } from "./poe-ninja.js";
import { resolveNodeNames } from "./tree-data.js";

export const ACTIVE_BUILD_REFRESH_MS = 5 * 60 * 1000;
// After a failed passive poe.ninja refresh, wait this long before retrying --
// every tool call routes through resolveActiveBuildRecord, so without a
// cooldown a prolonged outage or 429 would turn into a fresh upstream
// request on every single one. In-memory only: worth resetting on restart.
const REFRESH_RETRY_BACKOFF_MS = 60 * 1000;
const failedRefreshAttempts = new Map<string, number>();

function ninjaRefreshKey(identity: ActiveBuildIdentity): string {
  return `${identity.accountName ?? ""}::${identity.characterName ?? ""}::${identity.leagueUrl ?? identity.league ?? ""}`;
}

export function resetRefreshBackoffForTests(): void {
  failedRefreshAttempts.clear();
}

function activeBuildPath(): string {
  return path.join(configDir(), "active-build.json");
}

function emptyIdentity(): ActiveBuildIdentity {
  return { accountName: null, characterName: null, league: null, leagueUrl: null };
}

function isRecord(value: unknown): value is ActiveBuildRecord {
  return Boolean(
    value && typeof value === "object" &&
      (value as ActiveBuildRecord).version === 1 &&
      (value as ActiveBuildRecord).build
  );
}

function writeRecord(record: ActiveBuildRecord): void {
  const target = activeBuildPath();
  const temp = `${target}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, target);
  } catch (err) {
    try { fs.unlinkSync(temp); } catch {}
    throw err;
  }
}

export interface SaveActiveBuildOptions {
  origin: ActiveBuildOrigin;
  pinned: boolean;
  sourcePath?: string | null;
  sourceModifiedAt?: string | null;
  sourceUpdatedAt?: string | null;
  identity?: Partial<ActiveBuildIdentity>;
}

export function saveActiveBuild(build: PobBuildSnapshot, options: SaveActiveBuildOptions): ActiveBuildRecord {
  const now = new Date().toISOString();
  const record: ActiveBuildRecord = {
    version: 1,
    build,
    origin: options.origin,
    pinned: options.pinned,
    savedAt: now,
    refreshedAt: now,
    sourcePath: options.sourcePath ?? null,
    sourceModifiedAt: options.sourceModifiedAt ?? null,
    sourceUpdatedAt: options.sourceUpdatedAt ?? null,
    identity: { ...emptyIdentity(), ...options.identity },
  };
  writeRecord(record);
  return record;
}

export function loadActiveBuildRecord(): ActiveBuildRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(activeBuildPath(), "utf8")) as unknown;
    if (isRecord(parsed)) return parsed;
    const build = parsed as PobBuildSnapshot;
    if (!build?.equipment || !build?.passiveTree) return null;
    const importedAt = build.importedAt ?? new Date().toISOString();
    return {
      version: 1,
      build,
      origin: "legacy",
      pinned: true,
      savedAt: importedAt,
      refreshedAt: importedAt,
      sourcePath: null,
      sourceModifiedAt: null,
      sourceUpdatedAt: null,
      identity: emptyIdentity(),
    };
  } catch {
    return null;
  }
}

export function loadActiveBuild(): PobBuildSnapshot | null {
  return loadActiveBuildRecord()?.build ?? null;
}

function replaceRefreshed(
  record: ActiveBuildRecord,
  build: PobBuildSnapshot,
  sourceModifiedAt?: string,
  sourceUpdatedAt?: string
): ActiveBuildRecord {
  const updated: ActiveBuildRecord = {
    ...record,
    build,
    refreshedAt: new Date().toISOString(),
    sourceModifiedAt: sourceModifiedAt ?? record.sourceModifiedAt,
    sourceUpdatedAt: sourceUpdatedAt ?? record.sourceUpdatedAt,
  };
  writeRecord(updated);
  return updated;
}

async function refreshRecord(record: ActiveBuildRecord, force: boolean): Promise<ActiveBuildRecord> {
  if (record.sourcePath) {
    const buildsDir = resolvePobBuildsDir();
    if (!buildsDir) throw new Error("The configured PoB Builds directory is unavailable.");
    const modifiedAt = fs.statSync(record.sourcePath).mtime.toISOString();
    if (force || modifiedAt !== record.sourceModifiedAt) {
      const raw = readPobBuildFile(record.sourcePath, buildsDir);
      return replaceRefreshed(record, parsePobXml(await resolvePobXml(raw)), modifiedAt);
    }
    return record;
  }

  if (record.origin === "poe_ninja" || record.origin === "auto_poe_ninja") {
    const { accountName, characterName, league, leagueUrl } = record.identity;
    if (!accountName || !characterName || !(leagueUrl ?? league)) {
      throw new Error("This poe.ninja build has incomplete identity metadata; import it again.");
    }
    const age = Date.now() - Date.parse(record.refreshedAt);
    if (force || age >= ACTIVE_BUILD_REFRESH_MS) {
      const key = ninjaRefreshKey(record.identity);
      const lastFailedAt = failedRefreshAttempts.get(key);
      if (!force && lastFailedAt !== undefined && Date.now() - lastFailedAt < REFRESH_RETRY_BACKOFF_MS) {
        // Still cooling down after a recent failure -- serve the
        // last-known-good snapshot without hammering poe.ninja again.
        return record;
      }
      try {
        const build = await fetchNinjaAsPobBuild(accountName, leagueUrl ?? league!, characterName);
        let sourceUpdatedAt: string | undefined;
        try {
          const match = (await fetchNinjaCharacters(accountName)).find(
            (candidate) => candidate.name.toLowerCase() === characterName.toLowerCase()
          );
          sourceUpdatedAt = match?.updated;
        } catch {}
        failedRefreshAttempts.delete(key);
        return replaceRefreshed(record, build, undefined, sourceUpdatedAt);
      } catch (err) {
        // An explicit refresh_active_build call should fail loudly. A passive
        // TTL-triggered refresh (every tool call routes through this) must
        // not turn a transient poe.ninja outage/429 into a hard failure for
        // every inventory/defense/offense/trade call -- keep serving the
        // last-known-good snapshot; get_active_build_status still reports it
        // as stale via its own age check.
        if (force) throw err;
        failedRefreshAttempts.set(key, Date.now());
        console.error(`[poe2-mcp-server] poe.ninja refresh failed for ${characterName}, keeping last-known-good build:`, err);
        return record;
      }
    }
  }
  return record;
}

export async function resolveActiveBuildRecord(force = false): Promise<ActiveBuildRecord | null> {
  const stored = loadActiveBuildRecord();
  // Only an explicitly pinned record short-circuits straight to a refresh of
  // itself. An automatically-selected record must not go sticky: re-run the
  // selection cascade every time so a newer local PoB file, or poe.ninja
  // reporting a different "current" character/league, actually takes over
  // instead of this resolver refreshing whatever was auto-picked once.
  if (stored?.pinned) return refreshRecord(stored, force);
  return resolveAutomaticBuildRecord(stored);
}

async function resolveAutomaticBuildRecord(stored: ActiveBuildRecord | null): Promise<ActiveBuildRecord | null> {
  const pobDir = resolvePobBuildsDir();
  if (pobDir) {
    const recent = listRecentPobBuilds(pobDir);
    if (recent.length > 0) {
      const candidate = recent[0];
      if (stored?.origin === "auto_pob_file" && stored.sourcePath === candidate.path) {
        // Still the most recently modified local build -- reuse/refresh it
        // in place by mtime instead of reparsing on every call. A partially
        // written or momentarily invalid file must not make every resolver
        // call throw; fall back to the last-known-good snapshot instead,
        // same as the poe.ninja path below.
        try {
          return await refreshRecord(stored, false);
        } catch (err) {
          console.error(`[poe2-mcp-server] Failed to refresh local PoB build from ${candidate.path}, keeping last-known-good build:`, err);
          return stored;
        }
      }
      try {
        const build = parsePobXml(await resolvePobXml(readPobBuildFile(candidate.path, pobDir)));
        return saveActiveBuild(build, {
          origin: "auto_pob_file",
          pinned: false,
          sourcePath: candidate.path,
          sourceModifiedAt: candidate.modifiedAt,
        });
      } catch (err) {
        console.error(`[poe2-mcp-server] Failed to auto-load local PoB build from ${candidate.path}:`, err);
        if (stored?.origin === "auto_pob_file") return stored;
      }
    }
  }

  const account = resolveAccountName();
  if (account) {
    try {
      const chars = await fetchNinjaCharacters(account);
      const current = chars.find((c) => c.isCurrent) ?? chars[0];
      if (current) {
        if (
          stored?.origin === "auto_poe_ninja" &&
          stored.identity.accountName === account &&
          stored.identity.characterName === current.name &&
          stored.identity.leagueUrl === current.leagueUrl
        ) {
          return refreshRecord(stored, false);
        }
        const build = await fetchNinjaAsPobBuild(account, current.leagueUrl, current.name);
        return saveActiveBuild(build, {
          origin: "auto_poe_ninja",
          pinned: false,
          sourceUpdatedAt: current.updated,
          identity: {
            accountName: account, characterName: current.name,
            league: current.league, leagueUrl: current.leagueUrl,
          },
        });
      }
    } catch (err) {
      console.error(`[poe2-mcp-server] Failed to auto-load character from poe.ninja for ${account}:`, err);
      if (stored?.origin === "auto_poe_ninja") return stored;
    }
  }
  return stored ?? null;
}

export async function resolveActiveBuild(): Promise<PobBuildSnapshot | null> {
  return (await resolveActiveBuildRecord())?.build ?? null;
}

export async function refreshActiveBuild(): Promise<ActiveBuildRecord> {
  const record = loadActiveBuildRecord();
  if (!record) throw new Error("No active build is available to refresh.");
  if (!record.sourcePath && record.origin !== "poe_ninja" && record.origin !== "auto_poe_ninja") {
    throw new Error(
      record.origin === "manual"
        ? "This is a hand-tracked build with no PoB2/poe.ninja source to refresh from -- keep updating it with update_active_build_progress, or import a real build to replace it."
        : "This build came from pasted XML/share code and cannot be refreshed; import it again."
    );
  }
  return refreshRecord(record, true);
}

export interface UpdateActiveBuildProgressOptions {
  level?: number;
  className?: string;
  ascendClassName?: string;
  addPassiveNodeIds?: number[];
  removePassiveNodeIds?: number[];
}

function applyProgress(build: PobBuildSnapshot, options: UpdateActiveBuildProgressOptions): PobBuildSnapshot {
  const toRemove = new Set(options.removePassiveNodeIds ?? []);
  const merged = build.passiveTree.allocatedNodeIds.filter((id) => !toRemove.has(id));
  for (const id of options.addPassiveNodeIds ?? []) {
    if (!merged.includes(id) && !toRemove.has(id)) merged.push(id);
  }
  return {
    ...build,
    level: options.level ?? build.level,
    className: options.className ?? build.className,
    ascendClassName: options.ascendClassName ?? build.ascendClassName,
    passiveTree: { ...build.passiveTree, allocatedNodeIds: merged },
  };
}

/**
 * Hand-track level/passive-allocation progress the player reports in chat
 * (e.g. "I just hit level 34 and took Zealot's Oath") without requiring a
 * fresh PoB2 export or a poe.ninja profile -- the gap that otherwise leaves
 * an AI client with no tool to act on that kind of message. If no active
 * build exists yet, `className` is required and a fresh minimal build is
 * created (empty equipment/skills, source "manual"); if one exists, the
 * edit is applied on top of it and the record is pinned so automatic
 * PoB-file/poe.ninja re-selection doesn't silently discard the edit --
 * `refresh_active_build` (or a genuinely newer source file/poe.ninja sync)
 * remains the explicit way to discard manual edits and resync from the
 * original source.
 */
export function updateActiveBuildProgress(options: UpdateActiveBuildProgressOptions): ActiveBuildRecord {
  const stored = loadActiveBuildRecord();
  const now = new Date().toISOString();

  if (!stored) {
    if (!options.className) {
      throw new Error(
        "No active build exists yet. Provide 'className' to start hand-tracking one (e.g. right after a fresh " +
          "league start with no PoB export or poe.ninja profile yet), or import a real build first via " +
          "import_pob_build / import_poe_ninja_character / set_account_name."
      );
    }
    const build: PobBuildSnapshot = {
      source: "manual",
      importedAt: now,
      className: options.className,
      ascendClassName: options.ascendClassName ?? null,
      level: options.level ?? 1,
      equipment: [],
      skills: [],
      passiveTree: {
        classId: null,
        ascendClassId: null,
        allocatedNodeIds: [...new Set(options.addPassiveNodeIds ?? [])],
        masteryEffects: null,
      },
      playerStats: [],
      note:
        "Hand-tracked build with no PoB2/poe.ninja backing -- equipment and skills are empty until a real build " +
        "is imported. Only level and passive allocations reflect what's been reported via update_active_build_progress.",
    };
    const record: ActiveBuildRecord = {
      version: 1,
      build,
      origin: "manual",
      pinned: true,
      savedAt: now,
      refreshedAt: now,
      sourcePath: null,
      sourceModifiedAt: null,
      sourceUpdatedAt: null,
      identity: emptyIdentity(),
      manualEditsAt: now,
    };
    writeRecord(record);
    return record;
  }

  const updated: ActiveBuildRecord = {
    ...stored,
    build: applyProgress(stored.build, options),
    pinned: true,
    manualEditsAt: now,
  };
  writeRecord(updated);
  return updated;
}

export function clearActiveBuild(): boolean {
  try {
    fs.unlinkSync(activeBuildPath());
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function getActiveBuildStatus(): Promise<ActiveBuildStatus> {
  const record = await resolveActiveBuildRecord();
  if (!record) {
    return {
      available: false, origin: null, pinned: null, savedAt: null, refreshedAt: null,
      ageMs: null, stale: null, refreshable: false, sourceFile: null,
      sourceModifiedAt: null, sourceUpdatedAt: null, identity: null, buildSummary: null,
      manualEditsAt: null,
    };
  }
  const ageMs = Math.max(0, Date.now() - Date.parse(record.refreshedAt));
  // Only poe.ninja-backed records use a time-based refresh policy: file-backed
  // records are already re-synced against the source file's mtime by
  // resolveActiveBuildRecord() above, and a build with neither a source file
  // nor a remote identity (pasted XML/share code, or legacy state) has no
  // refresh mechanism at all, so age alone does not mean stale for either.
  const isRemote = record.origin === "poe_ninja" || record.origin === "auto_poe_ninja";
  return {
    available: true,
    origin: record.origin,
    pinned: record.pinned,
    savedAt: record.savedAt,
    refreshedAt: record.refreshedAt,
    ageMs,
    stale: isRemote ? ageMs >= ACTIVE_BUILD_REFRESH_MS : false,
    refreshable: Boolean(record.sourcePath) || isRemote,
    sourceFile: record.sourcePath ? path.basename(record.sourcePath) : null,
    sourceModifiedAt: record.sourceModifiedAt,
    sourceUpdatedAt: record.sourceUpdatedAt,
    identity: record.identity,
    manualEditsAt: record.manualEditsAt ?? null,
    buildSummary: {
      className: record.build.className,
      ascendClassName: record.build.ascendClassName,
      level: record.build.level,
      equipmentCount: record.build.equipment.length,
    },
  };
}

export function pobBuildToInventorySnapshot(build: PobBuildSnapshot, overrideName?: string): InventorySnapshot {
  return {
    source: build.source,
    fetchedAt: build.importedAt,
    characterName: overrideName ?? build.className ?? "Current Character",
    equipment: build.equipment,
    skills: [],
  };
}

export async function pobBuildToPassiveTree(build: PobBuildSnapshot, overrideName?: string): Promise<PassiveTreeSnapshot> {
  const allocatedHashes = build.passiveTree.allocatedNodeIds;
  const { resolvedNodes, note } = await resolveNodeNames(allocatedHashes);
  return {
    source: build.source,
    fetchedAt: build.importedAt,
    characterName: overrideName ?? build.className ?? "Current Character",
    ascendancyClass: build.ascendClassName,
    allocatedHashes,
    resolvedNodes,
    jewelData: {},
    note: `Derived from active PoB / poe.ninja build. ${note}`,
  };
}

export function pobBuildToCharacterState(build: PobBuildSnapshot, overrideName?: string): CharacterState {
  return {
    source: build.source,
    fetchedAt: build.importedAt,
    name: overrideName ?? build.className ?? "Active Build",
    characterClass: build.className ?? "Unknown",
    league: null,
    level: build.level ?? 1,
    experience: 0,
    hardcore: false,
  };
}
