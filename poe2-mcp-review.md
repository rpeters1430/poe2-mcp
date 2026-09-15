# poe2-mcp — Code Review & Roadmap

**Repo:** `rpeters1430/poe2-mcp` @ `145270d` (merge of PR #8)
**Reviewed:** 2026-09-15
**Scope:** every file under `src/`, `README.md`, `PROTOCOL.md`, `CLAUDE.md`, `package.json`, `tsconfig.json`, `renovate.json`, `examples/`

## Baseline

| Check | Result |
|---|---|
| `npm ci` | ✅ clean |
| `npm run build` (TypeScript 7.0.2) | ✅ no errors |
| `npm test` | ✅ 37/37 pass |
| `npm audit` | ✅ 0 vulnerabilities |
| Lint / CI / LICENSE | ❌ none present |

The architecture is genuinely good: the advisory-only boundary is well reasoned and documented, every payload carries a `source`/freshness marker, and parsers keep raw text instead of dropping it. Most of the problems below come from the **poe.ninja / PoB fallback path** (added later and now the *primary* path, since GGG OAuth registration is closed) not being held to the same standards as the original GGG path, plus PoE1-era assumptions in the parsers.

**Legend** — ✅ *Confirmed* = reproduced with a probe script against the real code. 🔎 *Verify* = strong suspicion based on PoE2 knowledge/docs; confirm against a live client or real data before fixing.

---

## Summary ranking

| # | Severity | Issue | Status |
|---|---|---|---|
| 1 | 🔴 Critical | Fallbacks return a *different* build labeled as the requested character | ✅ by reading |
| 2 | 🔴 Critical | PoB/poe.ninja slot names don't match GGG slot names → `compare_item` double-counts | ✅ Confirmed |
| 3 | 🔴 Critical | Weapon-swap (and flask/charm) slots counted in defenses/offense | ✅ Confirmed |
| 4 | 🔴 Critical | Chat/whisper lines are misparsed as deaths/area changes (spoofable) | ✅ Confirmed |
| 5 | 🔴 Critical | `import_pob_build` can read any local file / fetch any URL; zip-bomb & recursion | ✅ by reading |
| 6 | 🟠 High | Log noise evicts real events from the 500-slot buffer → session summary wrong | ✅ Confirmed |
| 7 | 🟠 High | Partial log lines split into garbage; overlapping async polls | ✅ Confirmed |
| 8 | 🟠 High | Auto-detected active build is pinned forever; "read-only" tools write state | ✅ by reading |
| 9 | 🟠 High | PoE2 renamed "Critical Strike" → "Critical Hit"; crit stats always null/0 | 🔎 Verify (high confidence) |
| 10 | 🟠 High | Mod parser misses `(implicit)`/`(rune)` suffixes, hybrids, PoB `{tags}` | ✅ Confirmed |
| 11 | 🟠 High | Local defense mods double-counted on top of already-augmented properties | 🔎 Verify |
| 12 | 🟠 High | Elemental weapon damage never read ("Elemental Damage" multi-value property) | 🔎 Verify |
| 13 | 🟠 High | GGG client ignores rate-limit headers; token refresh race; no timeouts | ✅ by reading |
| 14 | 🟠 High | AppleScript injection in macOS desktop notifications | ✅ by reading |
| 15 | 🟠 High | PoB fallback fabricates data (level 1, class name as character name, skills dropped) | ✅ Confirmed |
| 16 | 🟡 Medium | Advisory dispatch: `msg.exe` missing on Win Home, blocking TTS, no rate limit, non-atomic overlay | ✅ by reading |
| 17 | 🟡 Medium | Slot inference from base-type keywords is incomplete for PoE2 bases | ✅ Confirmed |
| 18 | 🟡 Medium | `is_pob_running` can never match on Linux (`ps` truncates to 15 chars) | ✅ by reading |
| 19 | 🟡 Medium | Active-character inference requires GGG API → useless for poe.ninja users | ✅ by reading |
| 20 | 🟡 Medium | `area_entered` pattern may not exist in PoE2's Client.txt | 🔎 Verify |
| 21 | 🟡 Medium | No timeouts / size limits / in-flight dedupe on any outbound fetch | ✅ by reading |
| 22 | 🟡 Medium | poe.ninja adapter duplication & fragility | ✅ by reading |
| 23 | 🟡 Medium | `fetchedAt` / `importedAt` report "now" instead of real data age | ✅ by reading |
| 24 | 🟡 Medium | Token bloat: full build dumps, arbitrary `playerStats.slice(0, 30)` | ✅ by reading |
| 25 | 🟡 Medium | OAuth flow hangs on port conflict / no timeout / stray request kills it | ✅ by reading |
| 26 | 🟡 Medium | Platform paths: Windows uses `~/.config`, Steam library folders, Wine PoB | ✅ by reading |
| 27 | 🟡 Medium | `sinceIso` string comparison breaks with timezone offsets | ✅ by reading |
| 28 | 🟡 Medium | Docs drift (PROTOCOL.md tool table, stale notes, phantom `player_message`) | ✅ by reading |
| 29 | 🟢 Low | Packaging: no shebang (bins broken), wrong `engines`, version in 9 places | ✅ Confirmed |
| 30 | 🟢 Low | Repo hygiene: no LICENSE/CI/lint; Renovate automerge at 0-day release age | ✅ |
| 31 | 🟢 Low | Misc: `set_active_character` edge cases, hardcore detection, log injection, etc. | ✅ by reading |

---

## 🔴 Critical

### 1. Fallbacks silently return a different build under the requested character's name

**Where:** `src/tools/register.ts` L135–138 (`get_character_state`), L153–161 (`get_inventory`), L239–241 (`get_passive_tree`), L265–273 (`get_defenses`), L298–300 (`get_offense_stats`), L333–341 (`compare_item`)

When the GGG call fails for *any* reason (no OAuth, 429 rate limit, network blip, typo in the name), the tools fall back to `resolveActiveBuild()` — which is whatever build was last imported — and stamp the *requested* `characterName` onto it:

```ts
const active = await resolveActiveBuild();
if (active) return jsonResult(pobBuildToCharacterState(active, characterName)); // ← wrong character, right label
```

Ask for `get_character_state("MyWitch")` while the active build is your Ranger and the AI receives the Ranger's data labeled `MyWitch`, with no error. `get_inventory` additionally swallows the original error entirely (`catch {}` at L158), so a rate limit becomes indistinguishable from "no GGG configured."

**Fix:**
- Only fall back to the active build when the caller didn't ask for a specific character, *or* when the active build is known to be that character (store `characterName`/`account`/`league` on `PobBuildSnapshot` when importing from poe.ninja).
- Always include a `fallback: { reason: <original error>, usedSource: "poe_ninja" | "pob_import" }` field so the AI can see why the data came from somewhere else.
- Never overwrite `characterName` with the requested name; report the build's own identity.

### 2. Slot-name mismatch breaks `compare_item` on the PoB/poe.ninja path

**Where:** `src/build/compare.ts` `SLOT_KEYWORDS` + `inventory.equipment.find((item) => item.slot === slot)`

GGG uses `inventoryId`s like `Helm`, `BodyArmour`, `Ring`, `Ring2`, `Weapon`, `Offhand`. PoB2 (and poe.ninja, which goes through PoB XML) uses `Helmet`, `Body Armour`, `Ring 1`, `Ring 2`, `Weapon 1`, `Weapon 2`. `compareItem` infers GGG-style names, so on the PoB path it never finds the current item, **doesn't remove it, and adds the candidate on top**.

Probe result (active PoB build with a helmet giving +50 life, comparing a helmet with +70 life):

```
COMPARE slot Helm current null life before/after 50 120   ← should be 50 → 70
```

Since GGG OAuth registration is closed, this is the path most users will hit.

**Fix:** add a `normalizeSlot()` in one place (e.g. `src/build/slots.ts`) mapping both vocabularies to a canonical enum (`helmet`, `body`, `gloves`, `boots`, `belt`, `amulet`, `ring1`, `ring2`, `weapon1`, `offhand1`, `weapon2`, `offhand2`, `flask*`, `charm*`), and apply it in `toInventoryItem` (GGG), `parseEquipment` (PoB), and the `slot` tool argument.

### 3. Weapon-swap, flask and charm slots are counted in defenses/offense

**Where:** `src/build/defenses.ts` loop over `inventory.equipment`; `src/build/offense.ts` `WEAPON_SLOT = /^weapon/i`

Both aggregators include *everything* equipped. GGG returns `Weapon2`/`Offhand2` (swap set) plus flasks; PoB returns `Weapon 1 Swap`/`Weapon 2 Swap`, `Flask 1..`, `Charm 1..`. Probe: a swap-set shield with +40% fire resistance produced `fire.raw: 40`. The offense regex also treats `Weapon2`/`Weapon 1 Swap` as active weapons.

**Fix:** after slot normalization (#2), aggregate only the active weapon set and armour/jewellery slots. Expose an optional `weaponSet: 1 | 2` argument if you want swap analysis.

### 4. Chat and whispers are misparsed as game events (and are spoofable)

**Where:** `src/adapters/client-log.ts` `PATTERNS` (L27–58)

Patterns are unanchored (`/: (.+?) has been slain\.?$/`) and `death` is checked *before* `trade_whisper`. Probe:

```
": @From Troll: lol Ryan has been slain."  → death   { character: "@From Troll: lol Ryan" }
"#Troll: You have entered Hideout."        → area_entered { area: "Hideout" }
```

Consequences: inflated death counts, wrong `get_current_area`, and any player in global/trade chat can inject fake events. It's also a **prompt-injection vector**: whisper text from strangers flows verbatim into the AI's context via `get_recent_events`.

**Fix:**
- Split the prefix first: `^(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}) \d+ \S+ \[(\w+) [^\]]+\] (.*)$`, then match patterns against the *message* with `^…$` anchors.
- Classify chat first: messages starting with `@From`/`@To` (whisper), `#` (global), `$` (trade), `&` (guild), `%` (party), or containing `<GUILD> Name:` are chat and must never match system patterns.
- Mark chat payloads with `untrusted: true` and mention in the tool description that message text is third-party content, not instructions.

### 5. `import_pob_build` is an arbitrary file-read / URL-fetch primitive

**Where:** `src/build/pob-decode.ts` `resolvePobXml` (L65–165), `register.ts` `import_pob_build`

`code` is auto-detected as a local path (`fs.existsSync(trimmed)` → read any file), or *any* `http(s)` URL (L148 "Generic HTTP(S) URL"), recursively re-resolving whatever comes back. Combined with #4 (untrusted whisper text in context), a crafted whisper can steer the model into fetching `http://attacker/?d=<something>` (exfiltration) or probing LAN services (`http://192.168.1.1/...`). Also:
- `zlib.inflateRawSync` / `inflateSync` / `gunzipSync` have no `maxOutputLength` → a tiny share code can decompress to gigabytes (decompression bomb).
- Recursion has no depth limit (a pastebin whose body is another URL loops).
- No response-size cap on `resp.text()`.

**Fix:**
- Allowlist hosts: `pobb.in`, `pastebin.com`, `poe.ninja`, `poe2db`-style known sites. Drop the generic-URL branch or gate it behind an env flag.
- Restrict file reads to `.xml` files inside `resolvePobBuildsDir()` (or an explicit `POE2_POB_ALLOWED_DIRS`), resolved through `fs.realpathSync` to stop `../` and symlink escapes. Remove path auto-detection from `code`.
- Pass `{ maxOutputLength: 20 * 1024 * 1024 }` to all zlib calls; cap fetched bodies (stream and abort past N MB).
- Add a `depth` parameter to `resolvePobXml` and stop at 2.

---

## 🟠 High

### 6. Log noise evicts real events; session summary is wrong

**Where:** `client-log.ts` ring buffer (`RING_BUFFER_SIZE = 500`) and `getSessionSummary()`

`raw_unmatched` lines go into the same 500-slot buffer as real events. Client.txt emits hundreds of debug/network lines per zone load. Probe: 1 death + 1 area + 600 noise lines → **0 real events retained**, summary shows `deaths: 0, areasVisited: 0`. `getSessionSummary` is documented as "since this server started" but only sees the last 500 lines.

**Fix:** keep separate buffers (e.g. 500 typed events, 200 raw lines), and maintain running session counters (`deaths++`, `areas.add()`) at parse time instead of recomputing from the buffer. Consider making `raw_unmatched` opt-in via the `types` filter.

### 7. Partial lines and overlapping polls

**Where:** `client-log.ts` `pollOnce()` / `setInterval`

- If the game is mid-write, the last line has no newline; readline yields the fragment and `offset` advances past it, so the next poll yields the rest as a separate line. Probe: `"Ryan (Ranger) is now le"` + `"vel 12"` → the level-up was lost and two `raw_unmatched` fragments were stored.
- `setInterval` fires `pollOnce` every second regardless of whether the previous async read finished. After a long file growth (e.g. alt-tab back after a big write) two polls can read the same byte range → duplicated events.

**Fix:** read the byte range into a buffer yourself, only consume up to the last `\n`, carry the remainder, and set `offset` to the byte after the last newline. Guard with a `polling` boolean or use a `setTimeout` chain. Read as `Buffer` and decode once per complete line to avoid splitting multibyte UTF-8 characters.

### 8. Auto-detected active build is pinned forever; "read-only" tools mutate state

**Where:** `src/adapters/active-build.ts` L46, L57, L76; `register.ts` L130

`resolveActiveBuild()` returns `active-build.json` if it exists, and the local-PoB and poe.ninja branches *save* whatever they auto-detect. So the first auto-detection becomes permanent: new PoB saves or a new league character are never picked up again, and there is no tool to clear it. `get_character_state` (annotated `readOnlyHint: true`) also calls `saveActiveBuild`.

**Fix:**
- Store `{ origin: "explicit" | "auto_pob_file" | "auto_poe_ninja", sourcePath?, sourceMtime?, account?, character?, savedAt }` with the build.
- Explicit imports win; auto-detected ones get re-validated (file mtime changed? older than N minutes?).
- Add `clear_active_build` and include the build's origin/age in every response that uses it.
- Keep writes out of `readOnlyHint: true` tools (or flip the hint).

### 9. PoE2 uses "Critical Hit", not "Critical Strike" 🔎

**Where:** `offense.ts` L17 `propertyNumber(item.properties, "Critical Strike Chance")`; `mod-parser.ts` L99 `/Critical (?:Strike )?Chance/`

PoE2 renamed the mechanic: weapon property is **"Critical Hit Chance"**, affixes read **"X% increased Critical Hit Chance"**. Probe: `"25% increased Critical Hit Chance"` → 0 matches. `criticalStrikeChance` will be null for every PoE2 weapon and the increased-crit total always 0. Also verify shield block: PoE2 shows **"Block chance"** as the property name, while `defenses.ts` L43 looks for `"Chance to Block"`.

**Fix:** match `Critical (?:Hit|Strike) Chance`, look up both property names, rename the output fields to `criticalHitChance` (keep an alias for one version if anything depends on it), and add fixture tests with real PoE2 clipboard text.

### 10. Mod parser misses common real-world mod text

**Where:** `src/build/mod-parser.ts` (all patterns anchored with `$`, no pre-normalization)

Probe — every one of these returned **0 matches**:

| Input | Why it fails |
|---|---|
| `+12% to Cold Resistance (implicit)` | Clipboard suffixes `(implicit)`, `(rune)`, `(enchant)`, `(crafted)`, `(fractured)`, `(desecrated)` |
| `+45(40-49) to maximum Life` | Ctrl+Alt+C advanced copy includes roll ranges |
| `{tags:life}+45 to maximum Life` | PoB item text prefixes (`{tags:…}`, `{variant:…}`, `{range:…}`, `{crafted}`) |
| `+15% to Fire and Cold Resistances` | Hybrid resistances — very common on PoE2 gear |
| `+20 to Strength and Dexterity` | Hybrid attributes |

Also missing: `X% increased maximum Life/Mana`, `+X% to Chaos Resistance` when combined with elementals, `+X to Spirit` (PoE2-only stat), `+X% to Maximum <Element> Resistance`.

**Fix:** add a `normalizeModLine()` step: strip `{…}` prefixes, strip trailing `(implicit|rune|enchant|crafted|fractured|desecrated|augmented)`, collapse `N(a-b)` → `N`. For PoB `{variant:x}` lines, only keep those matching the item's `Selected Variant:` (otherwise unique items with variants double-count). Then add hybrid patterns and a real-item fixture test file.

### 11. Local defense mods are double-counted 🔎

**Where:** `src/build/defenses.ts` L53–55

GGG's `properties` (and the clipboard's `Armour: 456 (augmented)`) already include the item's **local** modifiers and quality. `computeDefenses` then multiplies the summed base by *all* `% increased Armour/Evasion/ES` found on gear — including those same local mods on the body armour. Conversely, global `% increased` on jewellery/amulets shouldn't multiply only the gear base anyway (it applies to the total including passives).

**Fix:** treat `properties` values as final per-item values. Only parse `% increased` defenses from items that *don't* have the corresponding base property (non-local), and report those as a separate `globalIncreasedPercent` field instead of folding them into the gear number. Verify against one real item from the API/clipboard (property with `augmented` flag vs. its base type's base value).

