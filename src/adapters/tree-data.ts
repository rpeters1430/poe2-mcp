import fs from "node:fs";
import path from "node:path";
import { configDir } from "../config.js";
import type { ResolvedPassiveNode } from "../types.js";

/**
 * Resolves GGG's raw allocated passive-tree node hashes (see
 * `fetchPassiveTree` in `ggg-api.ts` / `PobPassiveSpec.allocatedNodeIds` from
 * a PoB2 import) to human-readable names/stats, using GGG's own official PoE2
 * tree export: https://github.com/grindinggear/poe2-skilltree-export
 * (data.json). That's the PoE2 sibling of the long-standing, community-
 * documented PoE1 export at github.com/grindinggear/skilltree-export, whose
 * "nodes" object is keyed by node id with fields including id/dn (display
 * name)/icon/stats (or sd)/isKeystone (or ks)/isNotable (or not)/isMastery
 * (or m)/ascendancyName.
 *
 * IMPORTANT: the field names below are inferred from that well-documented
 * PoE1 sibling format, NOT verified against a live fetch of PoE2's actual
 * data.json -- every pathofexile.com/poewiki/fandom domain was unreachable
 * from this project's own dev sandbox (network egress policy) while writing
 * this file, and the file itself is ~5MB, too large to fully inspect through
 * a web-content-summarizing tool. `findNode`'s field lookups try multiple
 * candidate key spellings and always fall through to "not found" rather than
 * throwing, and every resolution result keeps the raw node id regardless of
 * whether a name was found -- same "best-effort, verify against reality, fix
 * the candidate list in place" pattern as `client-log.ts`'s PATTERNS or
 * `pob.ts`'s candidate process names. If resolution comes back empty or wrong
 * against a real fetch, log what `data.json` actually looks like and adjust
 * the field candidates here.
 */

const TREE_DATA_URL =
  process.env.POE2_TREE_DATA_URL ??
  "https://raw.githubusercontent.com/grindinggear/poe2-skilltree-export/master/data.json";

// Patch-versioned data -- GGG updates this export per league/balance patch,
// not per request, so a day-long cache avoids re-downloading several MB on
// every get_passive_tree call.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cachePath(): string {
  return path.join(configDir(), "tree-data-cache.json");
}

interface RawTreeNode {
  [key: string]: unknown;
}

interface RawTreeData {
  nodes?: Record<string, RawTreeNode>;
  [key: string]: unknown;
}

interface CacheEnvelope {
  fetchedAt: string;
  sourceUrl: string;
  data: RawTreeData;
}

let memoryCache: CacheEnvelope | null = null;

function loadDiskCache(): CacheEnvelope | null {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), "utf8")) as CacheEnvelope;
  } catch {
    return null;
  }
}

function saveDiskCache(envelope: CacheEnvelope): void {
  try {
    fs.writeFileSync(cachePath(), JSON.stringify(envelope), "utf8");
  } catch (err) {
    console.error("[poe2-mcp-server] Failed to cache passive tree data:", err);
  }
}

function isFresh(envelope: CacheEnvelope): boolean {
  return Date.now() - new Date(envelope.fetchedAt).getTime() < CACHE_TTL_MS && envelope.sourceUrl === TREE_DATA_URL;
}

async function fetchRawTreeData(): Promise<CacheEnvelope> {
  const resp = await fetch(TREE_DATA_URL, { headers: { "User-Agent": "poe2-mcp-server/0.1.0" } });
  if (!resp.ok) {
    throw new Error(
      `Failed to fetch passive tree data from ${TREE_DATA_URL}: HTTP ${resp.status} ${resp.statusText}`
    );
  }
  const data = (await resp.json()) as RawTreeData;
  return { fetchedAt: new Date().toISOString(), sourceUrl: TREE_DATA_URL, data };
}

/**
 * Returns cached (memory, then disk) or freshly fetched tree data, or null if
 * none of those are available (offline, GitHub unreachable, first run with no
 * cache) -- callers treat that as "can't resolve names right now," not a hard
 * failure, and fall back to a stale cache rather than nothing if a fetch
 * fails but an old cache exists.
 */
async function getTreeData(): Promise<CacheEnvelope | null> {
  if (memoryCache && isFresh(memoryCache)) return memoryCache;

  const disk = loadDiskCache();
  if (disk && isFresh(disk)) {
    memoryCache = disk;
    return disk;
  }

  try {
    const fetched = await fetchRawTreeData();
    memoryCache = fetched;
    saveDiskCache(fetched);
    return fetched;
  } catch (err) {
    console.error("[poe2-mcp-server] Failed to fetch passive tree data:", err);
    return disk ?? memoryCache;
  }
}

function firstString(node: RawTreeNode, keys: string[]): string | null {
  for (const key of keys) {
    const v = node[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function firstBoolean(node: RawTreeNode, keys: string[]): boolean {
  return keys.some((key) => node[key] === true);
}

function statLines(node: RawTreeNode): string[] {
  for (const key of ["stats", "sd", "statDescriptions"]) {
    const v = node[key];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  }
  return [];
}

function findNode(data: RawTreeData, id: number): RawTreeNode | null {
  return (data.nodes?.[String(id)] as RawTreeNode | undefined) ?? null;
}

function emptyResolution(id: number): ResolvedPassiveNode {
  return { id, name: null, isKeystone: false, isNotable: false, isMastery: false, ascendancyName: null, stats: [] };
}

export interface TreeDataResolution {
  resolvedNodes: ResolvedPassiveNode[];
  note: string;
}

/**
 * Resolves a list of allocated node ids to names/stats, one result per input
 * id, in the same order. Never throws: if the dataset can't be loaded at all,
 * every entry comes back with `name: null` and `note` explains why -- the raw
 * ids in `allocatedHashes` remain the source of truth regardless.
 */
export async function resolveNodeNames(nodeIds: number[]): Promise<TreeDataResolution> {
  const envelope = await getTreeData();
  if (!envelope) {
    return {
      resolvedNodes: nodeIds.map(emptyResolution),
      note:
        `Could not resolve node names: failed to fetch the passive tree dataset from ${TREE_DATA_URL} and no ` +
        "usable cached copy was found (offline, or the source is unreachable). Node ids are still available in " +
        "allocatedHashes.",
    };
  }

  const resolvedNodes = nodeIds.map((id): ResolvedPassiveNode => {
    const node = findNode(envelope.data, id);
    if (!node) return emptyResolution(id);
    return {
      id,
      name: firstString(node, ["name", "dn"]),
      isKeystone: firstBoolean(node, ["isKeystone", "ks"]),
      isNotable: firstBoolean(node, ["isNotable", "not"]),
      isMastery: firstBoolean(node, ["isMastery", "m"]),
      ascendancyName: firstString(node, ["ascendancyName"]),
      stats: statLines(node),
    };
  });

  const unresolvedCount = resolvedNodes.filter((n) => n.name === null).length;
  return {
    resolvedNodes,
    note:
      `Resolved via GGG's official PoE2 tree export (cached from ${TREE_DATA_URL}, fetched ${envelope.fetchedAt}); ` +
      "the field names this adapter reads were not verified against a live fetch in development -- see the file-" +
      "level comment in tree-data.ts if resolution looks wrong. " +
      (unresolvedCount > 0
        ? `${unresolvedCount} of ${nodeIds.length} node id(s) had no match in the dataset -- possibly a stale ` +
          "cache after a patch, or a node this adapter's field-name guesses don't cover yet."
        : "All allocated node ids matched."),
  };
}
