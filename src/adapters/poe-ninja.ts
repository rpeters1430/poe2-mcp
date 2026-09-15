import { decodePobCode, resolvePobXml } from "../build/pob-decode.js";
import { parsePobXml } from "../build/pob-parser.js";
import type { PobBuildSnapshot } from "../types.js";

export interface NinjaCharacterSummary {
  name: string;
  level: number;
  className: string | null;
  league: string;
  leagueUrl: string;
  isCurrent: boolean;
  updated: string;
}

export interface NinjaCharacterModelResponse {
  type: "found" | "notFetched" | "private";
  charModel?: {
    account: string;
    name: string;
    league: string;
    level: number;
    class: string;
    ascendancy?: string;
    pathOfBuildingExport?: string;
    defensiveStats?: Record<string, any>;
    skills?: any[];
    items?: any[];
    [key: string]: any;
  };
}

/**
 * Normalizes account names: 'rpeters1428#1042' -> 'rpeters1428-1042'
 */
export function normalizeAccountName(account: string): string {
  return account.trim().replace("#", "-");
}

export function parseNinjaProfileUrl(
  url: string
): { account: string; league: string; character: string } | null {
  const match = url.match(
    /(?:https?:\/\/)?(?:www\.)?poe\.ninja\/(?:poe2|poe1)\/profile\/([^\/]+)\/([^\/]+)\/character\/([^\/\?#]+)/i
  );
  if (!match) return null;
  return {
    account: match[1],
    league: match[2],
    character: match[3],
  };
}

export async function fetchNinjaCharacters(account: string): Promise<NinjaCharacterSummary[]> {
  const normalized = normalizeAccountName(account);
  const url = `https://poe.ninja/poe2/api/profile/characters/${encodeURIComponent(normalized)}/0`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "poe2-mcp-server/0.1.0" },
  });

  if (!resp.ok) {
    throw new Error(`poe.ninja returned HTTP ${resp.status} ${resp.statusText} for account ${account}`);
  }

  const list = (await resp.json()) as any[];
  return list.map((c) => ({
    name: c.name,
    level: c.level,
    className: c.className ?? null,
    league: c.league,
    leagueUrl: c.leagueUrl ?? c.league.toLowerCase().replace(/\s+/g, ""),
    isCurrent: Boolean(c.isCurrent),
    updated: c.updated,
  }));
}

export async function fetchNinjaCharacterModel(
  account: string,
  league: string,
  character: string
): Promise<NinjaCharacterModelResponse> {
  const normalized = normalizeAccountName(account);
  const leagueUrl = league.toLowerCase().replace(/\s+/g, "");
  const url = `https://poe.ninja/poe2/api/profile/characters/${encodeURIComponent(
    normalized
  )}/${encodeURIComponent(leagueUrl)}/${encodeURIComponent(character)}/model/0`;

  const resp = await fetch(url, {
    headers: { "User-Agent": "poe2-mcp-server/0.1.0" },
  });

  if (!resp.ok) {
    throw new Error(
      `poe.ninja returned HTTP ${resp.status} ${resp.statusText} for character ${character} (${account})`
    );
  }

  return (await resp.json()) as NinjaCharacterModelResponse;
}

export async function fetchNinjaAsPobBuild(
  account: string,
  league: string,
  character: string
): Promise<PobBuildSnapshot> {
  const res = await fetchNinjaCharacterModel(account, league, character);
  if (res.type !== "found" || !res.charModel) {
    throw new Error(
      `Character ${character} on account ${account} could not be loaded from poe.ninja (status: ${res.type}).`
    );
  }

  if (!res.charModel.pathOfBuildingExport) {
    throw new Error(
      `Character ${character} does not have a Path of Building export available on poe.ninja.`
    );
  }

  const xml = await resolvePobXml(res.charModel.pathOfBuildingExport);
  return { ...parsePobXml(xml), source: "poe_ninja" };
}
