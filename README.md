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

## Setup Options

You can run `poe2-mcp-server` in two ways:
1. **Zero-Config Mode (Recommended — No GGG Developer Account Needed)**: Uses your public PoE account name on **poe.ninja**, **Path of Building 2** share codes/XML, local `Client.txt` tailing, and native **Ctrl+C** item copying.
2. **GGG Developer OAuth Mode (Optional)**: Uses official GGG Developer API credentials.

---

### Method A: Zero-Config Mode (No GGG Account Setup Required)

#### 1. Install and build
```sh
npm install
npm run build
```

#### 2. Set your account name (optional, or configure via Web Dashboard)
```sh
export POE2_ACCOUNT_NAME="YourAccount-1234"
```
*(You can also set this or paste a poe.ninja URL / PoB share code directly in the Web Dashboard at `http://localhost:8787/`!)*

#### 3. Run with Docker (Recommended) or Node
Create a `.env` file (see `.env.example`):
```ini
POE2_ACCOUNT_NAME=YourAccount-1234
POE2_CONFIG_DIR_HOST=C:\Users\you\.config\poe2-mcp-server
POE2_CLIENT_LOG_DIR_HOST=C:\Program Files (x86)\Steam\steamapps\common\Path of Exile 2\logs
POE2_POB_BUILDS_DIR_HOST=C:\Users\you\Documents\Path of Building (PoE2)\Builds
POE2_SERVE_PORT=8787
```
Then start the container:
```sh
docker compose up -d
```
Or start directly with Node:
```sh
npm run serve
```

#### 4. Start the Windows Ctrl+C Clipboard Watcher (While Gaming)
In a separate terminal on your gaming PC:
```sh
npm run watch-clipboard
```

---

### Method B: GGG Developer OAuth (Optional)

If you prefer using GGG's official developer API:
1. Register a public client app at <https://www.pathofexile.com/developer> with redirect URI `http://127.0.0.1:8730/callback`.
2. Authorize your account:
```sh
export POE2_GGG_CLIENT_ID="your-client-id"
export POE2_CONTACT_EMAIL="you@example.com"
npm run auth
```
This opens the GGG consent URL and saves tokens to `~/.config/poe2-mcp-server/tokens.json`.

---

### Client.txt Path Resolution (Auto-Detected)

The server automatically scans default Steam, Standalone, and Epic install locations for `Path of Exile 2/logs/Client.txt`. To override manually:
```sh
export POE2_CLIENT_LOG_PATH="C:\Program Files (x86)\Steam\steamapps\common\Path of Exile 2\logs\Client.txt"
```

### Optional: authenticated trade-site searches

`find_trade_upgrades` first tries GGG's trade-site endpoints without a
session. If the site returns HTTP 401/403, set `POE2_TRADE_POESESSID` in the
server process environment to the value from your own logged-in Path of Exile
browser session. Treat this value like a password: never paste it into an AI
conversation, commit it, or put it in an example config.

## Wiring it into an AI CLI

There are two primary ways to connect an AI CLI to this server:

