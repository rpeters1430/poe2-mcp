/**
 * Shared wire types for the PoE2 MCP server.
 *
 * These are the JSON shapes that cross the boundary between the server and
 * the AI model, in both directions. Server -> AI shapes are returned as MCP
 * tool results; AI -> server shapes are the arguments to the one "action"
 * tool the server exposes (emit_advisory). See PROTOCOL.md for the full
 * spec and rationale.
 */

// ---------------------------------------------------------------------------
// Server -> AI: game state
// ---------------------------------------------------------------------------

export interface CharacterState {
  /** Source of truth for this snapshot. */
  source: "ggg_api" | "pob_import" | "poe_ninja";
  /** ISO 8601 timestamp of when this snapshot was fetched (not live). */
  fetchedAt: string;
  name: string;
  characterClass: string;
  league: string | null;
  level: number;
  experience: number;
  /** True if this is a hardcore character (best-effort, from league name). */
  hardcore: boolean;
}

/**
 * A base numeric stat as GGG's API reports it (Armour, Evasion Rating,
 * Energy Shield, Physical Damage, Critical Strike Chance, Attacks per
 * Second, ...) -- distinct from the affix text in `mods`. `values` is kept
 * as the raw [value, augmented-flag] tuples GGG returns rather than
 * pre-parsed, since range values ("20-40") and flagged/augmented values need
 * different handling depending on what's reading them.
 */
export interface ItemProperty {
  name: string;
  values: Array<Array<string | number>>;
}

export interface InventoryItem {
  slot: string | null;
  name: string;
  baseType: string;
  rarity: string | null;
  itemLevel: number | null;
  identified: boolean | null;
  /** Raw explicit/implicit mod strings, unparsed. */
  mods: string[];
  /**
   * Raw mod strings granted by socketed Runes/Soul Cores/Talismans (PoE2's
   * only socket type), kept separate from `mods` because -- unlike the
   * item's own affixes -- these are never already reflected in a displayed
   * Armour/Evasion/Energy Shield property, so defense aggregation must
   * always treat them as a global bonus rather than risk double-counting
   * them as local. Omitted (not empty array) when the source has no
   * socket data to offer.
   */
  socketedMods?: string[];
  /** Base numeric properties (Armour, damage ranges, crit, APS, ...), unparsed beyond GGG's own shape. */
  properties: ItemProperty[];
  corrupted: boolean | null;
}

export interface InventorySnapshot {
  source: "ggg_api" | "pob_import" | "poe_ninja";
  fetchedAt: string;
  characterName: string;
  equipment: InventoryItem[];
  skills: InventoryItem[];
}

// ---------------------------------------------------------------------------
// Server -> AI: gear-derived build data (passives, defenses, offense, compare)
//
// GGG's character API is gear data, not a full character sheet: it has no
// base life/mana-per-level, no passive-tree stat values (only allocated node
// hashes -- resolving those to names/effects needs a local game-data layer
// this project doesn't have yet), and no skill/support gem scaling. Every
// type below is explicitly gear-only and says so in its `note` field so nothing
// downstream mistakes an aggregate for a final character total.
// ---------------------------------------------------------------------------

/**
 * One allocated passive node resolved against the local tree dataset (see
 * `src/adapters/tree-data.ts`). `name`/stat fields are null/empty when the id
 * wasn't found in the dataset -- a stale cache after a patch, or the node
 * simply not being resolvable yet -- never when a lookup wasn't attempted;
 * `resolvedNodes` in `PassiveTreeSnapshot` always has one entry per hash in
 * `allocatedHashes`, in the same order, so the raw id is never lost even when
 * the name is.
 */
export interface ResolvedPassiveNode {
  id: number;
  name: string | null;
  isKeystone: boolean;
  isNotable: boolean;
  isMastery: boolean;
  /**
   * Set when this node belongs to a specific ascendancy class -- a slug like
   * "Ranger3" (base class + ascendancy slot number, per GGG's official tree
   * export), NOT the ascendancy's flavor display name (e.g. "Deadeye"). This
   * project has no ascendancy-slot-to-display-name mapping yet.
   */
  ascendancyId: string | null;
  /** Raw stat description lines for this node, unparsed (same philosophy as InventoryItem.mods). */
  stats: string[];
}

