import fs from "node:fs";
import path from "node:path";
import { configDir, resolveAccountName } from "../config.js";
import type { ActiveCharacterState } from "../types.js";
import { listCharacterNames } from "./ggg-api.js";
import type { ClientLogTailer } from "./client-log.js";
import { loadActiveBuildRecord } from "./active-build.js";
import { fetchNinjaCharacters } from "./poe-ninja.js";

/**
 * Which character other tools (get_passive_tree, get_defenses,
 * get_offense_stats, compare_item) default to when `characterName` is
 * omitted. Mirrors config.ts's "explicit override, else best-effort
 * auto-detect" pattern used for Client.txt path resolution: an explicit
 * `set_active_character` call always wins; failing that, this makes one
 * best-effort inference pass over the log and clearly labels the result as
 * inferred rather than confirmed.
 */

interface StoredState {
  name: string;
  setAt: string;
}

function stateFilePath(): string {
  return path.join(configDir(), "active-character.json");
}

function loadStored(): StoredState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(), "utf8")) as StoredState;
  } catch {
    return null;
  }
}

export function setActiveCharacter(name: string): ActiveCharacterState {
  const stored: StoredState = { name, setAt: new Date().toISOString() };
  fs.writeFileSync(stateFilePath(), JSON.stringify(stored, null, 2));
  return { name, source: "explicit", setAt: stored.setAt };
}

/**
 * Death/level_up log lines carry a `character` field. If it exactly matches
 * exactly one name on the account, that's a strong signal it's the player's
 * own character (solo instances rarely log other players' deaths/level-ups).
 * Returns null rather than guessing when nothing in the recent log matches.
 */
function inferFromLog(log: ClientLogTailer, knownNames: string[]): string | null {
  const events = log.getRecentEvents({ limit: 500 });
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "death" && event.type !== "level_up") continue;
    const character = event.data.character;
    if (typeof character === "string" && knownNames.includes(character)) {
      return character;
    }
  }
  return null;
}

export async function getActiveCharacter(log: ClientLogTailer): Promise<ActiveCharacterState> {
  const stored = loadStored();
  if (stored) {
    return { name: stored.name, source: "explicit", setAt: stored.setAt };
  }

  // Fall back to active build record if available
  const activeBuild = loadActiveBuildRecord();
  if (activeBuild?.identity.characterName) {
    return {
      name: activeBuild.identity.characterName,
      source: "active_build",
      setAt: activeBuild.refreshedAt,
      message: `Using active character "${activeBuild.identity.characterName}" from ${activeBuild.origin} build.`,
    };
  }

  let knownNames: string[];
  try {
    knownNames = await listCharacterNames();
  } catch (err) {
    const account = resolveAccountName();
    if (account) {
      try {
        const ninjaChars = await fetchNinjaCharacters(account);
        const current = ninjaChars.find((c) => c.isCurrent) ?? ninjaChars[0];
        if (current) {
          return {
            name: current.name,
            source: "inferred_from_poe_ninja",
            setAt: current.updated,
            message: `Inferred active character "${current.name}" (${current.league}) from poe.ninja.`,
          };
        }
      } catch {}
    }

    return {
      name: null,
      source: "none",
      setAt: null,
      message: `No active character set, and could not list account characters to infer one (${
        err instanceof Error ? err.message : String(err)
      }). Call set_active_character explicitly.`,
    };
  }

  const inferred = inferFromLog(log, knownNames);
  if (inferred) {
    return {
      name: inferred,
      source: "inferred_from_log",
      setAt: null,
      message:
        "Inferred from a recent death/level_up log line matching one of this account's character names -- not " +
        "confirmed. Call set_active_character to pin it explicitly if this is wrong.",
    };
  }

  return {
    name: null,
    source: "none",
    setAt: null,
    message:
      "No active character set and none could be inferred from recent log events. Call " +
      "set_active_character(characterName), or pass characterName explicitly to other tools.",
  };
}
