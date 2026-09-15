# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server that exposes Path of Exile 2 character/game data to MCP-compatible
AI clients (Claude Code, Codex CLI, Antigravity) as read-only tools, plus exactly
one narrow write path (`emit_advisory`) for the AI to surface a message back to
the player. Read **PROTOCOL.md** before changing anything under `src/tools/`,
`src/advisory/`, or `src/types.ts` — it documents the "advisory-only" boundary
this project deliberately does not cross (no synthetic input, no game-process
memory access, nothing that automates gameplay or risks a ToS action). Any
change that could blur that line is a deliberate decision to flag to the user,
not something to make silently.

## Commands

```sh
npm run build   # tsc -p tsconfig.json -> dist/
npm run dev     # tsx src/index.ts (run the server directly from TS, no build step)
npm run auth    # tsx src/auth.ts  (one-time interactive GGG OAuth/PKCE flow)
npm start       # node dist/index.js (run the built server)
npm test        # node --import tsx --test src/adapters/*.test.ts src/build/*.test.ts (node:test, no build step)
```

Tests are colocated as `src/**/*.test.ts` next to the module they cover (e.g.
`src/build/mod-parser.test.ts`), using node's built-in `node:test`/`node:assert`
rather than a new dependency, and are excluded from `tsc`'s `include` so they
never land in `dist/`. Coverage covers the pure functions under `src/build/`
(mod/property/item-text parsing, defenses/offense aggregation, comparison, PoB
decode/parse) plus filesystem-backed active-build lifecycle tests
(`active-build.test.ts`, using a temp config/builds dir) and mocked-network
trade-search tests (`trade.test.ts`, stubbing `globalThis.fetch`) — the
client-log tailer and the GGG API/OAuth adapters still have no tests. There is
no lint config in this repo currently; CI (`.github/workflows/ci.yml`) runs
build/test/audit/pack on Node 20/22/24. There's also no `--watch` script; use
`npm run dev` for iteration.

To sanity-check the server standalone against stdio (it just waits for an MCP
client to connect and prints the resolved `Client.txt` path to stderr):

```sh
POE2_GGG_CLIENT_ID=... POE2_CONTACT_EMAIL=... npm run dev
```

Required env for anything touching the GGG API: `POE2_GGG_CLIENT_ID`,
`POE2_CONTACT_EMAIL` (GGG requires a contact string in the User-Agent). See
`.env.example` for the full list including optional overrides
(`POE2_CLIENT_LOG_PATH`, `POE2_REDIRECT_PORT`, `POE2_MCP_CONFIG_DIR`).

## Architecture

Two independent, never-merged data sources feed the read-only tools, each
tagged with its own `source` field in every response so the AI can tell
"account sheet as of N seconds ago" from "log event 2 seconds ago":

