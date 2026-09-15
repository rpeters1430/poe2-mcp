# poe2-mcp full project review

Reviewed: 2026-09-15  
Canonical review: this file supersedes `poe2-mcp-review.md` and `poe2_mcp_review.md`.

Reviewed runtime commit: `145270d43ae2f78bd2e6533e3ffcf82ae53132fd`; reconciled on `db00d32e3ff452b6374df1c799b66f84abb8e6c6` (`main`).
Scope: all tracked source, tests, configuration, examples, documentation, package contents, repository automation, and open repository items.

## Executive summary

The project has a promising architecture: adapters are separated from build calculations, MCP tool descriptions are unusually clear, the TypeScript build is strict, the dependency audit is clean, and the 37 existing unit tests pass. The passive-tree resolver also degrades sensibly when its remote dataset is unavailable.

At the reviewed baseline, the server was not yet safe or dependable enough to treat as a broadly installable MCP server. Its main blockers were:

1. MCP arguments can read arbitrary local files/directories and fetch arbitrary URLs.
2. PoB imports accept unbounded compressed/XML/network input and decompress synchronously.
3. Character fallbacks can silently return a different build labeled as the requested character.
4. The active-build cache never refreshes after its first successful load.
5. Renovate can automerge changes even though the repository has no CI workflow.

Recommendation: complete the P0 items before adding more data sources. Then fix the source-selection and freshness model in P1 before relying on advice produced by the server.

## Validation performed

- `npm ci`: passed.
- `npm run build`: passed with TypeScript strict mode.
- Tests: the original 37 passed; milestone one expanded the suite to 53 after review follow-ups, and milestone two now has 56 passing tests through the portable `npm test` command.
- `npm audit --json`: 0 known vulnerabilities across the installed dependency graph.
- `npm pack --dry-run`: milestone one builds a 124.7 kB tarball containing 96 files, including all source/tests/maps and both generated `dist` files; package trimming remains a P2 item.
- GitHub baseline: no project-owned `.github/workflows` files. Milestone one adds `.github/workflows/ci.yml`; branch protection remains a repository-setting follow-up.

The configured `npm test` command could not run in the review sandbox because the `tsx` CLI could not create its IPC pipe (`EPERM`). Running the same tests through Node's test runner and the `tsx` import hook passed. This is an environment/runner portability problem worth eliminating, not a failed product test.

## Reconciliation notes

This document was reconciled from all three reviews formerly in the repository. Findings were retained only when supported by the current code or clearly labeled as requiring a real PoE2 fixture. The short `poe2_mcp_review.md` was not treated as authoritative because it incorrectly claimed that the log was not tailed, OAuth tokens were not refreshed, malformed share codes lacked error handling, and `memory-adapter.ts` provided caching. The larger `poe2-mcp-review.md` contained useful additional findings that are incorporated below.

## Implementation status

| Item | Status |
|---|---|
| Restrict local PoB file reads to the configured Builds directory | Implemented in milestone-one PR |
| Remove generic URL imports and validate redirects | Implemented in milestone-one PR |
| Add PoB input/download/decompression limits | Implemented in milestone-one PR |
| Prevent explicit-character requests from using an unrelated active build | Implemented in milestone-one PR |
| Prevent chat/whispers from spoofing system events; hide raw events by default | Implemented in milestone-one PR |
| Normalize PoB/GGG slots and exclude swap/flask/charm slots from active totals | Implemented in milestone-one PR |
| Add build/test/audit/package CI on Node 20/22/24 | Implemented in milestone-one PR |
| Add active-build identity, provenance, mtime/TTL refresh, status/refresh/clear | Implemented in milestone-two PR |
| Correct poe.ninja source attribution and surface active-build age in derived results | Implemented in milestone-two PR |
| Stop reapplying local Armour/Evasion/ES modifiers to displayed item properties | Implemented in milestone-two PR; broader real-item fixtures remain |
| Add build-aware PoE2 trade search with budget/level filters, ranking, and official URL | Implemented in milestone-two PR; endpoint is explicitly marked undocumented |

## Priority definitions

| Priority | Meaning |
|---|---|
| P0 | Security, privacy, or release-integrity blocker; fix before distributing or enabling automatic updates. |
| P1 | High-impact correctness/reliability bug likely to return wrong or stale player information. |
| P2 | Important hardening, maintainability, packaging, or user-experience work. |
| P3 | Useful enhancement with lower immediate risk. |

