import { userAgent } from "../config.js";
import { parseMods, sumStat } from "../build/mod-parser.js";
import { normalizeEquipmentSlot } from "../build/slots.js";
import type {
  InventoryItem, InventorySnapshot, ItemProperty, ParsedItemText,
  TradeCandidate, TradePriority, TradeSearchOptions, TradeSearchResult,
  TradeStatFilter, TradeUpgradeResult,
} from "../types.js";

const TRADE_BASE = "https://www.pathofexile.com";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const METADATA_TTL_MS = 60 * 60 * 1000;

export interface FindTradeUpgradesOptions {
  inventory: InventorySnapshot;
  league: string;
  slot: "Helm" | "BodyArmour" | "Gloves" | "Boots" | "Belt" | "Amulet" | "Ring" | "Ring2" | "Offhand";
  priorities: TradePriority[];
  minimumGain?: number;
  maxPrice: number;
  currency: string;
  maxRequiredLevel?: number;
  resultLimit?: number;
}

interface TradeStatEntry { id: string; text: string; type?: string }
interface TradeStatsResponse { result?: Array<{ label?: string; entries?: TradeStatEntry[] }> }
interface SearchResponse { id?: string; result?: string[]; total?: number }
interface TradeApiItem {
  name?: string;
  typeLine?: string;
  baseType?: string;
  rarity?: string;
  ilvl?: number;
  identified?: boolean;
  corrupted?: boolean;
  properties?: ItemProperty[];
  implicitMods?: string[];
  explicitMods?: string[];
  craftedMods?: string[];
  fracturedMods?: string[];
  // PoE2 gear sockets are exclusively for Runes/Soul Cores/Talismans (no gem
  // sockets, unlike PoE1); the trade API represents them as nested items
  // under socketedItems, each carrying its own mods -- there is no flat
  // "runeMods" array on the parent item.
  socketedItems?: TradeApiItem[];
}
interface FetchResult {
  id?: string;
  item?: TradeApiItem;
  listing?: { price?: { amount?: number; currency?: string } };
}
interface FetchResponse { result?: FetchResult[] }

const SLOT_CATEGORY: Record<string, string> = {
  Helm: "armour.helmet",
  BodyArmour: "armour.chest",
  Gloves: "armour.gloves",
  Boots: "armour.boots",
  Belt: "accessory.belt",
  Amulet: "accessory.amulet",
  Ring: "accessory.ring",
  Ring2: "accessory.ring",
  Offhand: "armour.shield",
  Weapon: "weapon",
};

export const COMMON_STAT_MAP: Record<string, string> = {
  life: "pseudo.pseudo_total_life",
  maximum_life: "pseudo.pseudo_total_life",
  max_life: "pseudo.pseudo_total_life",
  flat_life: "pseudo.pseudo_total_life",
  fire_resistance: "pseudo.pseudo_total_fire_resistance",
  fire_res: "pseudo.pseudo_total_fire_resistance",
  cold_resistance: "pseudo.pseudo_total_cold_resistance",
  cold_res: "pseudo.pseudo_total_cold_resistance",
  lightning_resistance: "pseudo.pseudo_total_lightning_resistance",
  lightning_res: "pseudo.pseudo_total_lightning_resistance",
  chaos_resistance: "pseudo.pseudo_total_chaos_resistance",
  chaos_res: "pseudo.pseudo_total_chaos_resistance",
  all_elemental_resistance: "pseudo.pseudo_total_all_elemental_resistances",
  all_elemental_resistances: "pseudo.pseudo_total_all_elemental_resistances",
  all_res: "pseudo.pseudo_total_all_elemental_resistances",
  total_elemental_resistance: "pseudo.pseudo_total_elemental_resistance",
  elemental_resistance: "pseudo.pseudo_total_elemental_resistance",
  movement_speed: "pseudo.pseudo_increased_movement_speed",
  movespeed: "pseudo.pseudo_increased_movement_speed",
  ms: "pseudo.pseudo_increased_movement_speed",
  energy_shield: "pseudo.pseudo_total_energy_shield",
  max_energy_shield: "pseudo.pseudo_total_energy_shield",
  es: "pseudo.pseudo_total_energy_shield",
  strength: "pseudo.pseudo_total_strength",
  str: "pseudo.pseudo_total_strength",
  dexterity: "pseudo.pseudo_total_dexterity",
  dex: "pseudo.pseudo_total_dexterity",
  intelligence: "pseudo.pseudo_total_intelligence",
  int: "pseudo.pseudo_total_intelligence",
  all_attributes: "pseudo.pseudo_total_all_attributes",
  attributes: "pseudo.pseudo_total_attributes",
};