### 12. Elemental weapon damage is never read 🔎

**Where:** `src/build/offense.ts` L6 `ELEMENTAL_DAMAGE_PROPERTIES = ["Fire Damage", "Cold Damage", …]`; `item-properties.ts` `propertyRange` only reads `values[0]`

In GGG's item JSON (inherited from PoE1) and in clipboard text, weapon elemental damage is a single **"Elemental Damage"** property with multiple values (e.g. `Elemental Damage: 10-20 (augmented), 5-50 (augmented)`), where the second tuple element identifies the element type. With the current names and first-value-only parsing, `elementalDamage` will be empty for real weapons.

**Fix:** parse all values of `Elemental Damage` (and `Chaos Damage` if present), map the value-type id to fire/cold/lightning for API data, and split comma-separated ranges for clipboard text.

### 13. GGG API client robustness

**Where:** `src/adapters/ggg-api.ts`, `src/adapters/ggg-oauth.ts`

- **Rate limits:** only a 429 is handled. GGG's developer docs require clients to read `X-Rate-Limit-Policy`/`X-Rate-Limit-Rules`/`X-Rate-Limit-<rule>`/`-State` headers and back off *before* hitting limits; repeated violations can get the client blocked. Since this app is registered under your client ID, that's a real risk.
- **Refresh race:** AIs routinely call `get_defenses` + `get_offense_stats` + `get_passive_tree` in parallel. With an expired token, each call refreshes concurrently with the same refresh token; if GGG rotates refresh tokens, the losers fail and may invalidate the stored token. Store a module-level `refreshPromise` and share it.
- **Cache stampede:** the 10s character cache has no in-flight dedupe, so those same parallel calls all miss and fetch. Cache the *promise*, not the result.
- **No 401 handling:** a revoked/early-expired access token isn't retried after one forced refresh.
- **No timeouts:** `fetch` without `AbortSignal.timeout()` can hang a tool call indefinitely.
- Cache key is case-sensitive while other paths lowercase names.