## Ranked issues and bugs

The evidence in this ranked backlog records the reviewed baseline. Consult the
implementation-status table above for fixes already made by milestone one;
remaining acceptance criteria continue to describe the intended regression boundary.

### P0 — blockers

#### 1. Arbitrary local file reads and directory enumeration

**Historical baseline evidence:** `list_recent_pob_builds` accepted any `buildsPath`; `import_pob_build` accepted any `filePath`; and `resolvePobXml(code)` treated any existing string as a local path. Milestone one restricts listing/imports to the configured builds root, separates `filePath`, and reads through a validated no-follow file descriptor.

**Impact:** A prompt-injected or over-eager model can list an arbitrary directory's XML filenames and read any text file accessible to the server process. Even if non-XML content later fails parsing, its content has already crossed the MCP tool boundary and may appear in errors or model context. This violates least privilege for a server presented as a PoE2 data source.

**Fix:**

- Permit file access only beneath canonical, configured PoB build roots.
- Resolve both root and candidate with `realpath`, then reject path traversal and symlink escapes.
- Require `.xml`, a regular file, and a conservative byte-size limit.
- Remove path auto-detection from the `code` field; keep local files in a separate, clearly annotated argument/tool.
- If unrestricted paths are desired for development, require an explicit opt-in environment variable and disclose it in diagnostics.

**Acceptance criteria:** Attempts to read a sibling file, `../` path, symlink escape, device, or oversized file fail before any bytes are returned or parsed.

#### 2. Server-side request forgery through generic URL import

**Historical baseline evidence:** [`src/build/pob-decode.ts`](./src/build/pob-decode.ts) fetched arbitrary HTTP(S) URLs. Milestone one removes generic URL fetching and validates every redirect against an approved-host policy.

**Impact:** A model can make requests from the user's machine to loopback services, NAS/admin panels, RFC1918 addresses, or cloud metadata endpoints. Redirects can bypass a superficial initial-host check.

**Fix:** Remove generic URL fetching or use an explicit hostname allowlist (`pobb.in`, `pastebin.com`, `poe.ninja`). For every redirect, revalidate scheme, hostname, resolved IP, and port; reject credentials, localhost, link-local, multicast, private/reserved IP ranges, and nonstandard ports. Add download limits and timeouts.

**Acceptance criteria:** Direct and redirected requests to `127.0.0.1`, `::1`, private ranges, `169.254.169.254`, and user-info URLs are rejected.

#### 3. Unbounded synchronous PoB decompression and XML parsing

**Historical baseline evidence:** PoB decoding used unbounded synchronous decompression and whole-body downloads. Milestone one adds input, download, decompression, XML-size, timeout, redirect, and nesting limits.

**Impact:** A compressed bomb or very large remote/file/XML input can block the single Node event loop, exhaust memory, crash the MCP process, or make every tool unresponsive.

**Fix:** Enforce limits at every stage (argument bytes, file size, HTTP `Content-Length` plus streamed byte count, decompressed bytes, XML node/depth counts). Use asynchronous decompression with `maxOutputLength`, reject malformed/unexpected roots, and abort long operations.

**Acceptance criteria:** Oversized compressed, decompressed, downloaded, and XML inputs fail quickly with stable user-facing errors while the MCP server remains responsive.

#### 4. Dependency automerge has no CI safety gate

**Historical baseline evidence:** Renovate automerged eligible updates while the repository had no project-owned workflow. Milestone one adds build/test/audit/package validation on Node 20, 22, and 24; required branch protection must still be configured in GitHub.

**Impact:** A type-breaking, behavior-breaking, or compromised dependency update can merge without compiling or running tests. Pre-1.0 packages are excluded from one rule, but the broad configuration still lacks a required validation gate.

**Fix:** Add CI for supported Node versions that runs clean install, typecheck/build, tests, audit, and package smoke tests. Require those checks on `main`; use platform automerge only after all required checks succeed. Add Dependabot alerts/code scanning or equivalent supply-chain checks.

**Acceptance criteria:** Renovate cannot merge when build, tests, audit policy, or package smoke test fails.

### P1 — high impact