export interface PassiveTreeSnapshot {
  source: "ggg_api" | "pob_import" | "poe_ninja";
  fetchedAt: string;
  characterName: string;
  ascendancyClass: string | null;
  /** Allocated passive tree node hashes, unresolved. Kept alongside `resolvedNodes` regardless of resolution success. */
  allocatedHashes: number[];
  /** `allocatedHashes` resolved to names/stats, in the same order -- see `note` for how/whether resolution succeeded. */
  resolvedNodes: ResolvedPassiveNode[];
  /** Raw jewel_data from GGG's API, keyed by socket, unparsed. */
  jewelData: Record<string, unknown>;
  note: string;
}

/** One parsed affix, e.g. "+45 to maximum Life" -> [{ stat: "maximum_life", value: 45 }]. */
export interface ParsedMod {
  raw: string;
  /** Empty when the affix text didn't match a known pattern -- `raw` is always kept regardless. */
  matches: Array<{ stat: string; value: number }>;
}

export interface ResistanceStat {
  raw: number;
  /** Capped at the standard display cap (75% elemental/chaos). */
  capped: number;
}

export interface DefenseStats {
  source: "gear_only";
  computedAt: string;
  characterName: string;
  life: number;
  mana: number;
  energyShield: number;
  armour: number;
  evasion: number;
  blockChancePercent: number | null;
  resistances: {
    fire: ResistanceStat;
    cold: ResistanceStat;
    lightning: ResistanceStat;
    chaos: ResistanceStat;
  };
  attributes: { strength: number; dexterity: number; intelligence: number };
  note: string;
}

export interface WeaponOffense {
  slot: string | null;
  name: string;
  physicalDamage: { min: number; max: number } | null;
  elementalDamage: Array<{ min: number; max: number }>;
  criticalStrikeChance: number | null;
  attacksPerSecond: number | null;
}

export interface OffenseStats {
  source: "gear_only";
  computedAt: string;
  characterName: string;
  weapons: WeaponOffense[];
  accuracyRating: number;
  increasedAttackSpeedPercent: number;
  increasedCastSpeedPercent: number;
  increasedCriticalStrikeChancePercent: number;
  criticalDamageBonusPercent: number;
  /** Other damage-related affixes found on gear that don't map to a single aggregate field above. */
  otherDamageMods: ParsedMod[];
  note: string;
}

export interface ParsedItemText {
  name: string;
  baseType: string;
  rarity: string | null;
  itemLevel: number | null;
  identified: boolean;
  corrupted: boolean;
  properties: ItemProperty[];
  mods: string[];
  /** PoE 2 item class, e.g. "Helmets", "Body Armours", "Foci", "Quivers", "Rings". */
  itemClass?: string | null;
}

export interface StatDelta {
  stat: string;
  before: number | null;
  after: number | null;
  delta: number | null;
}

export interface ItemComparison {
  source: "computed";
  comparedAt: string;
  characterName: string;
  slot: string | null;
  current: { name: string; mods: string[] } | null;
  candidate: { name: string; mods: string[] };
  statDeltas: StatDelta[];
  defensesBefore: DefenseStats | null;
  defensesAfter: DefenseStats | null;
  note: string;
  /** Present when comparing a ring without an explicit slot override. */
  ringComparisons?: {
    ring1: ItemComparison;
    ring2: ItemComparison;
    recommendedSlot: "Ring" | "Ring2";
    recommendationReason: string;
  };
}

export interface ActiveCharacterState {
  name: string | null;
  source: "explicit" | "inferred_from_log" | "none";
  setAt: string | null;
  message?: string;
}

// ---------------------------------------------------------------------------
// Server -> AI: Path of Building 2 import
//
// An alternative build-data source to the GGG API tools above, usable when
// GGG API access isn't available (e.g. OAuth application registration
// closed) or simply preferred: parses a build the player explicitly exports
// from PoB2 (a share code) or has saved to disk. Unlike get_defenses/
// get_offense_stats, `playerStats` here are PoB's OWN already-computed
// numbers (real DPS/EHP/crit/etc, with full skill+support+tree interactions)
// -- not a gear-only approximation -- but only as fresh as whenever the
// build was last calculated/exported in PoB2.
// ---------------------------------------------------------------------------

export interface PobPlayerStat {
  stat: string;
  value: number;
}

export interface PobGem {
  nameSpec: string;
  skillId: string | null;
  level: number | null;
  quality: number | null;
  enabled: boolean;
}

export interface PobSkillGroup {
  label: string | null;
  slot: string | null;
  enabled: boolean;
  mainActiveSkill: number | null;
  gems: PobGem[];
}

