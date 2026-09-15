import { GGG_API_BASE, GGG_REALM, userAgent } from "../config.js";
import { getAccessToken } from "./ggg-oauth.js";
import { resolveNodeNames } from "./tree-data.js";
import type { CharacterState, InventoryItem, InventorySnapshot, ItemProperty, PassiveTreeSnapshot } from "../types.js";
import { normalizeEquipmentSlot } from "../build/slots.js";

/**
 * Thin client for the parts of GGG's official API this server uses:
 * GET /character/poe2            (list characters on the account)
 * GET /character/poe2/<name>     (single character, with equipment/skills)
 *
 * Docs: https://www.pathofexile.com/developer/docs/reference
 * Note this API is account-sheet data (level, equipment, passives), refreshed
 * on request -- it does NOT expose live combat stats like current HP/mana or
 * nearby monsters. For near-real-time events, see adapters/client-log.ts.
 */

interface RawItemPropertyValue extends Array<string | number> {}

interface RawItemProperty {
  name: string;
  values: RawItemPropertyValue[];
}

interface RawItem {
  name?: string;
  typeLine?: string;
  baseType?: string;
  rarity?: string;
  ilvl?: number;
  identified?: boolean;
  corrupted?: boolean;
  inventoryId?: string;
  explicitMods?: string[];
  implicitMods?: string[];
  craftedMods?: string[];
  fracturedMods?: string[];
  properties?: RawItemProperty[];
  additionalProperties?: RawItemProperty[];
  // PoE2 gear sockets hold Runes/Soul Cores/Talismans, not gems; each
  // socketed item carries its own mods rather than the parent exposing a
  // flat "runeMods" array, so their stats must be folded in explicitly or
  // they silently vanish from every defense/offense/trade calculation.
  socketedItems?: RawItem[];
}

interface RawPassives {
  hashes?: number[];
  hashes_ex?: number[];
  jewel_data?: Record<string, unknown>;
  mastery_effects?: Record<string, unknown>;
}

interface RawCharacter {
  id: string;
  name: string;
  class: string;
  ascendancyClass?: string;
  league: string | null;
  level: number;
  experience: number;
  equipment?: RawItem[];
  skills?: RawItem[];
  passives?: RawPassives;
}

/**
 * GET /character/poe2/<name> returns the entire character (equipment,
 * skills, passives) in one response, and this file has grown enough callers
 * of it (character state, inventory, passives, defenses, offense) that
 * fetching it independently per tool call would multiply load against
 * GGG's rate limit (see the 429 handling in gggFetch below) for data that
 * doesn't change within a single AI reasoning turn. Cache it briefly instead.
 */
const RAW_CHARACTER_TTL_MS = 10_000;
const rawCharacterCache = new Map<string, { fetchedAt: number; data: RawCharacter }>();

let cachedClientId: string | undefined;

function clientId(): string {
  if (!cachedClientId) {
    cachedClientId = process.env.POE2_GGG_CLIENT_ID;
    if (!cachedClientId) {
      throw new Error("POE2_GGG_CLIENT_ID is not set.");
    }
  }
  return cachedClientId;
}

async function gggFetch(path: string): Promise<unknown> {
  const token = await getAccessToken(clientId());
  const res = await fetch(`${GGG_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": userAgent(),
    },
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    throw new Error(`Rate limited by GGG API. Retry-After: ${retryAfter ?? "unknown"}s`);
  }
  if (!res.ok) {
    throw new Error(`GGG API error ${res.status} for ${path}: ${await res.text()}`);
  }
  return res.json();
}

function toItemProperties(item: RawItem): ItemProperty[] {
  return [...(item.properties ?? []), ...(item.additionalProperties ?? [])].map((p) => ({
    name: p.name,
    values: p.values,
  }));
}

function socketedItemMods(item: RawItem): string[] {
  return (item.socketedItems ?? []).flatMap((socketed) => [
    ...(socketed.implicitMods ?? []),
    ...(socketed.explicitMods ?? []),
  ]);
}

function toInventoryItem(item: RawItem): InventoryItem {
  return {
    slot: normalizeEquipmentSlot(item.inventoryId),
    name: item.name && item.name.length > 0 ? item.name : item.typeLine ?? "Unknown",
    baseType: item.baseType ?? item.typeLine ?? "Unknown",
    rarity: item.rarity ?? null,
    itemLevel: item.ilvl ?? null,
    identified: item.identified ?? null,
    mods: [
      ...(item.implicitMods ?? []),
      ...(item.explicitMods ?? []),
      ...(item.craftedMods ?? []),
      ...(item.fracturedMods ?? []),
    ],
    // Kept out of `mods` -- unlike this item's own affixes, a socketed
    // Rune/Soul Core's stats are never already baked into the displayed
    // Armour/Evasion/ES property above, so defense aggregation must always
    // treat them as a global bonus (see computeDefenses).
    socketedMods: socketedItemMods(item),
    properties: toItemProperties(item),
    corrupted: item.corrupted ?? null,
  };
}

export async function listCharacterNames(): Promise<string[]> {
  const body = (await gggFetch(`/character/${GGG_REALM}`)) as { characters: RawCharacter[] };
  return body.characters.map((c) => c.name);
}

async function fetchRawCharacter(name: string): Promise<RawCharacter> {
  const cached = rawCharacterCache.get(name);
  if (cached && Date.now() - cached.fetchedAt < RAW_CHARACTER_TTL_MS) {
    return cached.data;
  }
  const body = (await gggFetch(`/character/${GGG_REALM}/${encodeURIComponent(name)}`)) as {
    character: RawCharacter;
  };
  rawCharacterCache.set(name, { fetchedAt: Date.now(), data: body.character });
  return body.character;
}

export async function fetchCharacterState(name: string): Promise<CharacterState> {
  const c = await fetchRawCharacter(name);
  return {
    source: "ggg_api",
    fetchedAt: new Date().toISOString(),
    name: c.name,
    characterClass: c.class,
    league: c.league,
    level: c.level,
    experience: c.experience,
    hardcore: (c.league ?? "").toLowerCase().includes("hardcore"),
  };
}

export async function fetchInventorySnapshot(name: string): Promise<InventorySnapshot> {
  const c = await fetchRawCharacter(name);
  return {
    source: "ggg_api",
    fetchedAt: new Date().toISOString(),
    characterName: c.name,
    equipment: (c.equipment ?? []).map(toInventoryItem),
    skills: (c.skills ?? []).map(toInventoryItem),
  };
}

export async function fetchPassiveTree(name: string): Promise<PassiveTreeSnapshot> {
  const c = await fetchRawCharacter(name);
  const allocatedHashes = c.passives?.hashes ?? [];
  const { resolvedNodes, note } = await resolveNodeNames(allocatedHashes);
  return {
    source: "ggg_api",
    fetchedAt: new Date().toISOString(),
    characterName: c.name,
    ascendancyClass: c.ascendancyClass ?? null,
    allocatedHashes,
    resolvedNodes,
    jewelData: c.passives?.jewel_data ?? {},
    note,
  };
}