#### 5. Requested-character fallbacks can return another build under the requested name

**Historical baseline evidence:** Explicit character requests could fall back to an unrelated active build while relabeling it. Milestone one rejects that fallback; milestone two adds explicit build identity and provenance.

**Impact:** The server can confidently provide equipment/stats from character A labeled as character B. Advice based on the response may be wrong with no visible failure.

**Fix:** Give every build an identity envelope (`account`, `characterName`, `league`, `source`, `sourceUri/path`, `loadedAt`, `sourceModifiedAt`). Only fall back when identity matches the requested character, or when no character was requested and the response explicitly says it is the active build. Never relabel data with an override.

**Acceptance criteria:** Requesting an unavailable character returns an error or an explicitly unmatched candidate; it never returns another build labeled as the request.

#### 6. Active PoB data becomes permanently stale

**Historical baseline evidence:** The original active-build adapter returned `active-build.json` before checking its source and exposed no clear, refresh, or status tool. Milestone two stores provenance, refreshes file-backed records by mtime and poe.ninja records on a five-minute TTL, and adds all three controls.

**Impact:** Gear and analysis can remain stale across saves, character switches, leagues, and game sessions indefinitely.

**Fix:** Store metadata separately from the parsed snapshot. Distinguish `pinned` imports from `auto` selections; compare file mtime/hash or remote TTL before reuse; add `get_active_build_status`, `refresh_active_build`, and `clear_active_build`; surface age in every derived response.

**Acceptance criteria:** Saving a newer PoB file is reflected automatically within a documented interval, and users can inspect/refresh/clear the selected source.

#### 7. `get_inventory()` skips the active GGG character

**Evidence:** [`src/tools/register.ts`](./src/tools/register.ts) lines 153–162 only calls `fetchInventorySnapshot` when `characterName` is explicitly provided. With no argument it jumps directly to the active PoB/ninja build, unlike passives/defenses/offense, which resolve the active character.

**Impact:** The default inventory source is inconsistent and may be missing or stale even when an active GGG character is set and OAuth works.

**Fix:** Use one shared source-resolution function for all character/build tools: explicit character → configured active character → matching active build → clearly reported failure. Include source and fallback reasons.

**Acceptance criteria:** With a pinned active character and working OAuth, `get_inventory({})` fetches that character from GGG.

#### 8. Gear defense totals likely double-count local defensive modifiers

**Historical baseline evidence:** Defense aggregation reapplied local Armour/Evasion/ES affixes to already-modified displayed properties. Milestone two now trusts displayed item values and only adds flat ES from items with no displayed ES property; more real PoE2 fixtures are still required.

**Impact:** Armour, evasion, and energy shield can be materially overstated; item comparisons inherit the same error.

**Fix:** Define local versus global modifiers explicitly. Prefer displayed item properties as final per-item defenses and sum them without reapplying local mods. Only apply confirmed global modifiers to the correct scope. Add real copied-item fixtures for pure, hybrid, quality, and locally modified bases.

**Acceptance criteria:** Calculations match the sum of displayed equipped-item defenses for representative real PoE2 items and do not double-apply local modifiers.

#### 9. Client-log data exposes excessive raw/private content by default

**Historical baseline evidence:** Every unmatched line shared the normal event ring and the response exposed the absolute log path. Milestone one separates raw diagnostics, makes them opt-in, classifies chat as untrusted, and exposes only `logAvailable` by default.

**Impact:** Whisper/chat text, account/character names, local paths, or other log content can be sent to the connected model even when the user asked only for gameplay events.

**Fix:** Exclude `raw_unmatched` unless explicitly requested, return structured data without `raw` by default, redact known sensitive patterns, omit the absolute path unless diagnostics are requested, and add a privacy mode/configuration.

**Acceptance criteria:** Default event queries return only recognized, minimized fields; raw log access requires a separate explicit opt-in.

#### 10. Network calls have no timeout, response limit, retry policy, or runtime validation

**Evidence:** GGG, poe.ninja, pobb.in, Pastebin, generic import, OAuth, and tree-data calls use bare `fetch`. JSON responses are cast with TypeScript types/`any` rather than validated. See [`src/adapters/ggg-api.ts`](./src/adapters/ggg-api.ts), [`src/adapters/poe-ninja.ts`](./src/adapters/poe-ninja.ts), and [`src/build/pob-decode.ts`](./src/build/pob-decode.ts).