const OFFHAND_CATEGORY_KEYWORDS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\bFocus\b/i, category: "armour.focus" },
  { pattern: /\bBuckler\b/i, category: "armour.buckler" },
  { pattern: /\bQuiver\b/i, category: "armour.quiver" },
  { pattern: /\b(Shield|Targe)\b/i, category: "armour.shield" },
];

/**
 * Off hand is the one slot with no single trade category, so pick the
 * category from the currently equipped item's base type text rather than
 * defaulting silently -- a caster's Focus upgrade search must not become a
 * Shield search. Returns null (not the default category) when nothing is
 * equipped or its base type doesn't match a known off-hand item class, so
 * the caller can surface that ambiguity instead of hiding it.
 */
function resolveOffhandCategory(equipped: InventoryItem | null): string | null {
  const baseType = equipped?.baseType ?? "";
  return OFFHAND_CATEGORY_KEYWORDS.find((k) => k.pattern.test(baseType))?.category ?? null;
}

const PRIORITIES: Record<TradePriority, { stat: string; label: string; fallbackId: string }> = {
  maximum_life: { stat: "maximum_life", label: "total maximum Life", fallbackId: "pseudo.pseudo_total_life" },
  fire_resistance: { stat: "fire_resistance_percent", label: "total to Fire Resistance", fallbackId: "pseudo.pseudo_total_fire_resistance" },
  cold_resistance: { stat: "cold_resistance_percent", label: "total to Cold Resistance", fallbackId: "pseudo.pseudo_total_cold_resistance" },
  lightning_resistance: { stat: "lightning_resistance_percent", label: "total to Lightning Resistance", fallbackId: "pseudo.pseudo_total_lightning_resistance" },
  chaos_resistance: { stat: "chaos_resistance_percent", label: "total to Chaos Resistance", fallbackId: "pseudo.pseudo_total_chaos_resistance" },
};

let metadataCache: { fetchedAt: number; entries: TradeStatEntry[] } | null = null;

function headers(json = false): Record<string, string> {
  const result: Record<string, string> = { Accept: "application/json", "User-Agent": userAgent() };
  if (json) result["Content-Type"] = "application/json";
  const session = process.env.POE2_TRADE_POESESSID?.trim();
  if (session) result.Cookie = `POESESSID=${session}`;
  return result;
}

async function readJsonLimited<T>(response: Response): Promise<T> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("Trade response exceeded the safety limit.");
  const reader = response.body?.getReader();
  if (!reader) return await response.json() as T;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Trade response exceeded the safety limit.");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(merged)) as T;
}

