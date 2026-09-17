import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClientLogTailer } from "../adapters/client-log.js";
import * as handlers from "../tools/handlers.js";
import type { GameEventType } from "../types.js";
import { broadcastClipboardItem } from "./ws.js";
import { saveLatestClipboardItem, getLatestClipboardItem } from "../adapters/clipboard-store.js";

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function sendError(res: ServerResponse, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 400, { error: message });
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Handles any request under /api/*. Returns true once handled (including
 * unknown-route 404s) so the caller in serve.ts knows not to fall through
 * to static file serving for anything under this prefix.
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
  log: ClientLogTailer
): Promise<boolean> {
  if (!pathname.startsWith("/api/")) return false;
  const method = req.method ?? "GET";
  const characterName = searchParams.get("characterName") ?? undefined;

  try {
    if (pathname === "/api/current-character" && method === "GET") {
      sendJson(res, 200, await handlers.getCurrentCharacter(log));
      return true;
    }

    if (pathname === "/api/active-character" && method === "POST") {
      const body = await readJsonBody(req);
      const name = String(body.characterName ?? "");
      if (!name) throw new Error("characterName is required");
      sendJson(res, 200, await handlers.setActiveCharacter(name));
      return true;
    }

    if (pathname === "/api/character-state" && method === "GET") {
      let name = characterName;
      if (!name) {
        try {
          name = await handlers.resolveCharacterName(undefined, log);
        } catch {}
      }
      sendJson(res, 200, await handlers.getCharacterState(name));
      return true;
    }

    if (pathname === "/api/character/refresh" && method === "POST") {
      let refreshResult = null;
      try {
        refreshResult = await handlers.refreshActiveBuildHandler();
      } catch {}
      let name = characterName;
      if (!name) {
        try {
          name = await handlers.resolveCharacterName(undefined, log);
        } catch {}
      }
      const charState = await handlers.getCharacterState(name);
      const defenses = await handlers.getDefenses(name, log);
      sendJson(res, 200, {
        refreshed: true,
        buildRefresh: refreshResult,
        character: charState,
        defenses,
      });
      return true;
    }

    if (pathname === "/api/active-build/pob" && method === "POST") {
      const body = await readJsonBody(req);
      const code = String(body.code ?? body.pobCodeOrXml ?? "");
      const filePath = typeof body.filePath === "string" ? body.filePath : undefined;
      if (!code && !filePath) throw new Error("PoB share code, XML, or filePath is required");
      const result = await handlers.importPobBuildHandler(filePath ?? code, Boolean(filePath));
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === "/api/active-build/poe-ninja" && method === "POST") {
      const body = await readJsonBody(req);
      const result = await handlers.importPoeNinjaCharacterHandler({
        profileUrl: typeof body.profileUrl === "string" ? body.profileUrl : undefined,
        accountName: typeof body.accountName === "string" ? body.accountName : undefined,
        characterName: typeof body.characterName === "string" ? body.characterName : undefined,
        league: typeof body.league === "string" ? body.league : undefined,
      });
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === "/api/active-build/refresh" && method === "POST") {
      const result = await handlers.refreshActiveBuildHandler();
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === "/api/inventory" && method === "GET") {
      sendJson(res, 200, await handlers.getInventory(characterName, log));
      return true;
    }

    if (pathname === "/api/defenses" && method === "GET") {
      sendJson(res, 200, await handlers.getDefenses(characterName, log));
      return true;
    }

    if (pathname === "/api/offense-stats" && method === "GET") {
      sendJson(res, 200, await handlers.getOffenseStats(characterName, log));
      return true;
    }

    if (pathname === "/api/passive-tree" && method === "GET") {
      sendJson(res, 200, await handlers.getPassiveTree(characterName, log));
      return true;
    }

    if (pathname === "/api/active-build-status" && method === "GET") {
      sendJson(res, 200, await handlers.getActiveBuildStatus());
      return true;
    }

    if ((pathname === "/api/status" || pathname === "/api/server-status") && method === "GET") {
      sendJson(res, 200, await handlers.getServerStatus(log));
      return true;
    }

    if (pathname === "/api/compare-item" && method === "POST") {
      const body = await readJsonBody(req);
      const itemText = typeof body.itemText === "string" ? body.itemText : undefined;
      const slot = typeof body.slot === "string" ? body.slot : undefined;
      const name = typeof body.characterName === "string" ? body.characterName : undefined;
      sendJson(res, 200, await handlers.compareItem(itemText, slot, name, log));
      return true;
    }

    if (pathname === "/api/trade/search" && method === "POST") {
      const body = await readJsonBody(req);
      sendJson(res, 200, await handlers.createTradeSearchHandler(body as any));
      return true;
    }

    if (pathname === "/api/recent-events" && method === "GET") {
      const sinceIso = searchParams.get("sinceIso") ?? undefined;
      const limitParam = searchParams.get("limit");
      const typesParam = searchParams.get("types");
      sendJson(
        res,
        200,
        handlers.getRecentEvents(log, {
          sinceIso,
          limit: limitParam ? Number(limitParam) : undefined,
          types: typesParam ? (typesParam.split(",") as GameEventType[]) : undefined,
        })
      );
      return true;
    }

    if (pathname === "/api/current-area" && method === "GET") {
      sendJson(res, 200, handlers.getCurrentArea(log));
      return true;
    }

    if (pathname === "/api/session-summary" && method === "GET") {
      sendJson(res, 200, handlers.getSessionSummary(log));
      return true;
    }

    if (pathname === "/api/clipboard-item" && method === "POST") {
      const body = await readJsonBody(req);
      const text = String(body.text ?? "");
      if (!text) throw new Error("text is required");
      const record = saveLatestClipboardItem(text);
      broadcastClipboardItem(text);
      sendJson(res, 200, {
        broadcast: true,
        copiedAt: record.copiedAt,
        itemName: record.parsed.name,
        baseType: record.parsed.baseType,
        rarity: record.parsed.rarity,
      });
      return true;
    }

    if (pathname === "/api/clipboard-item" && method === "GET") {
      const latest = getLatestClipboardItem();
      if (!latest) {
        sendJson(res, 200, { available: false });
        return true;
      }
      const diffMs = Date.now() - new Date(latest.copiedAt).getTime();
      sendJson(res, 200, {
        available: true,
        copiedAt: latest.copiedAt,
        secondsAgo: Math.max(0, Math.round(diffMs / 1000)),
        itemName: latest.parsed.name,
        baseType: latest.parsed.baseType,
        rarity: latest.parsed.rarity,
        text: latest.text,
        parsed: latest.parsed,
      });
      return true;
    }

    sendJson(res, 404, { error: `No such API route: ${method} ${pathname}` });
    return true;
  } catch (err) {
    sendError(res, err);
    return true;
  }
}
