# poe2-mcp-server

An MCP server that gives an MCP-compatible AI CLI (Claude Code, Codex CLI,
Antigravity, or anything else speaking MCP) read access to your Path of
Exile 2 character data and recent in-game events, and one narrow, safe way
to talk back to you. See **[PROTOCOL.md](./PROTOCOL.md)** for the full
protocol spec and the reasoning behind its design, especially the
"advisory-only" boundary — read that before extending this.

## What this does and doesn't do

**Does:**
- Fetches character level/class/experience/equipment/skills from GGG's
  official developer API.
- Tails your local `Client.txt` log for near-real-time events: area
  entries, level-ups, deaths, trade whispers.
- Gives the AI one tool, `emit_advisory`, to surface a message to you via a
  desktop notification, spoken text-to-speech, a log line, or a file a
  separate overlay UI could render — nothing that touches the game.

**Doesn't:**
- Send input to PoE2, read/write its process memory, or otherwise automate
  gameplay. That's excluded on purpose — it's real automation of gameplay
  and against Path of Exile's ToS. `src/adapters/memory-adapter.ts` explains
  the tradeoffs if you ever want to go there yourself; it's an unimplemented
  stub here, not a starting point I'd hand you without you deciding that on
  purpose.
- Expose live combat stats (current HP/ES/mana, position, nearby monsters).
  GGG's API doesn't provide these; only the memory-reading route above
  would, with everything that implies.

## Setup

### 1. Install and build

```sh
npm install
npm run build
```

### 2. Register a GGG API application

1. Go to <https://www.pathofexile.com/developer> and register a new
   application.
2. Register it as a **public client** (no client secret) using **PKCE**.
3. Set its redirect URI to `http://127.0.0.1:8730/callback` (or pick a
   different port and set `POE2_REDIRECT_PORT` to match everywhere below).
4. Note the client ID it gives you.

### 3. Authorize the app against your account

```sh
export POE2_GGG_CLIENT_ID="the-client-id-from-step-2"
export POE2_CONTACT_EMAIL="you@example.com"   # GGG requires a contact in the User-Agent
npm run auth
```

This opens a consent URL (visit it in a browser, log in, approve), catches
the redirect locally, and stores an access/refresh token pair under
`~/.config/poe2-mcp-server/tokens.json` (mode `0600`, never written to the
project directory). The refresh token is valid 90 days per GGG's docs; after
that, run `npm run auth` again.

### 4. Point it at your Client.txt (optional — it tries to auto-detect first)

The server searches common Steam/Standalone/Epic install locations for your
platform on startup (see `src/config.ts`). If it doesn't find yours —
including if you're on Linux under Proton somewhere non-standard — set it
explicitly:

```sh
export POE2_CLIENT_LOG_PATH="/path/to/Path of Exile 2/logs/Client.txt"
```

### 5. Run it standalone once, to sanity-check

```sh
POE2_GGG_CLIENT_ID=... POE2_CONTACT_EMAIL=... node dist/index.js
```

