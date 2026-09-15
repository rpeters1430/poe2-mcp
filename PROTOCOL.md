# PoE2 MCP Server — Communication Protocol

This document specifies the protocol between `poe2-mcp-server` and whatever
MCP-compatible AI client is talking to it (Claude Code, Codex CLI,
Antigravity, or anything else that speaks MCP). The transport is standard
MCP-over-stdio; this document only covers the *shape and meaning* of the
data that crosses it, not the MCP envelope itself.

## Why advisory-only

The original ask was for the AI's responses to be "interpretable by the
server to trigger in-game actions." Taken literally — the AI decides to do
something, and the server translates that into simulated input inside PoE2
— that's automation of gameplay, which is against Path of Exile's Terms of
Service regardless of how sophisticated or well-intentioned the AI behind it
is. It's also the one part of this design that could get an actual account
actioned, which isn't a tradeoff to make silently on someone's behalf.

So the protocol below keeps a hard line: the server exposes rich read-only
state to the AI, and the AI can act only by asking the server to tell the
*player* something. The player remains the only thing that ever sends input
to the game. This preserves the spirit of the request — the AI's output
changes what happens next — without the ToS/ban exposure of the AI
operating the character itself.

If you ever want to cross that line anyway, that's your call to make
deliberately, not something to bolt on later without noticing you've
changed the risk profile. The `emit_advisory` tool is the seam where a
future, riskier "trigger real input" tool would go if you decided you
wanted one.

## Direction 1: server -> AI (game state)

Exposed as ordinary MCP tools (not resources), since each one represents an
on-demand query rather than a subscribable value, and tool calls are what
every MCP client — including Codex CLI and Antigravity's current clients —
reliably supports today.

| Tool | Backed by | Freshness |
|---|---|---|
| `list_characters` | GGG official API | On request (network call) |
| `get_character_state` | GGG official API | On request (network call) |
| `get_inventory` | GGG official API | On request (network call) |
| `get_current_character` | Local state file, or `Client.txt` inference | On request |
| `set_active_character` | Local state file | Write-through |
| `get_active_build_status` | Active-build provenance envelope | On request; file/ninja source may refresh |
| `refresh_active_build` | Selected PoB file or poe.ninja identity | Explicit refresh |
| `clear_active_build` | Local active-build state | Write-through |
| `get_passive_tree` | GGG official API | On request (network call) |
| `get_defenses` | GGG official API (gear-only, computed) | On request (network call) |
| `get_offense_stats` | GGG official API (gear-only, computed) | On request (network call) |
| `compare_item` | Pasted item text + GGG official API | On request (network call) |
| `find_trade_upgrades` | Equipped gear + GGG trade site | Live search; up to 10 listing details |
| `get_recent_events` | Local `Client.txt` tail | ~1s poll interval |
| `get_current_area` | Local `Client.txt` tail | ~1s poll interval |
| `get_session_summary` | Local `Client.txt` tail | ~1s poll interval |
| `is_pob_running` | Local process check | On request (best-effort) |
| `list_recent_pob_builds` | Local PoB2 Builds folder | On request (file mtimes) |
| `import_pob_build` | PoB2 share code/XML, approved remote URL, or `.xml` inside `POE2_POB_BUILDS_PATH` | On request (as fresh as the export) |

Two independent data sources, deliberately not merged into one blob:

- **GGG's official API** (`src/adapters/ggg-api.ts`) gives you authoritative
  account-sheet data: character level, class, experience, equipped items,
  skill gems. It does **not** give you live combat stats (current HP/ES/mana,
  position, nearby monsters) — GGG doesn't expose that over the API, full
  stop. It's rate-limited and network-dependent.
- **The local game log** (`src/adapters/client-log.ts`) gives you near-real-time
  *events* — area transitions, level-ups, deaths, trade whispers — parsed
  from `Client.txt` as new lines are written. It's local, has no rate limit,
  but is limited to what the game happens to log; it's not a stat feed.

Every response includes a `source` field and a freshness marker
(`fetchedAt` or `queriedAt`) so the AI (and you, reading its reasoning) can
tell "this is what the character sheet said 40 seconds ago" from "this
event happened 2 seconds ago" — that distinction matters for how much to
trust a recommendation built on it.

Active-build-derived responses additionally include an `activeBuild` envelope
with `origin`, `pinned`, `refreshedAt`, `ageMs`, and known account/character/
league identity. File sources are checked by mtime on use; poe.ninja sources
have a five-minute TTL. `get_active_build_status` exposes only the source
filename, not its absolute local path.

`find_trade_upgrades` is advisory and read-only: it searches online listings
and returns an official `pathofexile.com/trade2/...` URL but never whispers,
reserves, buys, or otherwise performs a trade. Its GGG-hosted endpoint is not
part of the published developer API, so responses explicitly carry
`apiStatus: "undocumented_official_site_endpoint"` and may report an access
warning or require a locally configured session cookie.