- **`src/adapters/ggg-api.ts`** — GGG's official developer API
  (`GET /character/poe2`, `GET /character/poe2/<name>`). Account-sheet data:
  level, class, XP, equipment, skill gems, passives (allocated node hashes +
  jewel data, not resolved to names). Network-dependent, rate-limited, no
  live combat stats (GGG doesn't expose HP/mana/position over this API, full
  stop — that's not a gap this project can close from this side). The
  character-detail endpoint returns everything (equipment/skills/passives) in
  one call, so `fetchCharacterState`/`fetchInventorySnapshot`/`fetchPassiveTree`
  all go through a shared `fetchRawCharacter` with a ~10s in-memory TTL cache
  rather than each hitting the API independently.
  Auth is handled by **`src/adapters/ggg-oauth.ts`**: PKCE public-client OAuth
  against GGG, tokens cached at `~/.config/poe2-mcp-server/tokens.json`
  (mode `0600`, refreshed automatically, never written into the repo).
  `npm run auth` (→ `src/auth.ts`) drives the one-time interactive consent flow.

- **`src/adapters/active-character.ts`** — resolves which character
  `get_passive_tree`/`get_defenses`/`get_offense_stats`/`compare_item` default
  to when `characterName` is omitted: an explicit `set_active_character` call
  (state file at `configDir()/active-character.json`) always wins; otherwise a
  best-effort inference pass over recent `death`/`level_up` log events, clearly
  labeled `"inferred_from_log"` rather than presented as certain. Same
  override-then-autodetect shape as `config.ts`'s log-path resolution.

- **`src/adapters/client-log.ts`** — tails the local `Client.txt` on a ~1s
  poll and regex-parses lines into typed `GameEvent`s (`area_entered`,
  `level_up`, `death`, `trade_whisper`, `instance_created`, plus
  `raw_unmatched` as a catch-all so an unrecognized line is surfaced with its
  original text rather than silently dropped). These regexes are based on
  community knowledge of the log format, not a GGG spec, and can drift between
  patches/locales — if an event isn't firing, find the real line in the user's
  `Client.txt` and adjust the pattern in `PATTERNS`. `ClientLogTailer` keeps an
  in-memory ring buffer (500 events) and is constructed once in `src/index.ts`
  and threaded into `registerTools`.

- **`src/adapters/memory-adapter.ts`** — an intentionally unimplemented stub
  (`UnimplementedMemoryAdapter`) for reading live process state (HP/ES/mana,
  position). Do not implement this without the user explicitly asking — it
  requires reverse-engineered memory offsets and is the one part of this
  project that risks an actual ToS action on the user's account. The file's
  own comments explain the tradeoffs; treat "implement the memory adapter" as
  a request to re-read and discuss those tradeoffs first, not a green light.

**`src/config.ts`** resolves the `Client.txt` path (env override first, then
platform-specific candidate paths for Steam/Standalone/Epic installs) and
holds the config dir / token store path / GGG API base URLs / User-Agent
builder. All of it is env-driven with sensible fallbacks — check here first
when adding a new env var.

**`src/tools/register.ts`** is the single place all MCP tools are registered
on the `McpServer` (via `@modelcontextprotocol/sdk`), wiring each read-only
tool to its adapter and the one write tool (`emit_advisory`) to
**`src/advisory/dispatch.ts`**. Every tool result is plain JSON text
(`jsonResult`/`errorResult` helpers) — there are no MCP resources or
subscriptions in this server, by design (see PROTOCOL.md "Interaction model"
for why: pull-only, nothing fires without the AI asking for it).

**`src/advisory/dispatch.ts`** fulfills `emit_advisory` actions. Every branch
is a side channel to the *player*, never the game process: append to a local
log file, write an OS desktop notification (`notify-send`/`osascript`/
`msg.exe` per platform), speak via OS TTS, or write a JSON file
(`~/.local/state/poe2-mcp-server/overlay-latest.json`) that a *separate*
overlay UI (not part of this repo) could render. If you add a new
`AdvisoryActionType`, it must fit this same constraint — no path that reaches
the game process.

**`src/types.ts`** is the canonical source of the wire schema in both
directions (server→AI state snapshots, AI→server `AdvisoryAction`). Keep it
and `PROTOCOL.md`'s schema examples in sync when changing shapes.

**`src/build/`** turns raw GGG API data into gear-derived build data —
deliberately *not* a full character sheet, since GGG's API has no base
life/mana-per-level, no passive-tree stat effects (only allocated node
hashes), and no skill/support gem data. Every computed type carries a
`"gear_only"`/`"computed"` source marker and a `note` field saying what's
missing, same transparency pattern as the two adapters above:
  - `mod-parser.ts` — regex-table affix parser (`+45 to maximum Life` →
    `{ stat: "maximum_life", value: 45 }`), same "always keep the raw text,
    unmatched isn't dropped" philosophy as `client-log.ts`. Extend `PATTERNS`
    here for a new affix, not by special-casing callers.
  - `item-properties.ts` — reads GGG's `properties`/`additionalProperties`
    item fields (base Armour/Evasion/ES/damage-range/crit/APS numbers,
    distinct from affix text).
  - `defenses.ts` / `offense.ts` — pure functions aggregating an
    `InventorySnapshot`'s equipped items into `DefenseStats`/`OffenseStats`.
    `get_offense_stats` is explicitly not a DPS number — no skill/support gem
    scaling exists yet (that's PoB2-bridge or game-data-layer territory,
    both deferred).
  - `item-text.ts` — parses the standard PoE clipboard item format (Ctrl+C
    in-game, or copied from a trade site) into the same shape as
    `InventoryItem`.
  - `compare.ts` — diffs a parsed pasted item against whatever's currently
    equipped in the matching slot (inferred from base type, or passed
    explicitly), both per-affix and via a hypothetical `computeDefenses` swap.

**`src/adapters/tree-data.ts`** resolves the raw allocated passive node hashes
`get_passive_tree` returns (from either `ggg-api.ts` or a PoB2/poe.ninja
build) to names/stats, by fetching GGG's own official PoE2 tree export
(`github.com/grindinggear/poe2-skilltree-export`'s `data.json`) and caching
it to `configDir()/tree-data-cache.json` for 24h (patch-versioned data, not
per-request). The schema was verified against a live fetch of the real
`data.json` (~5MB, 5153 nodes as of writing): `nodes` is keyed by node id as
a string, matching the same id space as GGG's `passives.hashes` and PoB2's
`<Spec nodes="...">` (no translation needed), and a node's real fields are
`name` (display name -- the inner `id` field is a machine slug, not the
display name), `isKeystone`/`isNotable`/`isMastery` (booleans, present only
on nodes of that type), `stats` (raw description lines), and `ascendancyId`
(a slug like `"Ranger3"` -- base class + ascendancy slot number, NOT the
ascendancy's flavor name like "Deadeye"; there's no slot-to-flavor-name
mapping in this dataset yet). `resolveNodeNames` still tries a couple of
alternate key spellings per field (PoE1's older `dn`/`ks`/`not`/`m`
abbreviations) in case a future patch changes the schema, never throws, and
always returns one entry per input hash (with `name: null` for anything
unresolved) so the raw id is never lost — same "best-effort, verify against
reality, fix in place" pattern as `client-log.ts`'s `PATTERNS` or `pob.ts`'s
candidate process names.

**Path of Building 2 import** (`src/adapters/pob.ts`, `src/build/pob-decode.ts`,
`src/build/pob-parser.ts`) is an alternative build-data source to the GGG API
tools above — relevant right now because GGG's OAuth application registration
is closed to new applicants, blocking every `ggg-api.ts`-backed tool for
anyone without an existing client ID. `import_pob_build` parses a build the
player exports from PoB2 (a share code: URL-safe base64 wrapping Deflate-
compressed XML, `pob-decode.ts` tries both raw and zlib-wrapped since the
source didn't confirm which) or a saved `.xml` file, into the same
`InventoryItem` shape via its own `parsePobItemText` (in `pob-parser.ts`) --
**not** `item-text.ts`'s `parseItemText`. PoB2's internal item text turned
out (verified against a real exported build) to be a different, delimiter-
free format: `Rarity:`, 1 name line (Normal/Magic) or 2 (Rare/Unique), then
loose `Key: Value` lines ending in `Implicits: N`, then bare mod lines --
initially assumed from source-reading to match the clipboard format, which
was wrong; corrected once tested against real data. `item-text.ts`'s
`parseItemText` remains correct for its own use case (compare_item's pasted
clipboard/trade-site text) -- the game's actual copy-paste format, confirmed
separately. Skills/passive-tree parsing (real attribute names: `nameSpec`/
`skillId`/`level`/`quality`/`enabled` on `<Gem>`, `classId`/`ascendClassId`
lowercase-d on `<Spec>`, root element `<PathOfBuilding2>` not
`<PathOfBuilding>`) matched what source-reading predicted and needed no
correction. Beyond equipment, a parsed build also carries skills and
passive-tree node hashes, plus — the key advantage over
`get_defenses`/`get_offense_stats` — PoB's own already-computed `PlayerStat`
values (real DPS/EHP/etc from full skill+support+tree simulation, not a
gear-only approximation). There's no
live IPC into a running PoB2 window (same reasoning as `memory-adapter.ts`
for PoE2 itself), so `is_pob_running` (process-name check) and
`list_recent_pob_builds` (most-recently-modified `.xml` in the Builds folder)
are best-effort convenience checks, not confirmed-current data — pasting a
fresh export via `import_pob_build` is the reliable path. The XML schema was
verified against PoB2's own Lua source and cross-checked against an
independent third-party parser; if `is_pob_running`/`list_recent_pob_builds`
don't find a real install, the candidate process-name list (`pob.ts`) or
builds-path list (`config.ts`'s `candidatePobBuildsPaths`) need adjusting,
same "verify against reality" pattern as everywhere else in this project.

**poe.ninja fallback** (`src/adapters/poe-ninja.ts`, `src/adapters/active-build.ts`)
is a third build-data source, alongside the GGG API and PoB2 import above,
for the common case of neither being available (no GGG OAuth client ID, no
PoB2 export handy): `set_account_name` + `import_poe_ninja_character` (or a
pasted `poe.ninja/poe2/profile/.../character/...` URL) fetch a character's
public poe.ninja profile, which — when it has a `pathOfBuildingExport` field
— gets decoded through the *same* `resolvePobXml`/`parsePobXml` pipeline as
`import_pob_build`, so a poe.ninja import produces an identical
`PobBuildSnapshot`. `active-build.ts` centralizes the "what build backs the
gear/defense tools right now" question with a three-step cascade
(`resolveActiveBuild`): an explicitly saved/imported build
(`configDir()/active-build.json`) first, then the most-recently-modified
local PoB2 `.xml`, then a poe.ninja lookup if `POE2_ACCOUNT_NAME` is set —
same override-then-autodetect shape as `active-character.ts` and
`config.ts`'s log-path resolution. `src/tools/register.ts`'s GGG-API-backed
tools (`list_characters`, `get_character_state`, `get_inventory`,
`get_passive_tree`, `get_defenses`, `get_offense_stats`, `compare_item`) each
catch a GGG API failure and fall back through poe.ninja then the active
build via `pobBuildToInventorySnapshot`/`pobBuildToPassiveTree`/
`pobBuildToCharacterState`, so all three data sources answer the same tool
surface rather than needing separate tools per source.

## Adding a new tool

1. Add/extend the wire type in `src/types.ts` if it returns a new shape.
2. Implement the data access in the appropriate adapter (or a new one under
   `src/adapters/`) — keep GGG-API-backed and log-backed logic separate, don't
   merge them into one call.
3. Register it in `src/tools/register.ts` with a zod `inputSchema` and a
   `readOnlyHint`/`openWorldHint` annotation reflecting reality.
4. Update the tool table in `README.md` and, if it changes the protocol
   surface, `PROTOCOL.md`.
