import { userAgent } from "../config.js";
import { compareItem } from "../build/compare.js";
import { parseMods, sumStat } from "../build/mod-parser.js";
import { normalizeEquipmentSlot } from "../build/slots.js";
import type { InventoryItem, InventorySnapshot, ItemProperty, ParsedItemText } from "../types.js";

const TRADE_BASE = "https://www.pathofexile.com";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const METADATA_TTL_MS = 60 * 60 * 1000;

export type TradePriority =
  | "maximum_life"
  | "fire_resistance"
  | "cold_resistance"
  | "lightning_resistance"
  | "chaos_resistance";

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
  runeMods?: string[];
}
interface FetchResult {
  id?: string;
  item?: TradeApiItem;
  listing?: { price?: { amount?: number; currency?: string } };
}
interface FetchResponse { result?: FetchResult[] }

const SLOT_CATEGORY: Record<FindTradeUpgradesOptions["slot"], string> = {
  Helm: "armour.helmet",
  BodyArmour: "armour.chest",
  Gloves: "armour.gloves",
  Boots: "armour.boots",
  Belt: "accessory.belt",
  Amulet: "accessory.amulet",
  Ring: "accessory.ring",
  Ring2: "accessory.ring",
  Offhand: "armour.shield",
};

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

function priorityValues(item: InventoryItem | null, priorities: TradePriority[]): Record<TradePriority, number> {
  const parsed = parseMods(item?.mods ?? []);
  return Object.fromEntries(priorities.map((priority) => [priority, sumStat(parsed, PRIORITIES[priority].stat)])) as Record<TradePriority, number>;
}

function toParsedItem(item: TradeApiItem): ParsedItemText {
  const mods = [
    ...(item.implicitMods ?? []), ...(item.explicitMods ?? []), ...(item.craftedMods ?? []),
    ...(item.fracturedMods ?? []), ...(item.runeMods ?? []),
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

export async function findTradeUpgrades(options: FindTradeUpgradesOptions): Promise<unknown> {
  const priorities = [...new Set(options.priorities)];
  if (priorities.length === 0) throw new Error("At least one upgrade priority is required.");
  const minimumGain = options.minimumGain ?? 1;
  const resultLimit = Math.min(Math.max(options.resultLimit ?? 10, 1), 10);
  const equipped = currentItem(options.inventory, options.slot);
  const before = priorityValues(equipped, priorities);
  const { ids: statIds, fromMetadata } = await resolveStatIds(priorities);
  const appliedMinimums = Object.fromEntries(
    priorities.map((priority) => [priority, Math.max(1, before[priority] + minimumGain)])
  ) as Record<TradePriority, number>;

  const query = {
    query: {
      status: { option: "online" },
      stats: [{
        type: "and",
        filters: priorities.map((priority) => ({ id: statIds[priority], value: { min: appliedMinimums[priority] } })),
      }],
      filters: {
        type_filters: { filters: { category: { option: SLOT_CATEGORY[options.slot] } } },
        ...(options.maxRequiredLevel !== undefined
          ? { req_filters: { filters: { lvl: { max: options.maxRequiredLevel } } } }
          : {}),
        trade_filters: { filters: { price: { max: options.maxPrice, option: options.currency } } },
      },
    },
    sort: { price: "asc" },
  };

  const league = encodeURIComponent(options.league);
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

  const candidates = fetched.flatMap((entry) => {
    if (!entry.item) return [];
    const parsed = toParsedItem(entry.item);
    const comparison = compareItem(options.inventory, parsed, options.slot);
    const deltas = Object.fromEntries(priorities.map((priority) => {
      const delta = comparison.statDeltas.find((value) => value.stat === PRIORITIES[priority].stat)?.delta ?? 0;
      return [priority, delta];
    })) as Record<TradePriority, number>;
    return [{
      id: entry.id ?? null,
      name: parsed.name,
      baseType: parsed.baseType,
      itemLevel: parsed.itemLevel,
      price: entry.listing?.price ?? null,
      priorityDeltas: deltas,
      improvesAllPriorities: priorities.every((priority) => deltas[priority] >= minimumGain),
      mods: parsed.mods,
      score: priorities.reduce((sum, priority) => sum + Math.max(0, deltas[priority]), 0),
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
    totalMatches: search.total ?? search.result?.length ?? 0,
    currentItem: equipped ? { name: equipped.name, slot: equipped.slot, priorityValues: before } : null,
    appliedFilters: {
      slot: options.slot,
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

export function resetTradeMetadataCacheForTests(): void {
  metadataCache = null;
}