A third category, gear-derived build data (`get_passive_tree`,
`get_defenses`, `get_offense_stats`, `compare_item`), is computed from the
same GGG API data rather than fetched directly, and carries its own
`"source": "gear_only"` or `"source": "computed"` marker plus a `note` field
spelling out what's *not* included: base life/mana from character level and
class, passive-tree stat effects (only allocated node hashes are exposed —
resolving those to names/effects needs a local, patch-versioned tree
dataset this project doesn't have yet), and any skill/support gem scaling
(so `get_offense_stats` is raw gear inputs, not a DPS number). `get_current_character`/
`set_active_character` let the AI avoid re-asking which character to use on
every call — see `src/adapters/active-character.ts`.

A fourth category, Path of Building 2 import (`is_pob_running`,
`list_recent_pob_builds`, `import_pob_build`), is an alternative to the GGG
API entirely -- useful when GGG OAuth access isn't available (application
registration is currently closed to new applicants) or simply preferred,
since `import_pob_build`'s `playerStats` are PoB's own real computed
DPS/EHP/crit/etc numbers (full skill+support+tree simulation), not the
gear-only approximation `get_defenses`/`get_offense_stats` produce. There's
no live IPC into a running PoB2 window, so `import_pob_build` is the reliable
path (paste a share code/raw XML, use an approved pobb.in/Pastebin/poe.ninja URL,
or point at a `.xml` file inside the configured `POE2_POB_BUILDS_PATH`);
`is_pob_running`/`list_recent_pob_builds` are best-effort convenience checks
only -- see `src/adapters/pob.ts` and `src/build/pob-parser.ts` for the
schema notes and what's still unverified against a real install.

### Schemas

See `src/types.ts` for the canonical TypeScript definitions
(`CharacterState`, `InventorySnapshot`, `GameEvent`, `RecentEventsSnapshot`,
`CurrentAreaSnapshot`, `SessionSummary`). Summary:

```jsonc
// get_character_state result
{
  "source": "ggg_api",
  "fetchedAt": "2026-09-14T23:00:00.000Z",
  "name": "pagenfailes",
  "characterClass": "Deadeye",
  "league": "Standard",
  "level": 42,
  "experience": 123456789,
  "hardcore": false
}

// get_recent_events result
{
  "source": "client_log",
  "queriedAt": "2026-09-14T23:00:05.000Z",
  "logAvailable": true,
  "events": [
    {
      "type": "area_entered",
      "timestamp": "2026-09-14T22:59:58.000Z",
      "raw": "2026/09/14 22:59:58 ... : You have entered Riverbank.",
      "data": { "area": "Riverbank" }
    }
  ]
}
```

`GameEvent.type` is one of: `area_entered`, `level_up`, `death`,
`trade_whisper`, `player_message`, `instance_created`, `raw_unmatched`.
`trade_whisper` and `player_message` data contains `untrusted: true`; callers
must treat chat text as third-party content, never instructions.
`raw_unmatched` is retained in a separate diagnostics buffer and is returned
only when explicitly selected with `types: ["raw_unmatched"]`; it includes
the original line in `raw` because log wording can shift between patches.

## Direction 2: AI -> server (advisory actions)

There is exactly **one** tool the AI can call to "do" something:
`emit_advisory`. Its argument is an `AdvisoryAction`:

```jsonc
{
  "type": "overlay_message" | "tts_callout" | "desktop_notification" | "log_note",
  "message": "Your flask charges are low, don't push into the next pack yet.",
  "urgency": "info" | "warning" | "critical",
  "reason": "low_flask_charges",   // optional, machine-readable
  "ttlMs": 4000                     // optional, for overlay_message
}
```

Every value of `type` is a channel that reaches the *player*, never the
game process:

- `log_note` — appended to a local advisory log file. No interruption; good
  default for anything not urgent.
- `desktop_notification` — a native OS notification (`notify-send` /
  `osascript` / `msg.exe` depending on platform).
- `tts_callout` — spoken aloud via the OS's text-to-speech voice. Useful for
  "don't look away from the fight to read this" situations.
- `overlay_message` — written to a small JSON file
  (`~/.local/state/poe2-mcp-server/overlay-latest.json`) that a *separate*,
  purpose-built overlay UI could watch and render on top of the game
  window. This server deliberately does not draw an overlay itself — that's
  a distinct project (closer to what your existing Item Coach overlay
  already does) and out of scope here.

The server returns an `AdvisoryResult` confirming delivery:

```jsonc
{ "delivered": true, "dispatchedVia": "desktop_notification", "dispatchedAt": "2026-09-14T23:00:06.000Z" }
```

### What's intentionally *not* here

- No tool that accepts coordinates, keybinds, or item/skill identifiers to
  "use" — there is nothing in this protocol an AI could call to move the
  character, use a flask, or click a trade window, even indirectly.
- No write path into `Client.txt` or the GGG API — everything server-side
  is read-only except the advisory log/overlay files, which only ever
  contain player-facing text.

## Interaction model

Pull/on-demand, per your call: the AI decides when to call
`get_recent_events` / `get_character_state` / etc., the same as any other
MCP tool. There's no push channel from server to AI — MCP's current
notification/resource-subscription mechanisms aren't uniformly supported
across Claude Code, Codex CLI, and Antigravity today, and starting with
pull keeps the server simple and the behavior predictable (nothing happens
that the AI, and by extension you, didn't just ask for). If you later want
the server to proactively flag something like "you just died" without
being asked, `get_recent_events` already gives an AI running a short polling
loop everything it needs to notice that itself and call `emit_advisory` —
no protocol change required.