### 14. AppleScript injection in macOS notifications

**Where:** `src/advisory/dispatch.ts` L40–41

```ts
const script = `display notification "${body.replace(/"/g, '\\"')}" with title "…"`;
```

Backslashes aren't escaped, so a message containing `\"` becomes `\\"`, which closes the string; the rest is interpreted as AppleScript, which includes `do shell script`. The message is AI-authored and the AI reads attacker-controlled whisper text (#4). PoE2 has no native macOS client so exploitability is low, but it's a textbook command-injection sink in a security-conscious project.

**Fix:** never interpolate. Use `osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title (item 2 of argv)' -e 'end run' -- <body> <title>`.

### 15. PoB fallback fabricates or mislabels data

**Where:** `src/adapters/active-build.ts` L88–131

- `characterName: overrideName ?? build.className` → the character is named "Ranger" (confirmed in probe).
- `pobBuildToCharacterState` returns `level: build.level ?? 1`, `experience: 0`, `hardcore: false`, `league: null` — invented values presented as facts. Use `null` and mark them unknown.
- `pobBuildToInventorySnapshot` returns `skills: []` even though the build has parsed skill groups.
- `source: (build.source as any) ?? "pob_import"` — `parsePobXml` always sets `"pob_import"`, so poe.ninja imports are reported as PoB imports. The `as any` hides the type mismatch. Set `source` at the import site.
- poe.ninja knows the account, league and character name; all three are discarded after import.