**Impact:** A stalled upstream can hang a tool indefinitely; changed/malformed responses can cause confusing errors or persist corrupt snapshots. Rate limits are reported but not scheduled/retried.

**Fix:** Centralize HTTP in a client with `AbortSignal.timeout`, maximum bytes, redirect policy, typed Zod validation, sanitized error excerpts, bounded exponential backoff for safe transient failures, and per-service rate-limit handling.

**Acceptance criteria:** Each upstream has a documented timeout/size policy and malformed responses never enter caches or state files.

#### 11. OAuth flow can hang/crash and refreshes can race

**Evidence:** [`src/adapters/ggg-oauth.ts`](./src/adapters/ggg-oauth.ts) has no listener `error` handler or authorization timeout; redirect port input is not validated; token JSON is trusted; concurrent callers can all refresh and overwrite rotating refresh tokens; 401 responses are not retried after a forced refresh.

**Impact:** Port conflicts or abandoned browser authorization can hang/crash auth. Parallel MCP calls near token expiry may invalidate stored credentials.

**Fix:** Validate port/scopes, add listener error/timeout/cleanup handling, validate token responses, serialize refresh with a shared promise/mutex, use atomic token writes, and allow one forced-refresh retry after a 401.

**Acceptance criteria:** EADDRINUSE, invalid port, timeout, malformed token response, parallel refresh, and revoked-token tests all produce deterministic outcomes without corrupting tokens.

#### 12. Log tailing can split partial lines and cannot recover from a missing startup path

**Evidence:** [`src/adapters/client-log.ts`](./src/adapters/client-log.ts) advances the byte offset to the last observed file size even if the appended chunk ends mid-line. `start()` returns permanently if the file is absent, and repeated `start()` calls create multiple intervals despite the comment saying it is safe once.

**Impact:** Events may be corrupted or missed during active writes, and starting the MCP server before the game prevents log discovery for the rest of the process.

**Fix:** Keep an incomplete-line byte buffer, preserve UTF-8 decoder state, make lifecycle idempotent, re-resolve/reopen missing or replaced files, and identify rotation by inode/file identity where available.

**Acceptance criteria:** Tests cover split lines, split multibyte characters, truncation, rotation, file deletion/recreation, delayed game startup, and repeated start/stop.

#### 13. poe.ninja imports are mislabeled as `pob_import`

**Historical baseline evidence:** poe.ninja imports inherited `pob_import` from the XML parser and conversion helpers hid the mismatch with `as any`. Milestone two assigns `poe_ninja` at the adapter boundary and carries it through the typed provenance envelope without casts.

**Impact:** Provenance, freshness expectations, and troubleshooting are wrong. The `as any` casts hide the type-model mismatch.

**Fix:** Separate parsed build content from source metadata or let the caller supply a validated provenance envelope. Remove these `as any` casts.

**Acceptance criteria:** Direct code/file, pobb.in, and poe.ninja imports report distinct, correct source metadata with source timestamps/locations.

#### 14. Advisory execution needs abuse controls and safer platform integrations

**Evidence:** `emit_advisory` can repeatedly invoke TTS/notifications and interpolates model-controlled text into AppleScript/PowerShell source. There is no cooldown, queue, acknowledgment, or opt-in per channel. See [`src/advisory/dispatch.ts`](./src/advisory/dispatch.ts) lines 35–60.

**Impact:** Prompt injection can spam or disrupt the desktop. Script construction creates avoidable command-injection risk on platforms where escaping semantics are subtle.

**Fix:** Disable active channels by default until opted in, add per-channel rate limits and deduplication, pass text as data/argv to fixed scripts rather than source interpolation, cap `reason`, strip control characters/newlines, and log decisions.

**Acceptance criteria:** Adversarial quotes/backslashes/newlines cannot alter executed code, and bursts are bounded by a documented policy.

### P2 — important hardening and maintainability

#### 15. Packaging is not release-safe

The declared bin files have no shebang, `dist/` is gitignored, there is no `prepack` build, and the package has no `files` allowlist. A fresh publish can omit usable build output unless the publisher remembers to build, Unix direct-bin execution may fail, and the current tarball includes sources, tests, maps, Renovate config, and AI instructions.