export interface PobPassiveSpec {
  classId: number | null;
  ascendClassId: number | null;
  allocatedNodeIds: number[];
  masteryEffects: string | null;
}

export interface PobBuildSnapshot {
  source: "pob_import" | "poe_ninja";
  importedAt: string;
  className: string | null;
  ascendClassName: string | null;
  level: number | null;
  /** Reuses the same shape the GGG-API-backed tools use, via the shared item-text parser. */
  equipment: InventoryItem[];
  skills: PobSkillGroup[];
  passiveTree: PobPassiveSpec;
  /** PoB's own computed stats as of whenever the build was last calculated -- see the type doc above. */
  playerStats: PobPlayerStat[];
  note: string;
}

export type ActiveBuildOrigin =
  | "explicit_code"
  | "explicit_file"
  | "poe_ninja"
  | "auto_pob_file"
  | "auto_poe_ninja"
  | "legacy";

export interface ActiveBuildIdentity {
  accountName: string | null;
  characterName: string | null;
  /** Display label (e.g. "Rise of the Abyssal"), for identity/reporting only. */
  league: string | null;
  /** poe.ninja's URL slug for the league (e.g. "roa"), used to refresh the build -- can differ from `league`. */
  leagueUrl: string | null;
}

export interface ActiveBuildRecord {
  version: 1;
  build: PobBuildSnapshot;
  origin: ActiveBuildOrigin;
  pinned: boolean;
  savedAt: string;
  refreshedAt: string;
  sourcePath: string | null;
  sourceModifiedAt: string | null;
  sourceUpdatedAt: string | null;
  identity: ActiveBuildIdentity;
}

export interface ActiveBuildStatus {
  available: boolean;
  origin: ActiveBuildOrigin | null;
  pinned: boolean | null;
  savedAt: string | null;
  refreshedAt: string | null;
  ageMs: number | null;
  stale: boolean | null;
  refreshable: boolean;
  sourceFile: string | null;
  sourceModifiedAt: string | null;
  sourceUpdatedAt: string | null;
  identity: ActiveBuildIdentity | null;
  buildSummary: {
    className: string | null;
    ascendClassName: string | null;
    level: number | null;
    equipmentCount: number;
  } | null;
}

export type TradePriority =
  | "maximum_life"
  | "fire_resistance"
  | "cold_resistance"
  | "lightning_resistance"
  | "chaos_resistance";

export interface TradeCandidate {
  id: string | null;
  name: string;
  baseType: string;
  itemLevel: number | null;
  price: { amount: number | null; currency: string | null } | null;
  /** Only the requested priorities are present -- not every TradePriority key. */
  priorityDeltas: Partial<Record<TradePriority, number>>;
  improvesAllPriorities: boolean;
  mods: string[];
  score: number;
}

export interface TradeUpgradeResult {
  source: "poe_trade_site";
  fetchedAt: string;
  apiStatus: "undocumented_official_site_endpoint";
  league: string;
  searchUrl: string;
  directUrl?: string;
  totalMatches: number;
  currentItem: { name: string; slot: string | null; priorityValues: Partial<Record<TradePriority, number>> } | null;
  appliedFilters: {
    slot: string;
    category: string;
    priorities: TradePriority[];
    minimumCandidateValues: Partial<Record<TradePriority, number>>;
    maxPrice: { amount: number; currency: string };
    maxRequiredLevel: number | null;
    onlineOnly: boolean;
  };
  candidates: TradeCandidate[];
  warning: string | null;
  rateLimit: Record<string, string>;
  note: string;
}

export interface TradeStatFilter {
  /** Explicit GGG trade stat ID (e.g. "pseudo.pseudo_total_life"), or a friendly stat name. */
  id?: string;
  /** Friendly stat name (e.g. "life", "cold_resistance", "movement_speed", "chaos_resistance"). */
  stat?: string;
  min?: number;
  max?: number;
}

