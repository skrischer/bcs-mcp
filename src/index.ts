import "dotenv/config";
import { createServer } from "node:http";
import { createMcpHandler, getTransports } from "./server.js";

const handler = createMcpHandler();
const port = parseInt(process.env.PORT ?? "3000", 10);

const httpServer = createServer(async (req, res) => {
  await handler(req, res);
});

httpServer.listen(port, () => {
  console.error(`[bcs-mcp] Listening on http://localhost:${port}`);
});

function shutdown(): void {
  console.error("[bcs-mcp] Shutting down...");
  const transports = getTransports();
  for (const [sid, transport] of transports) {
    transport.close().catch(() => {});
    transports.delete(sid);
  }
  httpServer.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
