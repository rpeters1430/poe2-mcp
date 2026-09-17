import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { isWebTokenValid } from "./auth.js";

// Push channel from the desktop clipboard watcher (src/clipboard-watcher.ts,
// via POST /api/clipboard-item) to connected browser tabs. This is a
// human-facing UI convenience only -- it never reaches the AI's MCP
// session, which stays pull-only per PROTOCOL.md's "Interaction model".

const wss = new WebSocketServer({ noServer: true });
const clients = new Set<WebSocket>();

wss.on("connection", (socket: WebSocket) => {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
});

export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  if (!isWebTokenValid(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
}

export function broadcastClipboardItem(text: string): void {
  const payload = JSON.stringify({
    type: "clipboard_item",
    text,
    detectedAt: new Date().toISOString(),
  });
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

export function broadcastAdvisory(action: unknown): void {
  const payload = JSON.stringify({
    type: "advisory",
    action,
    dispatchedAt: new Date().toISOString(),
  });
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

