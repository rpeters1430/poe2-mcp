import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ClientLogTailer } from "./adapters/client-log.js";
import { registerTools } from "./tools/register.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";

async function main() {
  const server = new McpServer(
    {
      name: "poe2-mcp-server",
      version: "0.1.0",
    },
    { instructions: SERVER_INSTRUCTIONS }
  );

  const log = new ClientLogTailer();
  log.start();

  registerTools(server, log);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `[poe2-mcp-server] running. Client.txt: ${log.getLogPath() ?? "NOT FOUND (set POE2_CLIENT_LOG_PATH)"}`
  );

  const shutdown = () => {
    log.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
  process.stdin.on("end", shutdown);
  process.stdout.on("error", (err: any) => {
    if (err?.code === "EPIPE") {
      shutdown();
    }
  });
}

main().catch((err) => {
  console.error("[poe2-mcp-server] fatal:", err);
  process.exit(1);
});