export interface TradeSearchOptions {
  /** League name (e.g. "Standard", "Rise of the Abyssal"). Defaults to active character league or "Standard". */
  league?: string;
  /** Equipment slot to search for (e.g. "Helm", "Boots", "Ring", "BodyArmour", "Weapon", "Offhand"). */
  slot?: "Helm" | "BodyArmour" | "Gloves" | "Boots" | "Belt" | "Amulet" | "Ring" | "Ring2" | "Offhand" | "Weapon";
  /** Explicit GGG trade category (e.g. "armour.helmet", "armour.boots", "weapon.crossbow", "accessory.ring"). */
  category?: string;
  /** Item name (e.g. for unique items). */
  name?: string;
  /** Item base type line (e.g. "Expert Hunter Hood", "Rawhide Belt"). */
  baseType?: string;
  /** Rarity filter ("normal", "magic", "rare", "unique", "nonunique"). */
  rarity?: "normal" | "magic" | "rare" | "unique" | "nonunique";
  /** Stat requirements (e.g. minimum life, resistances, attributes). */
  stats?: TradeStatFilter[];
  /** Maximum price budget. */
  maxPrice?: number;
  /** Currency code for maxPrice (default "chaos", or "exalted", "divine"). */
  currency?: string;
  /** Maximum required character level to equip the item. */
  maxRequiredLevel?: number;
  /** Whether to filter to online players only (default true). */
  onlineOnly?: boolean;
  /** Maximum number of candidate items to fetch and inspect (default 10). */
  resultLimit?: number;
}

export interface TradeSearchResult {
  source: "poe_trade_site";
  createdAt: string;
  league: string;
  /** Short official search URL, e.g. https://www.pathofexile.com/trade2/search/poe2/<league>/<searchId> */
  searchUrl: string;
  /** Full URL with query parameters encoded, always guaranteed to open directly in the browser even without API calls. */
  directUrl: string;
  totalMatches: number;
  query: Record<string, unknown>;
  appliedFilters: {
    slot?: string;
    category?: string;
    name?: string;
    baseType?: string;
    rarity?: string;
    stats?: Array<{ id: string; label?: string; min?: number; max?: number }>;
    maxPrice?: { amount: number; currency: string };
    maxRequiredLevel?: number;
    onlineOnly: boolean;
  };
  candidates: TradeCandidate[];
  warning: string | null;
  rateLimit?: Record<string, string>;
  note: string;
}

export type GameEventType =
  | "area_entered"
  | "level_up"
  | "death"
  | "trade_whisper"
  | "player_message"
  | "instance_created"
  | "raw_unmatched";

export interface GameEvent {
  type: GameEventType;
  /** ISO 8601 timestamp parsed from the log line, in the local system's timezone. */
  timestamp: string;
  /** The original, unmodified log line this event was parsed from. */
  raw: string;
  /** Type-specific structured fields, e.g. { area: "Riverbank" } or { level: 12 }. */
  data: Record<string, string | number | boolean | null>;
}

export interface RecentEventsSnapshot {
  source: "client_log";
  queriedAt: string;
  /** Whether a Client.txt path was resolved, without exposing the local absolute path. */
  logAvailable: boolean;
  events: GameEvent[];
}

export interface CurrentAreaSnapshot {
  source: "client_log";
  queriedAt: string;
  area: string | null;
  enteredAt: string | null;
}

export interface SessionSummary {
  source: "client_log";
  sessionStartedAt: string;
  queriedAt: string;
  areasVisited: number;
  deaths: number;
  levelUps: number;
  lastKnownArea: string | null;
}

// ---------------------------------------------------------------------------
// AI -> server: advisory actions
//
// This is the ONLY direction in which the AI can cause the server to "do"
// something. Every AdvisoryActionType is a side channel that never touches
// the game process (no synthetic input, no memory writes, no automation of
// gameplay). See PROTOCOL.md "Why advisory-only" for the reasoning.
// ---------------------------------------------------------------------------

export type AdvisoryActionType =
  | "overlay_message" // short text shown in a desktop overlay window
  | "tts_callout" // spoken out loud via the OS text-to-speech voice
  | "desktop_notification" // native OS notification (notify-send / osascript / toast)
  | "log_note"; // appended to a local advisory log file, no UI interruption

export type AdvisoryUrgency = "info" | "warning" | "critical";

export interface AdvisoryAction {
  type: AdvisoryActionType;
  /** Player-facing text. Keep it short for tts_callout and overlay_message. */
  message: string;
  urgency: AdvisoryUrgency;
  /** Optional machine-readable reason, e.g. "low_flask_charges", "boss_detected". */
  reason?: string;
  /** Optional time-to-live in ms for overlay_message before it auto-dismisses. */
  ttlMs?: number;
}

export interface AdvisoryResult {
  delivered: boolean;
  dispatchedVia: AdvisoryActionType;
  dispatchedAt: string;
  error?: string;
}