Add shebangs to both entrypoints, `prepack`, `files`, package metadata (`license`, `repository`, `bugs`, `homepage`), and a CI smoke test that installs the packed tarball into a clean directory and starts both bins.

#### 16. Test coverage misses the highest-risk code

The 37 tests cover calculation/parser units and tree-cache behavior. There are no tests for tool routing/fallbacks, active-build freshness, GGG/OAuth, poe.ninja response validation, Client.txt tailing, advisory dispatch, config/path security, package bins, or an actual MCP client/server round trip.

Refactor `register.ts` to inject adapters and a clock/filesystem/HTTP layer, then test each tool's source selection and failure semantics. Add coverage thresholds after high-risk modules are testable.

#### 17. Silent catches hide the real source of failures

Multiple handlers use `catch {}` and then return a different fallback error. This makes auth, network, API-schema, character-not-found, and parser failures indistinguishable.

Return a structured result containing `attempts: [{source, status, errorCode}]`, preserve the primary cause, and log sanitized diagnostic details.

#### 18. Invalid configuration is persisted as success

`set_account_name` writes before verification and writes again after verification fails. `set_active_character` accepts any name when neither GGG nor a configured poe.ninja account can validate it.

Validate first, or require an explicit `allowUnverified` option and return `verified: false`. Provide clear/update/remove configuration tools.

#### 19. State writes are non-atomic and inconsistently protected

Only `tokens.json` explicitly uses mode `0600`. Account, active-character, active-build, tree-cache, overlay, and advisory files use default modes; JSON replacements are non-atomic and concurrent processes can truncate/overwrite one another.

Use a platform-aware state directory, temp-file + fsync + rename, `0600` for private state, lock or compare-and-swap where concurrent instances matter, and runtime schema validation on reads.

#### 20. Tool outputs are JSON strings only

`jsonResult` puts JSON solely in a text content block. There are no `outputSchema` declarations or `structuredContent`, so clients cannot reliably consume typed results and schema regressions are not checked.

Add reusable Zod input/output schemas, return both concise text and structured content, and version any externally relied-on shapes.

#### 21. Hard-coded version strings can drift

`0.1.0` is repeated in package metadata, MCP server metadata, User-Agent strings, and remote adapter headers. Load one build-time version source and test it.

#### 22. Item parsing and slot matching need broader real-data fixtures

Mod regexes mostly accept integer/single-line English forms. Slot comparison is case-sensitive, ring/weapon-set semantics are ambiguous, and unrecognized properties/mods can materially affect comparisons. Build a sanitized corpus of real PoE2 clipboard, GGG API, and PoB2 items; report parser coverage (`recognizedMods/totalMods`) and confidence rather than presenting partial results without a score.

#### 23. Documentation has behavior mismatches

The README says auth opens a browser, but the implementation only prints a URL. The tool “Direction” column mixes data direction with mutability, and `player_message` exists in the enum but has no parser pattern. Documentation should also foreground the data-source/freshness hierarchy and privacy/security boundaries.

### P3 — cleanup

#### 24. `register.ts` is a 600+ line composition root

Split schemas/handlers by domain (account, build, log, advisory) and keep source-resolution policy in one tested service.

#### 25. Sync filesystem operations occur on MCP request paths

Large state, cache, directory, and build reads/writes block every tool. Move request-path I/O to `fs/promises` after input limits are added.

#### 26. The process and path auto-detection model is narrow

PoB process detection uses substring matching over `tasklist`/`ps -A`; path candidates omit several library/custom-folder cases. A `doctor` command with explicit discovery results is preferable to silently guessing.

### Additional reconciled findings

#### 27. PoB and GGG equipment slots need one canonical model — P1

PoB labels such as `Helmet`, `Body Armour`, `Ring 1`, and `Weapon 1` do not reliably match GGG-style labels such as `Helm`, `BodyArmour`, `Ring`, and `Weapon`. Exact string matching can fail to find/remove the equipped item during comparison and then add the candidate on top of the old item. Add a canonical slot enum and normalize at every adapter and tool boundary.

#### 28. Inactive weapon sets, flasks, and charms can pollute totals — P1

Defense aggregation loops over all equipment and offense accepts any slot beginning with `weapon`. Normalize slots, identify the active weapon set, and limit each calculation to slots that contribute to that calculation. Add separate weapon-set comparison when desired.

