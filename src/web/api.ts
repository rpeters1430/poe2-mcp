import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClientLogTailer } from "../adapters/client-log.js";
import * as handlers from "../tools/handlers.js";
import type { GameEventType } from "../types.js";
import { broadcastClipboardItem } from "./ws.js";

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
      const name = await handlers.resolveCharacterName(characterName, log);
      sendJson(res, 200, await handlers.getCharacterState(name));
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

    if (pathname === "/api/compare-item" && method === "POST") {
      const body = await readJsonBody(req);
      const itemText = String(body.itemText ?? "");
      if (!itemText) throw new Error("itemText is required");
      const slot = typeof body.slot === "string" ? body.slot : undefined;
      const name = typeof body.characterName === "string" ? body.characterName : undefined;
      sendJson(res, 200, await handlers.compareItem(itemText, slot, name, log));
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
      broadcastClipboardItem(text);
      sendJson(res, 200, { broadcast: true });
      return true;
    }

    sendJson(res, 404, { error: `No such API route: ${method} ${pathname}` });
    return true;
  } catch (err) {
    sendError(res, err);
    return true;
  }
}
