import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const server = new McpServer({
  name: "bcs-mcp",
  version: "1.0.0",
});

registerTools(server);

const transport = new StdioServerTransport();

async function main(): Promise<void> {
  await server.connect(transport);
  console.error("[bcs-mcp] Server started on stdio");
}

function shutdown(): void {
  console.error("[bcs-mcp] Shutting down...");
  server.close().then(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err: unknown) => {
  console.error("[bcs-mcp] Fatal error:", err);
  process.exit(1);
});
