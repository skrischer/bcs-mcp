import "dotenv/config";
import { createServer } from "node:http";
import { createMcpHandler, getTransports } from "./server.js";
import { initLogFile, closeLogFile, log } from "./logger.js";

initLogFile();

const handler = createMcpHandler();
const port = parseInt(process.env.PORT ?? "3000", 10);

const httpServer = createServer(async (req, res) => {
  await handler(req, res);
});

httpServer.listen(port, () => {
  log("server", `Listening on http://localhost:${port}`);
});

function shutdown(): void {
  log("server", "Shutting down...");
  const transports = getTransports();
  for (const [sid, transport] of transports) {
    transport.close().catch(() => {});
    transports.delete(sid);
  }
  closeLogFile();
  httpServer.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
