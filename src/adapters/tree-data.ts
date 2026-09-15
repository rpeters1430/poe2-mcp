import fs from "node:fs";
import path from "node:path";
import { configDir } from "../config.js";
import type { ResolvedPassiveNode } from "../types.js";

/**
 * Resolves GGG's raw allocated passive-tree node hashes (see
 * `fetchPassiveTree` in `ggg-api.ts` / `PobPassiveSpec.allocatedNodeIds` from
 * a PoB2 import) to human-readable names/stats, using GGG's own official PoE2
 * tree export: https://github.com/grindinggear/poe2-skilltree-export
 * (data.json).
 *
 * Schema verified against a live fetch of the real data.json (~5MB, 5153
 * nodes as of writing). Root keys: tree, classes, groups, nodes, edges,
 * skillOverrides, jewelSlots, min_x/min_y/max_x/max_y. "nodes" is keyed by
 * node id as a string (e.g. "52"), which matches the node's own numeric
 * "skill" field -- this is the same id space as GGG character-API
 * `passives.hashes` and PoB2's `<Spec nodes="...">` list, so no extra id
 * translation is needed. A representative node:
 *   { "id": "passive_keystone_zealots_oath", "skill": 52,
 *     "name": "Zealot's Oath", "icon": "...", "isKeystone": true,
 *     "stats": ["Excess Life Recovery ..."], "group": 194, "orbit": 0,
 *     "orbitIndex": 0, "x": ..., "y": ..., "out": [...], "in": [...] }
 * The inner "id" is a machine slug (e.g. "passive_keystone_zealots_oath"),
 * NOT the display name -- use "name" for that. Ascendancy nodes carry
 * "ascendancyId" (e.g. "Ranger3": base class + ascendancy slot number, NOT
 * the ascendancy's flavor name like "Deadeye" -- there's no slot-to-flavor-
 * name mapping in this dataset). Boolean flags (isKeystone/isNotable/
 * isMastery) are omitted entirely on nodes that aren't that type, rather than
 * present-and-false.
 *
 * `findNode`'s field lookups still try a couple of alternate key spellings
 * (this export's schema has changed under GGG before, e.g. PoE1's older
 * dn/ks/not/m abbreviations) and always fall through to "not found" rather
 * than throwing; every resolution result keeps the raw node id regardless of
 * whether a name was found -- same "best-effort, verify against reality, fix
 * in place" pattern as `client-log.ts`'s PATTERNS or `pob.ts`'s candidate
 * process names. If a future patch changes the schema and resolution starts
 * coming back empty, re-fetch data.json and adjust the field candidates here.
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
  return { id, name: null, isKeystone: false, isNotable: false, isMastery: false, ascendancyId: null, stats: [] };
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
      ascendancyId: firstString(node, ["ascendancyId", "ascendancyName"]),
      stats: statLines(node),
    };
  });

  const unresolvedCount = resolvedNodes.filter((n) => n.name === null).length;
  return {
    resolvedNodes,
    note:
      `Resolved via GGG's official PoE2 tree export (cached from ${TREE_DATA_URL}, fetched ${envelope.fetchedAt}). ` +
      (unresolvedCount > 0
        ? `${unresolvedCount} of ${nodeIds.length} node id(s) had no match in the dataset -- possibly a stale ` +
          "cache after a patch, or a node this adapter's field-name guesses don't cover yet."
        : "All allocated node ids matched."),
  };
}