You should see it print the resolved `Client.txt` path (or a warning if it
couldn't find one) and then sit waiting for an MCP client on stdio.

## Wiring it into an AI CLI

All three examples below assume you've already run steps 1–4 above; they
just tell the CLI how to launch the server.

### Claude Code

Either run:

```sh
claude mcp add poe2 -- node /absolute/path/to/poe2-mcp-server/dist/index.js
```

(then set the env vars through `claude mcp add --env` or your shell), or
add `examples/claude-code-mcp.json`'s contents to a `.mcp.json` in your
project or `~/.claude.json` under `mcpServers`.

### Codex CLI

Either run:

```sh
codex mcp add poe2 -- node /absolute/path/to/poe2-mcp-server/dist/index.js
```

or add `examples/codex-config.toml`'s `[mcp_servers.poe2]` block to
`~/.codex/config.toml` directly.

### Antigravity

Add `examples/antigravity-mcp-config.json`'s contents under `mcpServers` in
`~/.gemini/config/mcp_config.json` (global) or `.agents/mcp_config.json`
(per-workspace), or use the `/mcp` command inside Antigravity to add it
interactively.

In all three cases, fill in the real absolute path to `dist/index.js` and
your actual `POE2_GGG_CLIENT_ID`/`POE2_CONTACT_EMAIL` — none of the example
files above are usable verbatim.

## Tools exposed

| Tool | Direction | Summary |
|---|---|---|
| `list_characters` | server → AI | Character names on your account (via GGG API or poe.ninja) |
| `get_character_state` | server → AI | Level/class/xp/league for one character (via GGG API or poe.ninja) |
| `get_inventory` | server → AI | Equipped items + skill gems for character or active build |
| `get_current_character` | server → AI | Which character other tools default to (explicit or log-inferred) |
| `set_active_character` | server → AI | Pin the default character for the tools below |
| `set_account_name` | AI → server | Set PoE account name (e.g. `rpeters1428-1042`) for poe.ninja queries |
| `import_poe_ninja_character` | server → AI | Import character build directly from poe.ninja profile/URL |
| `get_passive_tree` | server → AI | Allocated passive node hashes + jewel data (names not resolved yet) |
| `get_defenses` | server → AI | Gear-only life/ES/armour/evasion/resistances/block/attributes |
| `get_offense_stats` | server → AI | Gear-only weapon damage/crit/speed stats (not a DPS number) |
| `compare_item` | server → AI | Diff a pasted item against what's currently equipped in that slot |
| `get_recent_events` | server → AI | Recent parsed log events (area/level/death/trade) |
| `get_current_area` | server → AI | Last area entered, per the log |
| `get_session_summary` | server → AI | Areas visited / deaths / level-ups this session |
| `is_pob_running` | server → AI | Best-effort check for a running Path of Building 2 process |
| `list_recent_pob_builds` | server → AI | Recently saved PoB2 `.xml` builds, most-recent first |
| `import_pob_build` | server → AI | Parse a pasted PoB2 share code, XML, file, pobb.in, or poe.ninja URL |
| `emit_advisory` | AI → server | The only "action" tool — see PROTOCOL.md |

Full schemas: `src/types.ts`. Full protocol rationale: `PROTOCOL.md`.

## A note on the log-line patterns

`src/adapters/client-log.ts` parses `Client.txt` with regexes based on
long-standing community knowledge of the format — GGG doesn't publish a
spec for it, and exact wording can drift between patches or locales.
Unmatched lines still come through as `raw_unmatched` (with the original
text) rather than being dropped, so nothing is lost if a pattern goes
stale — but if you notice events not firing, `tail -f` your real
`Client.txt`, find the actual line, and adjust the pattern.

## A note on the GGG API adapter

`src/adapters/ggg-api.ts` targets `GET /character/poe2` and
`GET /character/poe2/<name>` per GGG's published reference
(<https://www.pathofexile.com/developer/docs/reference>), requiring the
`account:characters` scope. This is account-sheet data (refreshed on
request), not a live feed — there's no current HP/mana/position here, by
design of GGG's own API, independent of anything this project chose to
build or not build.

## A note on the Path of Building 2 tools

GGG's OAuth application registration is closed to new applications as of this writing ("We are
currently unable to process new applications") — see `pathofexile.com/developer/docs/index`. If
you don't already have a registered client ID, every tool above that hits the GGG API
(`list_characters`, `get_character_state`, `get_inventory`, `get_passive_tree`, `get_defenses`,
`get_offense_stats`, `compare_item`) is unusable until either you get one or GGG reopens
applications (contact `oauth@grindinggear.com`, per a GGG staff forum reply — no confirmed
turnaround time).

`is_pob_running`/`list_recent_pob_builds`/`import_pob_build` (`src/adapters/pob.ts`,
`src/build/pob-decode.ts`, `src/build/pob-parser.ts`) are an alternative that doesn't need any of
that: paste a build exported from Path of Building 2 (its "Generate POB Code" feature, or a saved
`.xml` file) and get back equipment/skills/passive allocation plus **PoB's own already-computed
stats** (real DPS/EHP/crit/etc, with full skill+support+tree interactions) — better than this
project's own gear-only `get_defenses`/`get_offense_stats` where it's available, since PoB actually
simulates the build rather than aggregating raw affixes. There's no live IPC into a running PoB2
window (same reasoning as `memory-adapter.ts` for PoE2 itself), so `is_pob_running` is a best-effort
process-name check and `list_recent_pob_builds`'s "most recent" is a guess at what you're working
on, not a confirmation — `import_pob_build` (paste or pick a file) is the reliable path. The exact
schema was verified against PoB2's own Lua source and cross-checked against an independent
third-party parser, but a few specifics (the share-code compression variant, the real running
process name, `Settings.xml`'s custom build-path attribute) weren't confirmable without a live
install — if `is_pob_running`/`list_recent_pob_builds` don't find your install, adjust the
candidate lists in `src/adapters/pob.ts`/`src/config.ts` the same way you'd adjust a
`client-log.ts` regex that's gone stale.

## A note on `get_defenses`/`get_offense_stats`/`compare_item`

These aggregate stats from **equipped gear only** (`src/build/defenses.ts`,
`src/build/offense.ts`, `src/build/mod-parser.ts`). GGG's API has no base
life/mana-per-level, no passive-tree stat values (only allocated node
hashes — see `get_passive_tree`), and no skill/support gem data, so these
are not the character's actual in-game totals and `get_offense_stats` is
deliberately not a DPS number. Each response's own `note` field says so.
Affix text parsing is regex-based, same "best-effort, keep the raw text so
nothing is silently dropped" approach as the log-line patterns above — if
you notice a common affix not being picked up, extend the `PATTERNS` table
in `mod-parser.ts`. A PoB2-backed calculation engine and a local, patch-
versioned game-data set (to resolve passive hashes and skill gems to names)
are deliberately not part of this milestone.
