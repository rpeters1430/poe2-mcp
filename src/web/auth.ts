import type { IncomingMessage, ServerResponse } from "node:http";

// Optional shared-secret gate for the network-facing /api, /ws, and /mcp
// routes in src/serve.ts. This server holds GGG OAuth-token-backed data and
// can trigger desktop notifications/TTS, so anything reachable over the LAN
// should be gated once POE2_WEB_TOKEN is set -- see PROTOCOL.md and
// CLAUDE.md for why this is opt-in rather than mandatory (a bare `npm run
// serve` on localhost still works with no setup).

function expectedToken(): string | null {
  return process.env.POE2_WEB_TOKEN?.trim() || null;
}

function providedToken(req: IncomingMessage): string | null {
  const header = req.headers["x-poe2-token"];
  if (typeof header === "string" && header) return header;
  if (Array.isArray(header) && header[0]) return header[0];
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    return url.searchParams.get("token");
  } catch {
    return null;
  }
}

/** Returns true if the request is authorized. Writes a 401 and returns false otherwise. */
export function checkWebToken(req: IncomingMessage, res: ServerResponse): boolean {
  const expected = expectedToken();
  if (!expected) return true;
  if (providedToken(req) === expected) return true;
  res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "Unauthorized: missing or incorrect token (POE2_WEB_TOKEN is set)." }));
  return false;
}

/** Same check for the pre-upgrade websocket handshake, which has no response body to write to on reject. */
export function isWebTokenValid(req: IncomingMessage): boolean {
  const expected = expectedToken();
  if (!expected) return true;
  return providedToken(req) === expected;
}