1. **Remote over LAN / Wi-Fi (Recommended for gaming):** Run Path of Exile 2 and this server on your **gaming desktop**, and run **Claude Code (or Antigravity / Cursor / Codex)** on your **laptop**. See [Connecting from an AI CLI on your laptop](#connecting-from-an-ai-cli-on-your-laptop) below.
2. **Local on the same machine:** Run both the game and the AI CLI locally on the gaming desktop using a standard stdio subprocess:

### Local stdio on the same machine

If you are running the AI CLI directly on your gaming PC:

#### Claude Code (Local stdio)
```sh
claude mcp add poe2 -- node /absolute/path/to/poe2-mcp-server/dist/index.js
```
(or add `examples/claude-code-mcp.json` into `.mcp.json` or `~/.claude.json`).

#### Codex CLI (Local stdio)
```sh
codex mcp add poe2 -- node /absolute/path/to/poe2-mcp-server/dist/index.js
```
(or add `examples/codex-config.toml`'s block to `~/.codex/config.toml`).

#### Antigravity (Local stdio)
Add `examples/antigravity-mcp-config.json` into `~/.gemini/config/mcp_config.json` or `.agents/mcp_config.json`, or use `/mcp`.

---

## Remote access: Docker, web dashboard, and clipboard-to-compare

If you play Path of Exile 2 on your **desktop** and want to interact with your AI CLI from a **laptop** over Wi-Fi/LAN (while playing the game with 0% FPS impact), use `src/serve.ts` (or Docker).

The server exposes:
* **Streamable HTTP MCP endpoint** at `http://<desktop-ip>:8787/mcp`
* **Real-time Web Companion Dashboard** at `http://<desktop-ip>:8787/`
* **Live WebSocket link** at `ws://<desktop-ip>:8787/ws`
* **REST API** at `http://<desktop-ip>:8787/api/*`

### Run it (Docker on gaming desktop - Recommended)

Double-click `start-server-docker.bat` or run:

```sh
docker compose up -d
```

*(Pre-configured with your game paths, logs, PoB builds, and account name in `.env` and `docker-compose.yml`)*.

### Run it (Native on gaming desktop, no Docker)

```sh
npm run build
npm run start:serve
```

Then open `http://localhost:8787/` (or `http://<desktop-ip>:8787/` from your laptop) for the web dashboard.

---

### Clipboard → compare, automatically (In-game workflow)

`src/clipboard-watcher.ts` runs **natively on the Windows gaming desktop, never in Docker** — Docker cannot monitor host Windows clipboard events. It uses an ultra-low-overhead persistent PowerShell STA worker polling every 200ms with near-zero CPU usage (0% game stutter while playing Path of Exile 2).

On your Windows desktop:
```sh
npm run watch-clipboard
```
(or simply double-click `start-watcher.bat`).

When you press **Ctrl+C** on an item in Path of Exile 2:
1. The watcher instantly detects the item text (`Item Class:...`).
2. It pushes it to the server (`POST /api/clipboard-item`) and stores it in the active session.
3. The item is immediately broadcast to the web dashboard (`http://localhost:8787/`) and made available to connected AI CLIs via MCP tools.
4. When the AI CLI emits an advisory (`tts_callout`), the watcher plays the spoken advice through your desktop speakers/headphones while you play!

---

### Connecting from an AI CLI on your laptop

When running on your desktop with Docker (`docker compose up -d` or `start-server-docker.bat`), your MCP server is accessible across your local network at:

```
http://<desktop-ip>:8787/mcp
```
*(Your desktop's local IP on this network is `192.168.50.163`, or via Tailscale `100.77.144.56`)*.

#### Pre-flight network check (from your laptop terminal)
Before configuring your AI CLI, make sure your laptop can reach the gaming desktop:
```sh
curl http://192.168.50.163:8787/api/status
```
If you get a JSON response with `"status": "healthy"`, you are ready to connect! If it times out, ensure port 8787 is allowed inbound in Windows Defender Firewall on the desktop.

---

#### 1. Claude Code CLI (on your laptop)

##### Option A: Using the CLI command
Open your terminal on your laptop and run:

```sh
# Add globally across all projects on your laptop (Recommended):
claude mcp add --scope user --transport http poe2 http://192.168.50.163:8787/mcp

# Or add to the current project only:
claude mcp add --transport http poe2 http://192.168.50.163:8787/mcp
```

*(If you configured `POE2_WEB_TOKEN` in your desktop `.env`, pass `--header "X-POE2-Token: <your-token>"`)*.

##### Option B: Using a configuration file
You can also add it directly to `.mcp.json` in your laptop project folder, or globally in `~/.claude.json` under `"mcpServers"` (see `examples/claude-code-remote-mcp.json`):

```json
{
  "mcpServers": {
    "poe2": {
      "type": "http",
      "url": "http://192.168.50.163:8787/mcp"
    }
  }
}
```

##### Verifying in Claude Code
Start Claude Code on your laptop (`claude`) and run the slash command:
```
/mcp
```
You should see `poe2` marked as connected with all 25 tools loaded (e.g. `compare_item`, `get_latest_clipboard_item`, `create_trade_search`, `get_server_status`, `get_defenses`, etc.).

---

#### 2. Antigravity / Gemini CLI (on your laptop)
In your laptop's `~/.gemini/config/mcp_config.json` (global) or `.agents/mcp_config.json` (per-project) (see `examples/antigravity-remote-mcp.json`):

```json
{
  "mcpServers": {
    "poe2": {
      "url": "http://192.168.50.163:8787/mcp"
    }
  }
}
```
Or type `/mcp` inside Antigravity and add `http://192.168.50.163:8787/mcp`.

---

#### 3. Cursor / Windsurf / VS Code (on your laptop)
In your editor's MCP Settings:
* **Server Name:** `poe2`
* **Type:** `streamableHttp` (or `http` / `sse`)
* **URL:** `http://192.168.50.163:8787/mcp`

---

### Playing the game while connected

While playing Path of Exile 2:
1. Hover over any dropped or equipped item and press **Ctrl+C**.
2. Look at your laptop or speak to your AI CLI:
   * *"Is the item I just copied an upgrade for my build?"*
   * *"Compare this item to my current gear"*
   * *"What do you think of this drop?"*
3. The AI calls `compare_item` (with no arguments needed!) or `get_latest_clipboard_item`.
   * For **Rings**, it automatically evaluates both Ring 1 and Ring 2, displays stat deltas for both, and recommends which ring slot to replace.
   * For other items, it deterministically determines the slot from the PoE 2 `Item Class:` header, calculates defense and resistance deltas, and delivers feedback.
4. If the AI calls `emit_advisory` with `type: "tts_callout"`, your desktop audio speaks the advice out loud while you continue playing!

---

### Asking for Trade Links & Searches (No GGG Client ID Required)

You can ask your AI CLI to generate trade search links at any time—whether you have GGG OAuth configured or not:
* *"Find me boots with 25+ movement speed, life, and cold resistance under 20 chaos"*
* *"Give me a trade search link for a helmet with life and cold res"*
* *"Search trade for an Expert Hunter Hood with high evasion"*
* *"Find upgrades on trade for my gloves"*

The AI CLI automatically:
1. Calls `create_trade_search` (for requirement-based searches) or `find_trade_upgrades` (for gear-relative upgrade searches).
2. Maps friendly stat names (`life`, `cold_res`, `movement_speed`, etc.) to official GGG trade pseudo IDs.
3. Provides you with a clickable `searchUrl` (official short link) and `directUrl` (direct query link with all filters pre-loaded).
4. Summarizes preview candidate listings with prices directly in your chat.
5. Operates 100% without needing any GGG Developer Client ID or OAuth credentials.

---

### Web Dashboard & Active Build Management

Open `http://localhost:8787/` (or `http://<desktop-lan-ip>:8787/` from your laptop) in any browser:

1. **Active Build & Sync Panel:**
   * **poe.ninja Import:** Enter your PoE account name (e.g. `rpeters1428-1042`), character name, or paste a direct `https://poe.ninja/poe2/profile/...` URL.
   * **PoB Import:** Paste any PoB2 share code (`pobb.in/...` or base64 code) or raw build XML.
   * **Instant AI Synchronization:** Updating your build in the dashboard immediately updates `active-build.json`, so Claude Code, Antigravity, and all MCP AI CLI tools instantly see your new gear, passive tree, and defenses without restarting anything.
   * **1-Click Upstream Refresh:** Click **↻ Sync / Refresh Build** or **↻ Refresh Character** to re-fetch the latest poe.ninja or local PoB data.
2. **Session Progress & Death Tracking:**
   * Automatically tails PoE 2's `Client.txt` using PoE 2 engine patterns (`[LOADING SCREEN]`, scene source changes, and death logs).
   * Reads recent session history upon startup so current zone, areas visited, and deaths are immediately accurate without needing to restart the game.
   * Live WebSocket push delivers deaths and area transitions to the browser dashboard in real time.
3. **In-Game Gear Comparison:**
   * Instant side-by-side visual card diff whenever you press <kbd>Ctrl+C</kbd> in-game.

---

### A note on exposure

This server holds your GGG OAuth tokens and can trigger desktop
notifications/TTS on the desktop it runs on. Once it's reachable beyond
`localhost` (LAN access from your laptop, or a published Docker port),
anything else on that network can reach `/api`, `/ws`, and `/mcp` too. Set
`POE2_WEB_TOKEN` to a long random string (checked via an `X-POE2-Token`
header, or a `?token=` query param for the dashboard/websocket) unless
you're certain you trust everything on your LAN. Don't expose this port
past your home network/router.

## Tools exposed

| Tool | Direction | Summary |
|---|---|---|
| `list_characters` | server → AI | Character names on your account (via GGG API or poe.ninja) |
| `get_character_state` | server → AI | Level/class/xp/league for one character (via GGG API or poe.ninja) |
| `get_inventory` | server → AI | Equipped items + skill gems for character or active build |
| `get_current_character` | server → AI | Which character other tools default to (explicit or log-inferred) |
| `set_active_character` | server → AI | Pin the default character for the tools below |
| `get_active_build_status` | server → AI | Active build source, identity, age, and refresh capability |
| `get_server_status` | server → AI | Unified diagnostics: server uptime, active character, build status, client log tailer state, clipboard, and endpoints |
| `refresh_active_build` | AI → server | Reload the same PoB file or poe.ninja character |
| `get_latest_clipboard_item` | server → AI | Most recent item copied with Ctrl+C in-game (text, affixes, stats, age) |
| `compare_item` | server → AI | Diff an item against equipped gear (supports dual-ring auto comparison & recommendation); defaults to latest Ctrl+C item if omitted |
| `clear_active_build` | AI → server | Clear only the local active-build selection |
| `set_account_name` | AI → server | Set PoE account name (e.g. `rpeters1428-1042`) for poe.ninja queries |
| `import_poe_ninja_character` | server → AI | Import character build directly from poe.ninja profile/URL |
| `get_passive_tree` | server → AI | Allocated passive nodes, resolved to names/stats where possible, + jewel data |
| `search_passive_tree_nodes` | server → AI | Look up passive node ids by (partial) name, e.g. to resolve a passive the player names in chat |
| `update_active_build_progress` | AI → server | Hand-track a level-up or passive allocation reported in chat, without needing a fresh PoB2/poe.ninja sync; starts a new hand-tracked build if none exists yet |
| `find_passive_tree_upgrades` | server → AI | Unallocated notable/keystone nodes within a few hops of your current allocation, from the real tree graph |
| `get_skill_setup` | server → AI | Current skill + linked support gems (accurate from a PoB2/poe.ninja import; a naming-heuristic guess otherwise) |
| `get_defenses` | server → AI | Gear-only life/ES/armour/evasion/resistances/block/attributes |
| `get_offense_stats` | server → AI | Gear-only weapon damage/crit/speed stats (not a DPS number) |
| `find_trade_upgrades` | server → AI | Search/rank live listings against equipped gear and return the official trade URL |
| `create_trade_search` | server → AI | Generate official PoE2 trade links from requirements (slot, stats, budget) without GGG API client ID |
| `get_recent_events` | server → AI | Recent parsed log events (area/level/death/trade/chat); raw diagnostics are opt-in |
| `get_current_area` | server → AI | Last area entered, per the log |
| `get_session_summary` | server → AI | Areas visited / deaths / level-ups this session |
| `is_pob_running` | server → AI | Best-effort check for a running Path of Building 2 process |
| `list_recent_pob_builds` | server → AI | Recently saved PoB2 `.xml` builds, most-recent first |
| `import_pob_build` | server → AI | Parse a PoB2 share code/raw XML, approved URL, or `.xml` inside `POE2_POB_BUILDS_PATH` |
| `emit_advisory` | AI → server | The only "action" tool — see PROTOCOL.md |

Full schemas: `src/types.ts`. Full protocol rationale: `PROTOCOL.md`.

## A note on the log-line patterns

`src/adapters/client-log.ts` parses `Client.txt` with regexes based on
long-standing community knowledge of the format — GGG doesn't publish a
spec for it, and exact wording can drift between patches or locales.
Unmatched lines are retained in a separate diagnostics buffer and returned
only when the caller explicitly requests `types: ["raw_unmatched"]` (with
the original text). If you notice events not firing, `tail -f` your real
`Client.txt`, find the actual line, and adjust the pattern.

## A note on the GGG API adapter

`src/adapters/ggg-api.ts` targets `GET /character/poe2` and
`GET /character/poe2/<name>` per GGG's published reference
(<https://www.pathofexile.com/developer/docs/reference>), requiring the
`account:characters` scope. This is account-sheet data (refreshed on
request), not a live feed — there's no current HP/mana/position here, by
design of GGG's own API, independent of anything this project chose to
build or not build.

## A note on `get_passive_tree`'s node name resolution

`src/adapters/tree-data.ts` resolves the raw allocated passive node hashes
`get_passive_tree` returns to names/stats, using GGG's own official PoE2 tree
export (`github.com/grindinggear/poe2-skilltree-export`'s `data.json`),
cached locally for 24h since it's patch-versioned data, not per-request. This
works entirely independently of the GGG developer API/client ID: it's a
public, unauthenticated file, so it resolves node names for
`import_pob_build`/`import_poe_ninja_character` builds too, not just
`get_passive_tree` via the GGG API path. The schema was verified against a
live fetch of the real ~5MB `data.json`: nodes are keyed by id in the same
id space as `passives.hashes`/PoB2's `<Spec nodes="...">`, with real fields
`name`, `isKeystone`/`isNotable`/`isMastery`, `stats`, and `ascendancyId` (a
slug like `"Ranger3"`, not the ascendancy's flavor name like "Deadeye" —
this project doesn't map slot-to-flavor-name yet). `resolveNodeNames` never
throws and always returns one entry per allocated hash (with `name: null`
for anything it can't resolve), so the raw hash is never lost even if a
future patch changes the schema; if resolution starts coming back empty,
re-fetch `data.json` and check the field candidates in `tree-data.ts`.

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

Imported builds are stored with a provenance envelope instead of as an
unlabeled snapshot. `get_active_build_status` shows whether selection was
explicitly pinned or automatic, the known character/league identity, refresh
age, and a redacted source filename. File-backed builds refresh when their
mtime changes; poe.ninja-backed builds refresh after five minutes or on
`refresh_active_build`. Pasted share-code/XML builds cannot be re-fetched and
must be imported again. `clear_active_build` removes only this local selection.

## A note on manual build tracking (no fresh export needed)

`import_pob_build`/`import_poe_ninja_character` are the reliable path for
full accuracy (gear, skills, PoB's own DPS/EHP), but they require the player
to go export/sync something every time they level up or take a passive — a
gap in the moment-to-moment "I just leveled up" / "I took Zealot's Oath"
conversation. `update_active_build_progress` (`src/adapters/active-build.ts`)
closes that gap: it lets the AI hand-update just the active build's level
and/or allocated passive node ids from what the player says in chat,
without touching the game process (same local-write-through pattern as
`set_active_character`/`clear_active_build`, not the `emit_advisory`
seam — see PROTOCOL.md). If no active build exists yet at all, pass
`className` to start a brand-new one (`source: "manual"`, `origin:
"manual"`) with empty equipment/skills until a real build is later
imported. Editing an existing build pins it (`pinned: true`) so automatic
PoB-file/poe.ninja re-selection won't silently discard the edit; an explicit
`refresh_active_build`, or the underlying source actually changing, is still
the way to resync from the original source and drop the manual edits.
`search_passive_tree_nodes` resolves a passive's name (as the player said
it) to the node id `addPassiveNodeIds` needs, using the same tree dataset as
`get_passive_tree`'s node-name resolution above.

## A note on "optimize my build" tools

`find_passive_tree_upgrades` and `get_skill_setup` exist to ground "how can I
improve my passive tree / support gems" answers in real fetched data instead
of the AI's own (possibly stale, possibly wrong-league) memory:

- `find_passive_tree_upgrades` does a breadth-first walk of the real tree
  graph (`out`/`in` edges in the same GGG tree export used for node-name
  resolution) out from your currently allocated nodes, and returns nearby
  unallocated notables/keystones (optionally masteries) with their real stat
  text and hop distance. It does not know your build's damage type/defense
  priorities — that judgment call is left to the AI, informed by
  `get_defenses`/`get_offense_stats`, over concrete real candidates rather
  than invented ones. Hop distance approximates extra points needed, not a
  guaranteed final pathing cost.
- `get_skill_setup` surfaces the character's skill and support gems. This is
  only accurate when an active PoB2/poe.ninja build is imported — PoB's own
  `<Skill>`/`<Gem>` XML groups each active skill with its attached supports
  correctly (`src/build/pob-parser.ts`). Without one, it falls back to GGG's
  official API, which returns skill/support gems as one flat item list with
  no confirmed support-to-skill link data for PoE2 — the fallback can only
  guess "support" from gem naming (`likelySupport`), not group gems by skill.
  There is no public support-gem compatibility/tag dataset for PoE2 the way
  the tree export exists for passives, so any specific support swap
  suggested on top of this data is the AI's own game knowledge, not
  something this server verified — same category of gap as
  `get_offense_stats` not producing a real DPS number.

## Trade upgrade searches

`find_trade_upgrades` translates a build-aware request into a live PoE2 trade
search. For example, “a helmet that improves cold resistance and maximum life,
costs at most 1 exalted, and requires level 40 or lower” maps to:

```json
{
  "slot": "Helm",
  "priorities": ["cold_resistance", "maximum_life"],
  "maxPrice": 1,
  "currency": "exalted",
  "maxRequiredLevel": 40
}
```

The tool reads the equipped helmet, raises each trade filter to at least one
point above that item's contribution, requests online listings, compares up to
10 fetched candidates, and returns `searchUrl` for the official trade page.
Pass `league` explicitly when the active character/build has no verified
league identity. Listings can disappear or change price at any time.
Candidate mods include stats granted by socketed Runes/Soul Cores/Talismans
(PoE2's trade API represents these as nested `socketedItems`, not a flat mod
list on the parent item). `slot: "Offhand"` spans four distinct trade
categories (Shield, Buckler, Focus, Quiver); the tool infers the right one
from the currently equipped item's base type and reports the resolved
`category` in `appliedFilters`, falling back to Shield with an explicit
warning when nothing is equipped or its type can't be determined.

This uses endpoints hosted by GGG's official trade site, but those endpoints
are not documented in GGG's published developer API. The adapter therefore
uses short timeouts, bounded responses, at most 10 detail results, reports rate
limit headers, and labels the source `undocumented_official_site_endpoint`.

### Standalone trade search without GGG Client ID (`create_trade_search`)

If you want to generate an official Path of Exile 2 trade search link for arbitrary item requirements—without needing a GGG Developer Client ID, OAuth tokens, or an equipped character—use the `create_trade_search` MCP tool or `POST /api/trade/search`.

Example MCP call:
```json
{
  "league": "Standard",
  "slot": "Boots",
  "stats": [
    { "stat": "movement_speed", "min": 25 },
    { "stat": "maximum_life", "min": 60 },
    { "stat": "cold_resistance", "min": 30 }
  ],
  "maxPrice": 20,
  "currency": "chaos",
  "maxRequiredLevel": 65
}
```

Example REST request:
```sh
curl -X POST http://localhost:8787/api/trade/search \
  -H "Content-Type: application/json" \
  -d '{"slot":"Helm","stats":[{"stat":"life","min":50},{"stat":"fire_res","min":30}],"maxPrice":10}'
```

What this returns:
- **`searchUrl`**: Official short trade search link (`https://www.pathofexile.com/trade2/search/poe2/<league>/<id>`).
- **`directUrl`**: Direct query-encoded link (`https://www.pathofexile.com/trade2/search/poe2/<league>?q=<query>`) that opens directly in your browser with all filters pre-loaded even if the live GGG search endpoint is offline or rate-limited.
- **`candidates`**: Up to 10 live preview listings (name, base type, item level, price, mods) when the live API responds.
- Common friendly stat shortcuts supported: `life`, `cold_res`, `fire_res`, `lightning_res`, `chaos_res`, `movement_speed`, `attack_speed`, `cast_speed`, `critical_strike_chance`, `armour`, `evasion`, `energy_shield`, `strength`, `dexterity`, `intelligence`, and all standard PoE pseudo stats.

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
in `mod-parser.ts`. Passive node hashes are now resolved to names/stats (see
`get_passive_tree`'s note above), but that resolved data isn't folded into
these aggregates yet — a PoB2-backed calculation engine and parsing passive
node stat text the same way gear affixes are parsed are deliberately not
part of this milestone. Skill/support gem scaling is also out of scope here.
