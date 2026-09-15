import fs from "node:fs";
import path from "node:path";
import { configDir, resolveAccountName, resolvePobBuildsDir } from "../config.js";
import type {
  CharacterState,
  InventorySnapshot,
  PassiveTreeSnapshot,
  PobBuildSnapshot,
} from "../types.js";
import { listRecentPobBuilds, readPobBuildFile } from "./pob.js";
import { parsePobXml } from "../build/pob-parser.js";
import { resolvePobXml } from "../build/pob-decode.js";
import { fetchNinjaAsPobBuild, fetchNinjaCharacters } from "./poe-ninja.js";

function activeBuildPath(): string {
  return path.join(configDir(), "active-build.json");
}

export function saveActiveBuild(build: PobBuildSnapshot): void {
  try {
    fs.writeFileSync(activeBuildPath(), JSON.stringify(build, null, 2), "utf8");
  } catch (err) {
    console.error("[poe2-mcp-server] Failed to save active build:", err);
  }
}

export function loadActiveBuild(): PobBuildSnapshot | null {
  try {
    const raw = fs.readFileSync(activeBuildPath(), "utf8");
    return JSON.parse(raw) as PobBuildSnapshot;
  } catch {
    return null;
  }
}

/**
 * Resolves the active build using a graceful priority cascade:
 * 1. An explicitly saved/imported active build (from import_pob_build or poe.ninja)
 * 2. Most recently modified .xml build file in the user's local PoB2 directory
 * 3. Latest character from poe.ninja if POE2_ACCOUNT_NAME is configured
 */
export async function resolveActiveBuild(): Promise<PobBuildSnapshot | null> {
  // 1. Stored active build
  const stored = loadActiveBuild();
  if (stored) return stored;

  // 2. Local PoB directory
  const pobDir = resolvePobBuildsDir();
  if (pobDir) {
    const recent = listRecentPobBuilds(pobDir);
    if (recent.length > 0) {
      try {
        const raw = readPobBuildFile(recent[0].path);
        const xml = await resolvePobXml(raw);
        const build = parsePobXml(xml);
        saveActiveBuild(build);
        return build;
      } catch (err) {
        console.error(
          `[poe2-mcp-server] Failed to auto-load local PoB build from ${recent[0].path}:`,
          err
        );
      }
    }
  }

  // 3. poe.ninja account fallback
  const account = resolveAccountName();
  if (account) {
    try {
      const chars = await fetchNinjaCharacters(account);
      const current = chars.find((c) => c.isCurrent) ?? chars[0];
      if (current) {
        const build = await fetchNinjaAsPobBuild(account, current.leagueUrl, current.name);
        saveActiveBuild(build);
        return build;
      }
    } catch (err) {
      console.error(`[poe2-mcp-server] Failed to auto-load character from poe.ninja for ${account}:`, err);
    }
  }

  return null;
}

export function pobBuildToInventorySnapshot(
  build: PobBuildSnapshot,
  overrideName?: string
): InventorySnapshot {
  return {
    source: (build.source as any) ?? "pob_import",
    fetchedAt: build.importedAt,
    characterName: overrideName ?? build.className ?? "Current Character",
    equipment: build.equipment,
    skills: [],
  };
}

export function pobBuildToPassiveTree(
  build: PobBuildSnapshot,
  overrideName?: string
): PassiveTreeSnapshot {
  return {
    source: (build.source as any) ?? "pob_import",
    fetchedAt: build.importedAt,
    characterName: overrideName ?? build.className ?? "Current Character",
    ascendancyClass: build.ascendClassName,
    allocatedHashes: build.passiveTree.allocatedNodeIds,
    jewelData: {},
    note:
      "Derived from active PoB / poe.ninja build. Allocated passive node IDs are hashes, not resolved to names.",
  };
}

export function pobBuildToCharacterState(
  build: PobBuildSnapshot,
  overrideName?: string
): CharacterState {
  return {
    source: (build.source as any) ?? "pob_import",
    fetchedAt: build.importedAt,
    name: overrideName ?? build.className ?? "Active Build",
    characterClass: build.className ?? "Unknown",
    league: null,
    level: build.level ?? 1,
    experience: 0,
    hardcore: false,
  };
}