---

## 🟡 Medium

### 16. Advisory dispatch platform & UX issues

**Where:** `src/advisory/dispatch.ts`

- `msg.exe` doesn't exist on Windows Home editions and is designed for terminal-services messaging. Prefer a PowerShell toast (`New-BurntToastNotification` if installed, else `Windows.UI.Notifications` via WinRT) or `node-notifier`.
- `tts_callout` awaits speech completion, so the tool call blocks for the duration of the speech; concurrent callouts overlap. Spawn detached (or queue) and return immediately; add a spawn timeout everywhere.
- No rate limiting: a looping agent can spam TTS/notifications. Add a simple per-type token bucket and dedupe identical `reason` within N seconds.
- `overlay-latest.json` is written in place; an overlay watcher (e.g. Item Coach) can read half-written JSON. Write to a temp file and `rename`.
- `notify-send` treats a message starting with `-` as an option; pass `--` before positional args. Map `urgency: critical` to `-u critical`.
- `ttlMs` is only meaningful for the overlay file; `log_note` messages with newlines can forge extra log lines (escape `\n`). `advisory.log` grows unbounded.
- `~/.local/state` is used on Windows too; honor `XDG_STATE_HOME` and use `%LOCALAPPDATA%` on Windows.

### 17. Slot inference from base type is incomplete