#### 29. Chat can spoof game events — P0

System regexes were matched against the entire line before chat was classified. A whisper ending in “has been slain” or containing “You have entered” could be interpreted as real state. Parse the log prefix and channel first, anchor system-message patterns, and mark all chat payloads as untrusted third-party text.

#### 30. Raw log noise can evict session history — P1

Recognized events and `raw_unmatched` lines share the same 500-entry ring, while session totals are recomputed from that ring. Keep raw diagnostics separate and opt-in; maintain session counters independently so debug noise cannot erase deaths/areas from the summary.

#### 31. PoE2 terminology and hybrid mods need fixtures — P1, verify against live data

The parser mainly recognizes “Critical Strike” wording, simple integer affixes, and single-stat lines. Verify real PoE2 forms such as “Critical Hit,” hybrid resistances/attributes, Spirit, maximum resistances, roll ranges, rune/implicit/crafted suffixes, and PoB `{tag}` prefixes. Normalize formatting before pattern matching and publish a recognition-confidence count.

#### 32. Elemental weapon properties may use a multi-value representation — P1, verify against live data

Offense looks for separate `Fire Damage`, `Cold Damage`, and `Lightning Damage` properties and `propertyRange` reads only the first value. Add sanitized GGG/clipboard fixtures and support the actual multi-value `Elemental Damage` representation if confirmed.

#### 33. PoB fallback invents unknown character fields — P1

Fallback conversion uses a class name as a character name and substitutes `level: 1`, `experience: 0`, and `hardcore: false` when values are unknown; parsed skill groups are dropped from the inventory shape. Model unknown values as nullable and preserve source identity/skills instead of manufacturing facts.

#### 34. Tool results are larger than necessary — P2

Full pretty-printed builds, duplicated passive hashes/resolutions, and an arbitrary `playerStats.slice(0, 30)` consume model context without guaranteeing the important stats are present. Return compact summaries by default, support explicit detail levels, and select PoB stats by stable names.

#### 35. Time filtering should compare instants, not strings — P2

`sinceIso` currently uses lexicographic comparison. Parse and compare epoch values so future acceptance of valid timezone offsets or different precision cannot silently break filtering.

#### 36. PoB process detection is fragile — P2

`ps -A` output can truncate or omit the full command name and Wine/Proton executable names differ. Use full command lines (`ps -eo args`) and normalized candidate names, while continuing to report detection as best-effort.

## Ranked feature roadmap

