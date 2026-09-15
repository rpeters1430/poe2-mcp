import fs from "node:fs";
import path from "node:path";
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

function activeBuildPath(): string {
  return path.join(configDir(), "active-build.json");
}

function emptyIdentity(): ActiveBuildIdentity {
  return { accountName: null, characterName: null, league: null };
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
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
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
    const { accountName, characterName, league } = record.identity;
    if (!accountName || !characterName || !league) {
      throw new Error("This poe.ninja build has incomplete identity metadata; import it again.");
    }
    const age = Date.now() - Date.parse(record.refreshedAt);
    if (force || age >= ACTIVE_BUILD_REFRESH_MS) {
      const build = await fetchNinjaAsPobBuild(accountName, league, characterName);
      let sourceUpdatedAt: string | undefined;
      try {
        const match = (await fetchNinjaCharacters(accountName)).find(
          (candidate) => candidate.name.toLowerCase() === characterName.toLowerCase()
        );
        sourceUpdatedAt = match?.updated;
      } catch {}
      return replaceRefreshed(record, build, undefined, sourceUpdatedAt);
    }
  }
  return record;
}

export async function resolveActiveBuildRecord(force = false): Promise<ActiveBuildRecord | null> {
  const stored = loadActiveBuildRecord();
  if (stored) return refreshRecord(stored, force);

  const pobDir = resolvePobBuildsDir();
  if (pobDir) {
    const recent = listRecentPobBuilds(pobDir);
    if (recent.length > 0) {
      try {
        const build = parsePobXml(await resolvePobXml(readPobBuildFile(recent[0].path, pobDir)));
        return saveActiveBuild(build, {
          origin: "auto_pob_file",
          pinned: false,
          sourcePath: recent[0].path,
          sourceModifiedAt: recent[0].modifiedAt,
        });
      } catch (err) {
        console.error(`[poe2-mcp-server] Failed to auto-load local PoB build from ${recent[0].path}:`, err);
      }
    }
  }

  const account = resolveAccountName();
  if (account) {
    try {
      const chars = await fetchNinjaCharacters(account);
      const current = chars.find((c) => c.isCurrent) ?? chars[0];
      if (current) {
        const build = await fetchNinjaAsPobBuild(account, current.leagueUrl, current.name);
        return saveActiveBuild(build, {
          origin: "auto_poe_ninja",
          pinned: false,
          sourceUpdatedAt: current.updated,
          identity: { accountName: account, characterName: current.name, league: current.league },
        });
      }
    } catch (err) {
      console.error(`[poe2-mcp-server] Failed to auto-load character from poe.ninja for ${account}:`, err);
    }
  }
  return null;
}

export async function resolveActiveBuild(): Promise<PobBuildSnapshot | null> {
  return (await resolveActiveBuildRecord())?.build ?? null;
}

export async function refreshActiveBuild(): Promise<ActiveBuildRecord> {
  const record = loadActiveBuildRecord();
  if (!record) throw new Error("No active build is available to refresh.");
  if (!record.sourcePath && record.origin !== "poe_ninja" && record.origin !== "auto_poe_ninja") {
    throw new Error("This build came from pasted XML/share code and cannot be refreshed; import it again.");
  }
  return refreshRecord(record, true);
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
