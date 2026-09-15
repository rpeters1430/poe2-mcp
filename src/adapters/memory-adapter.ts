/**
 * Optional, OFF BY DEFAULT adapter for reading live process state (current
 * HP/ES/mana, position, nearby entities) directly from the running PoE2
 * process, rather than the two safer sources above (official API, log file).
 *
 * Deliberately NOT implemented here. Three reasons:
 *
 * 1. ToS risk is real and it's the sharpest edge of this whole project.
 *    Reading (not even writing) a live game's process memory to build
 *    external tooling sits squarely in the territory GGG's ToS and most
 *    anti-cheat policies are written to prohibit, on the account you
 *    actually play on. The official API and the log file cover a
 *    surprising amount of what you listed (stats, inventory, recent
 *    events) without that risk -- start there and only reach for this if
 *    you decide, with eyes open, that you need live HP/positional data
 *    badly enough to accept the risk.
 *
 * 2. There's no official structure to read. Unlike the log file or the
 *    API, GGG publishes no memory layout, so a real implementation means
 *    reverse-engineering live struct offsets for a shipping multiplayer
 *    game -- offsets that break on every patch. That's a meaningfully
 *    different (and more invasive) undertaking than the rest of this
 *    project, and not something to hand you as working code without you
 *    explicitly deciding you want it.
 *
 * 3. It's genuinely fragile even setting risk aside: offsets, obfuscation,
 *    and anti-cheat heuristics change patch to patch, so it needs ongoing
 *    maintenance most log/API-based tooling doesn't.
 *
 * If you still want this after weighing that, the shape to build is an
 * adapter implementing GameStateAdapter below, backed by a
 * process-memory-reading library (e.g. reading /proc/<pid>/mem on Linux, or
 * ReadProcessMemory on Windows) plus a community-sourced offset map for the
 * current patch -- kept as a swappable module so the rest of the server
 * (tools, advisory dispatch) doesn't need to change.
 */

export interface LiveGameState {
  hp: { current: number; max: number };
  energyShield: { current: number; max: number };
  mana: { current: number; max: number };
  position: { x: number; y: number } | null;
  nearbyEntityCount: number | null;
}

export interface GameStateAdapter {
  isAvailable(): boolean;
  getLiveState(): Promise<LiveGameState | null>;
}

export class UnimplementedMemoryAdapter implements GameStateAdapter {
  isAvailable(): boolean {
    return false;
  }
  async getLiveState(): Promise<LiveGameState | null> {
    return null;
  }
}