| Rank | Priority | Feature | Value | Key dependency |
|---:|:---:|---|---|---|
| 1 | P1 | `doctor` / `get_server_status` | One call shows server version, Node/platform, enabled sources, auth expiry, log/build paths (redacted), freshness, upstream reachability, and disabled capabilities. | Security-safe diagnostics and typed outputs. |
| 2 | P1 | Explicit source and freshness controls | Status/refresh/clear, provenance, mtime refresh, and remote TTL implemented; pin/unpin and configurable source preference/maximum age remain. | Fix findings 5–7 and 13. |
| 3 | P1 | Automatic PoB build watcher | Watch the selected XML safely, debounce saves, atomically reparse, retain last-known-good data, and emit a resource update. | Safe path policy and freshness metadata. |
| 4 | P1 | Build confidence/quality report | Every analysis reports source age, identity match, recognized mod ratio, unresolved passive count, missing skill data, and whether numbers are gear-only or PoB-computed. | Unified source model. |
| 5 | P2 | Unified `get_build_summary` | A compact model-friendly snapshot of identity, level/class, main skills, defenses, offense, key passives, and data limitations reduces tool round trips and contradictory source selection. | Typed outputs and unified resolver. |
| 6 | P2 | Full build-to-build comparison | Compare current vs saved/URL build, including equipment, gems, passives, PoB stats, gains/losses, and confidence—not only one item. | Stable PoB parsing and identity metadata. |
| 7 | P2 | Passive-tree recommendations | Use the existing GGG tree graph to show nearby notables/keystones, shortest paths, point cost, and raw stat changes, clearly separated from calculated DPS claims. | Cache the full graph and add stat normalization. |
| 8 | P2 | Safe price/economy lookup | Initial build-aware live item search implemented with league/budget/required-level filters, bounded ranking, rate-limit reporting, and official URL; currency exchange/history and a documented stable API remain. | Central HTTP policy; monitor the undocumented endpoint. |
| 9 | P2 | MCP resources and subscriptions | Expose stable resources such as active character/build and recent recognized events; notify clients when watched build/log state changes instead of requiring repeated polling. | MCP integration tests and privacy defaults. |
| 10 | P2 | Session analytics | Area time, deaths by area, level-up timeline, trade counts, and session export using recognized events only. | Correct partial-line/rotation handling. |
| 11 | P2 | Configuration CLI | `poe2-mcp init`, `doctor`, `auth status`, `config get/set/unset`, secure path picker, and client-config generation for Codex/Claude/Gemini. | Atomic validated state store. |
| 12 | P2 | Patch-aware game-data cache | Track dataset revision/ETag, invalidate after game patches, show stale/offline status, and retain last-known-good versions. | Central cache metadata. |
| 13 | P3 | Real overlay companion | A small opt-in overlay that acknowledges messages, honors TTL, deduplicates/rate-limits, and never sends game input. | Advisory hardening. |
| 14 | P3 | Sanitized diagnostic bundle | Export configuration shape, versions, recent structured errors, and parser coverage without tokens, full paths, raw chat, or build secrets. | Redaction framework. |
| 15 | P3 | Optional local HTTP transport | Useful for containers/remote clients only with loopback default, authentication, origin/host validation, TLS guidance, and an explicit threat model. | Finish all P0 security work first. |
| 16 | P2 | Headless PoB calculation | Load builds and calculate real item/build deltas through PoB's supported headless path instead of approximating DPS/EHP. | Secure process execution and real fixtures. |
| 17 | P2 | Structured trade whispers | Parse item, price, currency, league, stash, and position while preserving an `untrusted` marker. | Correct chat classification and privacy controls. |
| 18 | P2 | PoE2 game-data layer | Use a maintained data export for base types, slot classes, modifier tiers, and local/global semantics. | Source licensing, patch versioning, and cache validation. |
| 19 | P3 | MCP prompt templates | Provide `review-my-build`, `why-did-i-die`, and `should-i-buy-this-item` workflows that call the right tools. | Stable typed tool outputs. |
| 20 | P3 | Crafting-analysis integration | Add affix weights and crafting simulations only through an authorized/stable data source; do not scrape fragile pages. | Game-data layer and source terms review. |
| 21 | P3 | Container packaging | Provide a hardened container for non-log use or explicitly mounted game/build paths; document why local desktop integrations need extra configuration. | Release-safe npm packaging and least-privilege mounts. |

## Recommended implementation order

### Milestone 1 — secure the boundary

1. Restrict filesystem reads and remove/allowlist generic URL fetching.
2. Add input/download/decompression/XML limits and timeouts.
3. Add advisory opt-ins, escaping, and rate limits.
4. Add CI and block Renovate automerge on required checks.

### Milestone 2 — make returned data trustworthy

1. Introduce a single source/identity/freshness envelope. **Implemented for active builds.**
2. Fix wrong-character fallback, default inventory resolution, stale active builds, and poe.ninja provenance. **Implemented.**
3. Correct defense calculations against real fixtures. **Double-counting fixed; broader live fixtures remain.**
4. Make fallback attempts/errors explicit. **Active-build context is now included; a unified resolver trace remains.**

### Milestone 3 — harden operation and distribution

1. Centralize validated HTTP/OAuth/cache/state behavior.
2. Fix log tailing and privacy defaults.
3. Add MCP integration, adapter, auth, security, and package tests.
4. Make the npm package independently installable and smoke-tested.

### Milestone 4 — add player value

Start with `doctor`, active-build controls/watching, build confidence, and unified build summary. Then add build comparison, passive recommendations, and carefully vetted economy data.

## Definition of “ready for wider use”

- All P0 findings are closed with adversarial tests.
- Wrong-character and stale-build regressions have integration tests.
- Every response exposes source, identity, age, and limitations.
- Default log tools do not return raw/unmatched content.
- Clean-clone CI passes on every supported Node version.
- A packed tarball installs and both CLI bins run in a clean environment.
- Renovate automerge requires successful checks.
- The README documents permissions, privacy, threat model, source precedence, and recovery steps.
