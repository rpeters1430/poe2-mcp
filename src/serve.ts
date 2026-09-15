import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ClientLogTailer } from "./adapters/client-log.js";
import { registerTools } from "./tools/register.js";
import { handleApi } from "./web/api.js";
import { handleUpgrade } from "./web/ws.js";
import { checkWebToken } from "./web/auth.js";

// Network-reachable counterpart to index.ts's stdio-only entrypoint -- see
// PROTOCOL.md and README.md's "Remote access" section for why this exists
// (running the game + this server on a desktop, reached from a laptop over
// the LAN) and what it does and doesn't expose. index.ts is untouched and
// still the right choice for a purely local Claude Code/Codex subprocess.

const PORT = Number(process.env.POE2_SERVE_PORT ?? 8787);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.normalize(path.join(PUBLIC_DIR, relative));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(400).end("Bad path");
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    const contentType = CONTENT_TYPES[path.extname(resolved)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType }).end(data);
  });
}

async function main() {
  const server = new McpServer({ name: "poe2-mcp-server", version: "0.1.0" });
  const log = new ClientLogTailer();
  log.start();
  registerTools(server, log);

  const mcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(mcpTransport);

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/mcp") {
      if (!checkWebToken(req, res)) return;
      mcpTransport.handleRequest(req, res);
      return;
    }

    if (pathname.startsWith("/api/")) {
      if (!checkWebToken(req, res)) return;
      handleApi(req, res, pathname, url.searchParams, log);
      return;
    }

    serveStatic(req, res, pathname);
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    handleUpgrade(req, socket, head);
  });

  httpServer.listen(PORT, () => {
    console.error(
      `[poe2-mcp-server] serve mode listening on :${PORT} -- MCP at /mcp, dashboard at /, Client.txt: ${
        log.getLogPath() ?? "NOT FOUND (set POE2_CLIENT_LOG_PATH)"
      }`
    );
    if (!process.env.POE2_WEB_TOKEN) {
      console.error(
        "[poe2-mcp-server] POE2_WEB_TOKEN is not set -- /api, /ws, and /mcp are reachable to anything on your network with no auth."
      );
    }
  });

  const shutdown = () => {
    log.stop();
    httpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[poe2-mcp-server] fatal:", err);
  process.exit(1);
});