**Where:** `src/build/compare.ts` `SLOT_KEYWORDS`

Probe: `Iron Cap` → `slot: null`. Many PoE2 bases don't contain the listed words (caps, crowns, masks, tiaras, bracers, wraps, sandals, shoes, sabatons, foci, quivers, talismans, etc.). But the clipboard text already tells you: **`Item Class: Helmets`** is the first line, and `parseItemText` explicitly skips it.

**Fix:** capture `Item Class:` into `ParsedItemText.itemClass` and map classes → slots; keep keyword inference only as a fallback. For rings, default to the ring with the worse stat delta and say so, or return comparisons against both.

### 18. `is_pob_running` can't work on Linux

**Where:** `src/adapters/pob.ts` L49 `ps -A`

`ps -A` prints `comm`, truncated to 15 characters on Linux, so `PathOfBuildingCommunity-PoE2` can never appear. Under Wine/Proton the process shows as the `.exe` name, and the Windows executable name 🔎 likely contains spaces (e.g. `Path of Building-PoE2.exe`), which none of the candidates include.

**Fix:** use `ps -eo args` (full command line) on Linux/macOS and `tasklist /FO CSV /NH` on Windows; compare against normalized names with spaces/dashes stripped.

### 19. Active-character inference needs the GGG API

**Where:** `src/adapters/active-character.ts` L60–78

`getActiveCharacter` calls `listCharacterNames()` (GGG only) before looking at the log. Without OAuth — i.e. most users — inference always returns `source: "none"`. Use poe.ninja's character list as the second source, and if neither is available, still return the most recent log-observed name labeled `inferred_from_log_unverified`. Also combine with #20: the tailer starts at EOF, so there's no history to infer from right after startup.

### 20. `area_entered` may not fire on PoE2 🔎

**Where:** `client-log.ts` L30

The `You have entered X.` local-chat line is a PoE1 convention. Community PoE2 level/zone trackers key off `[SCENE] Set Source [Area Name]` and the `Generating level N area "…"` line instead. Grab a few lines from your own Client.txt after a zone change to confirm, then add the `[SCENE]` pattern (ignoring `(null)`/`(unknown)` sources). If confirmed, `get_current_area` and the session area count currently never populate.