async function tradeFetch<T>(url: string, init?: RequestInit): Promise<{ data: T; response: Response }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const rateHint = response.status === 429
        ? ` Retry-After: ${response.headers.get("retry-after") ?? "unknown"} seconds.`
        : "";
      const authHint = response.status === 401 || response.status === 403
        ? " The trade site may require a logged-in POESESSID; set POE2_TRADE_POESESSID without sharing it with the model."
        : "";
      throw new Error(`PoE trade returned HTTP ${response.status} ${response.statusText}.${rateHint}${authHint}`);
    }
    return { data: await readJsonLimited<T>(response), response };
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("PoE trade request timed out after 10 seconds.");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizedStatText(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/#/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

async function statEntries(): Promise<TradeStatEntry[]> {
  if (metadataCache && Date.now() - metadataCache.fetchedAt < METADATA_TTL_MS) return metadataCache.entries;
  const { data } = await tradeFetch<TradeStatsResponse>(`${TRADE_BASE}/api/trade2/data/stats`, {
    headers: headers(),
  });
  const entries = (data.result ?? []).flatMap((group) => group.entries ?? []);
  metadataCache = { fetchedAt: Date.now(), entries };
  return entries;
}

async function resolveStatIds(priorities: TradePriority[]): Promise<{ ids: Record<TradePriority, string>; fromMetadata: boolean }> {
  let entries: TradeStatEntry[] = [];
  let fromMetadata = true;
  try { entries = await statEntries(); } catch { fromMetadata = false; }
  const ids = Object.fromEntries(priorities.map((priority) => {
    const spec = PRIORITIES[priority];
    const target = spec.label.toLowerCase();
    const match = entries.find((entry) => normalizedStatText(entry.text).includes(target));
    if (!match) fromMetadata = false;
    return [priority, match?.id ?? spec.fallbackId];
  })) as Record<TradePriority, string>;
  return { ids, fromMetadata };
}

function currentItem(inventory: InventorySnapshot, slot: string): InventoryItem | null {
  const normalized = normalizeEquipmentSlot(slot);
  return inventory.equipment.find((item) => normalizeEquipmentSlot(item.slot) === normalized) ?? null;
}

function priorityValues(item: InventoryItem | null, priorities: TradePriority[]): Partial<Record<TradePriority, number>> {
  const parsed = parseMods(item?.mods ?? []);
  return Object.fromEntries(priorities.map((priority) => [priority, sumStat(parsed, PRIORITIES[priority].stat)]));
}

function toParsedItem(item: TradeApiItem): ParsedItemText {
  const socketedMods = (item.socketedItems ?? []).flatMap((socketed) => [
    ...(socketed.implicitMods ?? []), ...(socketed.explicitMods ?? []),
  ]);
  const mods = [
    ...(item.implicitMods ?? []), ...(item.explicitMods ?? []), ...(item.craftedMods ?? []),
    ...(item.fracturedMods ?? []), ...socketedMods,
  ];
  return {
    name: item.name || item.typeLine || item.baseType || "Trade item",
    baseType: item.baseType || item.typeLine || "Unknown base",
    rarity: item.rarity ?? null,
    itemLevel: item.ilvl ?? null,
    identified: item.identified ?? true,
    corrupted: item.corrupted ?? false,
    properties: item.properties ?? [],
    mods,
  };
}

export async function findTradeUpgrades(options: FindTradeUpgradesOptions): Promise<TradeUpgradeResult> {
  const priorities = [...new Set(options.priorities)];
  if (priorities.length === 0) throw new Error("At least one upgrade priority is required.");
  const minimumGain = options.minimumGain ?? 1;
  const resultLimit = Math.min(Math.max(options.resultLimit ?? 10, 1), 10);
  const equipped = currentItem(options.inventory, options.slot);
  const before = priorityValues(equipped, priorities);
  const { ids: statIds, fromMetadata } = await resolveStatIds(priorities);
  // "The equipped item's contribution plus at least minimumGain" -- no
  // artificial floor of 1. A floor here would silently exclude a real
  // upgrade for a stat with a negative baseline (e.g. a -20% resistance
  // item improving to -10%, which parseMods can represent) by demanding
  // the candidate reach a positive value instead of merely a better one.
  const appliedMinimums: Partial<Record<TradePriority, number>> = Object.fromEntries(
    priorities.map((priority) => [priority, (before[priority] ?? 0) + minimumGain])
  );

  const inferredOffhandCategory = options.slot === "Offhand" ? resolveOffhandCategory(equipped) : null;
  const category = options.slot === "Offhand" ? inferredOffhandCategory ?? SLOT_CATEGORY.Offhand : SLOT_CATEGORY[options.slot];
  const offhandCategoryUncertain = options.slot === "Offhand" && inferredOffhandCategory === null;

  const query = {
    query: {
      status: { option: "online" },
      stats: [{
        type: "and",
        // Non-null: appliedMinimums was built from this same `priorities` array above.
        filters: priorities.map((priority) => ({ id: statIds[priority], value: { min: appliedMinimums[priority]! } })),
      }],
      filters: {
        type_filters: { filters: { category: { option: category } } },
        ...(options.maxRequiredLevel !== undefined
          ? { req_filters: { filters: { lvl: { max: options.maxRequiredLevel } } } }
          : {}),
        trade_filters: { filters: { price: { max: options.maxPrice, option: options.currency } } },
      },
    },
    sort: { price: "asc" },
  };

  const league = encodeURIComponent(options.league);
  const directUrl = `${TRADE_BASE}/trade2/search/poe2/${league}?q=${encodeURIComponent(JSON.stringify(query))}`;
  const { data: search, response } = await tradeFetch<SearchResponse>(
    `${TRADE_BASE}/api/trade2/search/poe2/${league}`,
    { method: "POST", headers: headers(true), body: JSON.stringify(query) }
  );
  if (!search.id) throw new Error("PoE trade did not return a search id.");
  const searchUrl = `${TRADE_BASE}/trade2/search/poe2/${league}/${encodeURIComponent(search.id)}`;
  const ids = (search.result ?? []).slice(0, resultLimit);
  let fetched: FetchResult[] = [];
  let warning: string | null = fromMetadata
    ? null
    : "Trade stat metadata was unavailable or incomplete; stable pseudo-stat fallback ids were used.";
  if (offhandCategoryUncertain) {
    warning = `${warning ? `${warning} ` : ""}Could not determine the off-hand item type (Shield/Buckler/Focus/Quiver) ` +
      `from the equipped item; defaulted to Shield. Results may not match the intended off-hand category.`;
  }
  if (ids.length > 0) {
    try {
      const details = await tradeFetch<FetchResponse>(
        `${TRADE_BASE}/api/trade2/fetch/${ids.map(encodeURIComponent).join(",")}?query=${encodeURIComponent(search.id)}`,
        { headers: headers() }
      );
      fetched = details.data.result ?? [];
    } catch (err) {
      warning = `${warning ? `${warning} ` : ""}The search succeeded, but listing details could not be ranked: ${(err as Error).message}`;
    }
  }

  const candidates: TradeCandidate[] = fetched.flatMap((entry): TradeCandidate[] => {
    if (!entry.item) return [];
    const parsed = toParsedItem(entry.item);
    const candidateParsed = parseMods(parsed.mods);
    const deltas: Partial<Record<TradePriority, number>> = Object.fromEntries(priorities.map((priority) => {
      const after = sumStat(candidateParsed, PRIORITIES[priority].stat);
      return [priority, after - (before[priority] ?? 0)];
    }));
    return [{
      id: entry.id ?? null,
      name: parsed.name,
      baseType: parsed.baseType,
      itemLevel: parsed.itemLevel,
      price: entry.listing?.price
        ? { amount: entry.listing.price.amount ?? null, currency: entry.listing.price.currency ?? null }
        : null,
      priorityDeltas: deltas,
      // Non-null: deltas was built from this same `priorities` array above.
      improvesAllPriorities: priorities.every((priority) => deltas[priority]! >= minimumGain),
      mods: parsed.mods,
      score: priorities.reduce((sum, priority) => sum + Math.max(0, deltas[priority]!), 0),
    }];
  }).sort((a, b) => Number(b.improvesAllPriorities) - Number(a.improvesAllPriorities) || b.score - a.score);

  const rateLimit = Object.fromEntries(
    [...response.headers.entries()].filter(([name]) => name.toLowerCase().startsWith("x-rate-limit"))
  );
  return {
    source: "poe_trade_site",
    fetchedAt: new Date().toISOString(),
    apiStatus: "undocumented_official_site_endpoint",
    league: options.league,
    searchUrl,
    directUrl,
    totalMatches: search.total ?? search.result?.length ?? 0,
    currentItem: equipped ? { name: equipped.name, slot: equipped.slot, priorityValues: before } : null,
    appliedFilters: {
      slot: options.slot,
      category,
      priorities,
      minimumCandidateValues: appliedMinimums,
      maxPrice: { amount: options.maxPrice, currency: options.currency },
      maxRequiredLevel: options.maxRequiredLevel ?? null,
      onlineOnly: true,
    },
    candidates,
    warning,
    rateLimit,
    note:
      "Search results are live listings, not reservations. The endpoint is hosted by GGG but is not in the published developer API; " +
      "open searchUrl to inspect/contact sellers. The tool ranks up to the first 10 price-sorted results; " +
      "candidate scores are gear-only deltas for the requested stats, not a global build optimizer.",
  };
}

/**
 * Creates an official Path of Exile 2 trade search link from arbitrary requirements
 * (slot, category, base type, rarity, stat filters, budget, level requirement).
 *
 * Does NOT require GGG developer API client ID or character authentication.
 * Returns both a short official search URL and a direct query-encoded URL.
 */
export async function createTradeSearch(options: TradeSearchOptions): Promise<TradeSearchResult> {
  const league = options.league?.trim() || "Standard";
  const resultLimit = Math.min(Math.max(options.resultLimit ?? 10, 0), 10);

  let category: string | undefined = options.category;
  if (!category && options.slot) {
    category = SLOT_CATEGORY[options.slot];
  }

  const statFilters: Array<{ id: string; label?: string; min?: number; max?: number }> = [];
  if (options.stats && options.stats.length > 0) {
    for (const sf of options.stats) {
      let resolvedId = sf.id;
      if (!resolvedId && sf.stat) {
        const key = sf.stat.trim().toLowerCase().replace(/[\s-]+/g, "_");
        resolvedId = COMMON_STAT_MAP[key];
        if (!resolvedId) {
          const priorityMatch = PRIORITIES[key as TradePriority];
          if (priorityMatch) resolvedId = priorityMatch.fallbackId;
        }
      }
      if (resolvedId) {
        statFilters.push({
          id: resolvedId,
          label: sf.stat,
          min: sf.min,
          max: sf.max,
        });
      }
    }
  }

  const queryObj: Record<string, unknown> = {
    query: {
      status: { option: options.onlineOnly !== false ? "online" : "any" },
    },
    sort: { price: "asc" },
  };

  const queryInner = queryObj.query as Record<string, unknown>;
  if (options.name) queryInner.name = options.name;
  if (options.baseType) queryInner.type = options.baseType;

  const filters: Record<string, unknown> = {};
  if (category || options.rarity) {
    const typeFilters: Record<string, unknown> = {};
    if (category) typeFilters.category = { option: category };
    if (options.rarity) typeFilters.rarity = { option: options.rarity };
    filters.type_filters = { filters: typeFilters };
  }

  if (options.maxRequiredLevel !== undefined) {
    filters.req_filters = { filters: { lvl: { max: options.maxRequiredLevel } } };
  }

  if (options.maxPrice !== undefined) {
    filters.trade_filters = {
      filters: { price: { max: options.maxPrice, option: options.currency ?? "chaos" } },
    };
  }

  if (Object.keys(filters).length > 0) {
    queryInner.filters = filters;
  }

  if (statFilters.length > 0) {
    queryInner.stats = [
      {
        type: "and",
        filters: statFilters.map((sf) => ({
          id: sf.id,
          value: {
            ...(sf.min !== undefined ? { min: sf.min } : {}),
            ...(sf.max !== undefined ? { max: sf.max } : {}),
          },
        })),
      },
    ];
  }

  const encodedLeague = encodeURIComponent(league);
  const directUrl = `${TRADE_BASE}/trade2/search/poe2/${encodedLeague}?q=${encodeURIComponent(JSON.stringify(queryObj))}`;

  let searchUrl = directUrl;
  let totalMatches = 0;
  let candidates: TradeCandidate[] = [];
  let warning: string | null = null;
  let rateLimit: Record<string, string> | undefined;

  try {
    const { data: search, response } = await tradeFetch<SearchResponse>(
      `${TRADE_BASE}/api/trade2/search/poe2/${encodedLeague}`,
      { method: "POST", headers: headers(true), body: JSON.stringify(queryObj) }
    );

    rateLimit = Object.fromEntries(
      [...response.headers.entries()].filter(([name]) => name.toLowerCase().startsWith("x-rate-limit"))
    );

    if (search.id) {
      searchUrl = `${TRADE_BASE}/trade2/search/poe2/${encodedLeague}/${encodeURIComponent(search.id)}`;
      totalMatches = search.total ?? search.result?.length ?? 0;

      const ids = (search.result ?? []).slice(0, resultLimit);
      if (ids.length > 0 && resultLimit > 0) {
        try {
          const details = await tradeFetch<FetchResponse>(
            `${TRADE_BASE}/api/trade2/fetch/${ids.map(encodeURIComponent).join(",")}?query=${encodeURIComponent(search.id)}`,
            { headers: headers() }
          );
          const fetched = details.data.result ?? [];
          candidates = fetched.flatMap((entry): TradeCandidate[] => {
            if (!entry.item) return [];
            const parsed = toParsedItem(entry.item);
            return [
              {
                id: entry.id ?? null,
                name: parsed.name,
                baseType: parsed.baseType,
                itemLevel: parsed.itemLevel,
                price: entry.listing?.price
                  ? { amount: entry.listing.price.amount ?? null, currency: entry.listing.price.currency ?? null }
                  : null,
                priorityDeltas: {},
                improvesAllPriorities: true,
                mods: parsed.mods,
                score: 1,
              },
            ];
          });
        } catch (fetchErr) {
          warning = `Search succeeded, but candidate preview details could not be retrieved: ${(fetchErr as Error).message}`;
        }
      }
    }
  } catch (err) {
    warning = `Live API search query could not be executed (${(err as Error).message}). A direct browser search link with all filters pre-loaded was generated instead.`;
  }

  return {
    source: "poe_trade_site",
    createdAt: new Date().toISOString(),
    league,
    searchUrl,
    directUrl,
    totalMatches,
    query: queryObj,
    appliedFilters: {
      slot: options.slot,
      category,
      name: options.name,
      baseType: options.baseType,
      rarity: options.rarity,
      stats: statFilters,
      maxPrice: options.maxPrice !== undefined ? { amount: options.maxPrice, currency: options.currency ?? "chaos" } : undefined,
      maxRequiredLevel: options.maxRequiredLevel,
      onlineOnly: options.onlineOnly !== false,
    },
    candidates,
    warning,
    rateLimit,
    note:
      "Click searchUrl or directUrl to open the search directly on the official Path of Exile 2 trade site with all requested filters. " +
      "No GGG API client ID or OAuth credentials are required.",
  };
}

export function resetTradeMetadataCacheForTests(): void {
  metadataCache = null;
}
