# Path of Exile 2 MCP Server - Codebase Review & Roadmap

## 1. Architectural Issues & Potential Bugs

### 🚨 Critical Importance
*   **Client Log Memory Leak & Pathing (`src/adapters/client-log.ts`)**
    *   *Problem:* The `Client.txt` file grows indefinitely. Reading it synchronously or without tailing will cause severe memory spikes. Additionally, hardcoded Windows paths will fail for users running the game through compatibility layers on other operating systems, where the virtual filesystem drastically changes the log location.
    *   *Fix:* Implement a streaming file watcher (`fs.watch`) that maintains an offset pointer. Add robust path resolution that accounts for variable install locations across different operating environments.
*   **GGG OAuth Token Expiration (`src/adapters/ggg-oauth.ts`)**
    *   *Problem:* GGG API tokens have short lifespans. Without automated refresh logic or interceptors for `401 Unauthorized` responses, the MCP tools will silently fail during extended sessions.
    *   *Fix:* Implement an interceptor to automatically attempt a token refresh and retry the failed request.

### 🟡 Medium Importance
*   **Malformed PoB Code Handling (`src/build/pob-decode.ts`)**
    *   *Problem:* Path of Building strings are base64-encoded, zlib-compressed XML. Invalid clipboards or rate-limited URL fetches can crash the inflation step.
    *   *Fix:* Wrap the inflation and decoding in strict try/catch blocks and return localized errors to the LLM so it can prompt for a fresh export code.
*   **Mod Parser Edge Cases (`src/build/mod-parser.ts`)**
    *   *Problem:* New hybrid mods and conditional modifiers break traditional regex parsing.
    *   *Fix:* Transition to tokenized parsing using datamined stat dictionaries as the primary source of truth.

---

## 2. Recommended New Features

### ⭐ High Priority
*   **Craft of Exile Integration**
    *   *Description:* Add a dedicated adapter for Craft of Exile to allow the LLM to calculate affix weights, simulate crafting outcomes, and provide step-by-step crafting advice for items parsed in `item-properties.ts`.
    *   *Why:* Deepens utility beyond pricing, tapping into complex crafting and currency optimization.
*   **Live Trade API Item Evaluation**
    *   *Description:* While `poe-ninja.ts` handles the macro economy, adding direct GGG Trade API integration to construct queries for rare items based on parsed `item-properties.ts` is essential for accurate price checks.

### 🌟 Medium Priority
*   **Containerized Deployment Options**
    *   *Description:* Add a `Dockerfile` and `docker-compose.yml` to the repository.
    *   *Why:* Streamlines deployment for users who run self-hosted environments or local reverse proxies, keeping the execution environment isolated and dependencies clean.
*   **Interactive Build Modification (PoB Round-Tripping)**
    *   *Description:* Enhance `pob-parser.ts` to inject an item from the clipboard into the parsed XML, recalculate deltas, and output a new PoB code.
    *   *Why:* Enables true "AI build coaching" by allowing the assistant to test gear upgrades on the fly.

---

## 3. General Codebase Improvements
*   **Testing Coverage:** The presence of `.test.ts` files (like `mod-parser.test.ts` and `tree-data.test.ts`) is excellent. Expand these to heavily mock external API responses for `ggg-api.ts`.
*   **Persistent Caching Strategy:** `memory-adapter.ts` handles in-memory caching, but datamined Tree Data (`tree-data.ts`) and economy overviews should leverage persistent local caching to bypass rate limits on server restart.