### 21. Outbound network calls lack timeouts, caps and dedupe

**Where:** `poe-ninja.ts`, `pob-decode.ts`, `tree-data.ts`, `ggg-api.ts`

Add a shared `httpFetch(url, { timeoutMs, maxBytes })` helper with `AbortSignal.timeout`, a byte cap, a consistent User-Agent (including the contact email — poe.ninja also appreciates identifiable clients), and optional in-flight promise dedupe. `tree-data.ts` specifically: parallel `get_passive_tree` calls can download the ~5 MB file several times, and when offline with a stale cache every call retries the full fetch; add a failure backoff (e.g. don't retry for 5 minutes) and serve stale-with-note in the meantime.

### 22. poe.ninja adapter fragility & duplication

- The poe.ninja profile API is undocumented; shapes can change without notice. Validate responses with zod (you already depend on it) and turn schema failures into clear errors.
- `fetchNinjaCharacters` L69: `c.league.toLowerCase()` throws if `league` is missing.
- League slugging and account normalization are implemented twice with different rules (`poe-ninja.ts` normalizes `#`→`-` and lowercases leagues; the ninja branch in `pob-decode.ts` does neither). Have `resolvePobXml` call `parseNinjaProfileUrl` + `fetchNinjaAsPobBuild`.
- URL-parsed account names aren't `decodeURIComponent`'d (`%23` stays literal).
- No response caching; add a short TTL (60s) keyed by account/character.
- `normalizeAccountName` uses `replace("#", "-")`, which is fine today but reads as a bug; use `replaceAll`.

### 23. Freshness markers lie

- `ggg-api.ts` L150/164/177: `fetchedAt: new Date()` even when served from the 10s cache. Store the real fetch time in the cache entry.
- `parsePobXml` sets `importedAt: now` — a PoB file saved three weeks ago looks brand new. For file imports, include `sourceModifiedAt` (file mtime); for poe.ninja, include its `updated` timestamp.
- Freshness is one of the project's core promises (PROTOCOL.md "Every response includes a source field and a freshness marker"), so this is worth fixing properly.

### 24. Token bloat in tool results

- `import_pob_build` returns the entire parsed build (all items, mods, gems, node ids) pretty-printed. Return a compact summary like `import_poe_ninja_character` does, and let `get_inventory`/`get_passive_tree` fetch details.
- `get_passive_tree` returns `allocatedHashes` *and* every resolved node's full stat lines. Add `detail: "summary" | "notables" | "full"` (default: keystones + notables + ascendancy).
- `get_defenses` uses `playerStats.slice(0, 30)` — PoB's stat order isn't a priority order, so important stats can be cut. Select by name (see feature F2).
- `JSON.stringify(data, null, 2)` indentation costs ~20–30% extra tokens; use compact JSON (or `structuredContent`, feature F1).

### 25. OAuth flow edge cases

**Where:** `src/adapters/ggg-oauth.ts` `runInteractiveAuth`

- `server.listen` has no `error` handler → `EADDRINUSE` leaves the promise pending forever.
- No overall timeout on waiting for the redirect.
- Any request to `/callback` with a wrong `state` (browser prefetch, a double-click) rejects and closes the server; ignore mismatches and keep waiting instead.
- `saveTokens` writes with `mode: 0o600`, but `mode` only applies when *creating* a file; an existing token file keeps its old permissions. `chmodSync` after write, and write atomically (temp + rename).
- Nice-to-have: open the browser automatically (`xdg-open`/`open`/`start`).

### 26. Platform path resolution gaps

**Where:** `src/config.ts`

- Windows state lives in `~/.config/poe2-mcp-server`; use `%APPDATA%` (and honor `XDG_CONFIG_HOME` on Linux).
- Steam libraries on other drives aren't found. Parse `steamapps/libraryfolders.vdf` to enumerate library roots; on Linux also check Lutris/Heroic/Bottles prefixes.
- PoB2 on Linux runs under Wine/Proton, so its Builds folder lives inside a prefix (`…/pfx/drive_c/users/steamuser/Documents/Path of Building (PoE2)/Builds`); none of the candidates cover that. Localized/relocated `Documents` folders on Windows aren't covered either.
- The Client.txt path is resolved once at startup; if the file appears later (fresh install, game launched after the CLI) the tailer never starts. Re-resolve on each poll while `logPath` is null.
- `configDir()` calls `mkdirSync` on every invocation; memoize.
- State files (`active-character.json`, `account-name.json`, `active-build.json`) are written non-atomically without explicit permissions.

### 27. `sinceIso` comparison is lexicographic

**Where:** `client-log.ts` L141

`e.timestamp >= opts.sinceIso` only works when both strings are UTC `Z` ISO strings with identical precision. `z.string().datetime()` in zod 4 accepts only `Z` by default, which masks this today, but relaxing the schema (e.g. `{ offset: true }`) would silently break filtering. Compare `Date.parse()` values. Also guard `new Date(...).toISOString()` in `parseLine`, which throws `RangeError` on an invalid date and would kill that poll.

### 28. Documentation drift

- `PROTOCOL.md` tool table is missing `set_account_name`, `import_poe_ninja_character`, and describes the GGG-backed tools as GGG-only, although all of them now fall back to poe.ninja/PoB.
- `PROTOCOL.md` and the `pob-parser.ts` note still say passive node names are unresolved ("needs a local game-data layer this project doesn't have yet"); `tree-data.ts` resolves them now.
- `player_message` exists in `GameEventType` and the zod enum but no pattern ever emits it and `PROTOCOL.md` doesn't list it.
- README tool table marks `set_account_name` as "AI → server" alongside `emit_advisory`, which muddies the "only one action tool" story. Consider distinguishing "config writes" from "player-facing actions."
- README setup leads with GGG app registration (closed) while `examples/antigravity-mcp-config.json` already uses the poe.ninja path; lead with the path that works today.
- Tool descriptions and `.env.example` use your real account name (`rpeters1428-1042`) as the example. Models tend to copy example values verbatim, so another user's agent may call `set_account_name` with your account. Use an obvious placeholder like `YourName-1234`.

---

## 🟢 Low

### 29. Packaging

- `dist/index.js` and `dist/auth.js` have no `#!/usr/bin/env node` shebang, so the `bin` entries fail under `npx`/global install (confirmed: first line of `dist/index.js` is an `import`). Add the shebang to `src/index.ts`/`src/auth.ts` (tsc preserves it).
- `"engines": { "node": ">=18.17" }` is inaccurate: Node 18 is EOL, and the current MCP SDK/zod 4 toolchain targets Node 20+. Set `>=20`.
- The `"0.1.0"` version string is duplicated in 9 places across `src/`. Read it once from `package.json` (`createRequire` or `import … with { type: "json" }`).
- `npm test` uses an unquoted `src/**/*.test.ts`: `sh` doesn't do `**` globstar (it happens to work because all tests are one directory deep) and Windows `cmd` won't expand it at all. Quote it and let `node --test` expand the glob.

### 30. Repo hygiene

- No `LICENSE` file — the repo is public but legally "all rights reserved."
- No CI: add a GitHub Actions workflow running `npm ci && npm run build && npm test` on Linux + Windows (path logic differs per platform).
- No linter/formatter (ESLint + Prettier or Biome).
- `renovate.json` sets `minimumReleaseAge: "0 days"` with automerge for minor/patch. Given recent npm supply-chain incidents, a 3–7 day release age for automerged updates is a cheap safety margin.

### 31. Miscellaneous

- `set_active_character`: with no GGG and no account name it accepts any string unvalidated; when poe.ninja is down it refuses an explicit choice entirely. Allow explicit set with a `validated: false` flag. There's no way to clear it.
- `set_active_character` says "case-sensitive" but poe.ninja lookups elsewhere are case-insensitive; pick one behavior.
- `hardcore` detection via `league.includes("hardcore")` misses abbreviations like `HC …` 🔎; return `null` when unsure rather than `false`.
- `listRecentPobBuilds` isn't recursive (PoB supports sub-folders) and throws if a file is deleted between `readdirSync` and `statSync`.
- Tree data URL is pinned to the `master` branch 🔎 and the cache isn't keyed by patch version; prefer the latest tag/release and invalidate when the version changes. Also add an `ascendancyId` → display-name map (`Ranger3` → `Deadeye`) from `classes[].ascendancies`.
- `index.ts` shutdown doesn't close the MCP server/transport, and there's no `unhandledRejection` handler.
- `get_inventory` doesn't consult the active character when `characterName` is omitted, unlike its sibling tools.
- `memory-adapter.ts` is fine as documented; keep it an unimplemented stub.

---

## ✨ New features (ranked by value ÷ effort)

### Tier 1 — do next

**F1. `structuredContent` + `outputSchema` for every tool.** The MCP SDK (1.30) supports typed structured results. You already have the types in `types.ts` and zod available; declaring output schemas lets clients validate and render results, and lets you drop the pretty-printed JSON text (token savings, fixes part of #24).

**F2. `get_build_summary` with a curated PoB stat set.** Pick named `PlayerStat`s instead of `slice(0, 30)`: total/combined DPS, life, ES, mana, spirit, effective HP, max hit per damage type, all resistances with overcap, block/evade/suppress chances, movement speed. One compact answer to "how is my build doing?" — the question users will ask most.

**F3. `get_status` / diagnostics tool.** One call that reports: which data sources are configured and working, resolved Client.txt path and time since last line read, GGG token expiry, poe.ninja account and last fetch, active build origin and age, tree cache age, PoB builds dir. Most "it's not working" debugging becomes one tool call, and the AI can self-diagnose before giving wrong advice.

**F4. Cursor-based event polling.** Give each event a monotonic `seq` and add `get_events_since({ cursor })` returning `{ events, nextCursor }`. The PROTOCOL.md "AI polls get_recent_events" model currently re-reads the same events every poll; a cursor makes an agent loop cheap and exact. Pair with a `death_context` enrichment (area, area level, time in zone, recent level-ups) so "why did I die?" has something to work with.

**F5. `clear_active_build` + origin-aware active build** (the fix for #8, exposed as a feature). Also `list_saved_builds` if you keep more than one snapshot (e.g. keyed by character).

**F6. Passive-tree stats folded into defenses/offense.** You already resolve node stat lines; run them through the (fixed) mod parser and report `fromGear` / `fromTree` / `total` columns. Keep it clearly labeled as an approximation, but it closes a large part of the "gear-only" gap for GGG-API users.

### Tier 2 — high value, more effort

**F7. Headless PoB2 calculation for `compare_item`.** PoB ships a `HeadlessWrapper.lua`; running PoB2 under LuaJIT headless lets you load the build XML, swap in the candidate item, and read the real DPS/EHP delta. This turns `compare_item` from "affix diff" into the tool players actually want. Largest effort item here, but it's the biggest step up in usefulness, and it's all local/offline so it stays within your advisory-only boundary.

**F8. Structured trade whispers.** Parse the standard trade message format (`Hi, I would like to buy your X listed for N currency in League (stash tab "…"; position: left X, top Y)`) into `{ item, price, currency, league, stash, position }`, flagged `untrusted: true`. Enables advisory callouts like "buyer waiting for Tabula Rasa, 2 div" without ever touching the game.

**F9. Leveling & session analytics.** From `instance_created` (area level) + level-ups + zone timestamps: over/under-leveled warnings (XP penalty), time per zone/act, deaths per hour, map count per session. Persist to NDJSON or SQLite so `get_session_summary` survives CLI restarts (see F12).

**F10. `diff_builds`.** Compare two builds (two PoB imports, or PoB plan vs. live poe.ninja character): gear differences per slot, nodes allocated in one but not the other, gem/support differences. Great for "what am I missing vs. the guide build?"

**F11. Item Coach as the overlay consumer.** Replace the single overwritten `overlay-latest.json` with an append-only NDJSON queue (or a local WebSocket) that your Electron Item Coach overlay subscribes to, honoring `ttlMs` and `urgency`. The protocol already reserves the channel; this makes it real.

**F12. Optional long-running mode (Streamable HTTP transport).** Each CLI session currently spawns its own server over stdio, so the log buffer, caches, and session stats reset whenever you restart Claude Code/Codex. An opt-in `--http 127.0.0.1:PORT` mode (loopback only, token-protected) lets one tailer run all evening and serve multiple clients.

**F13. PoE2 game-data layer.** Pull base items, item classes, and mod tiers from a maintained community export (e.g. a RePoE-style PoE2 data dump). Fixes slot inference (#17) and local/global detection (#11) at the root, and enables "this is a T2 life roll" style answers.

### Tier 3 — nice to have

**F14. MCP prompts.** Ship prompt templates such as `review-my-build`, `why-did-i-die`, `should-i-buy-this-item` that chain the right tools. Claude Code exposes these as slash commands.

**F15. Economy context via poe.ninja.** Currency and unique-item price lookups (read-only, cached) so advice can include "this upgrade costs ~X exalts." Stick to poe.ninja's economy data rather than scraping the official trade site.

**F16. Client.txt localization.** A pattern table per client language (the game logs in the selected language), selected via env var or auto-detected from known lines.

**F17. Install & doctor UX.** `npx poe2-mcp-server init` that detects paths, writes the CLI config snippet for Claude Code/Codex/Antigravity, and runs the F3 diagnostics. Publish to npm once #29 is fixed.

**F18. Resources (optional).** Expose the active build and current session as MCP resources for clients that support them, without changing the pull-only default described in PROTOCOL.md.

**Not recommended:** implementing `memory-adapter.ts`. Everything above adds value without the ToS exposure the project was designed to avoid.

---

## Suggested order of work

1. **Correctness sprint** — #1, #2, #3, #8, #15 (one shared `slots.ts` + fallback/identity rework). Add tests using a real PoB2 export and a real GGG character JSON as fixtures.
2. **Log sprint** — #4, #6, #7, #20, #27 with a captured real Client.txt excerpt as a fixture (redact names).
3. **Security sprint** — #5, #14, #13 (rate limits, refresh lock), #21 (shared fetch helper).
4. **Parser accuracy** — #9, #10, #11, #12, #17, verified against in-game copies of ~10 real items.
5. **Features** — F3 → F1 → F2 → F4 → F5, then F7 as a larger project.
6. **Hygiene** — #28, #29, #30 alongside the above (CI first, so everything after it is tested on Windows too).
