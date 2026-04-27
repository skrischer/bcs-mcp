import "dotenv/config";
import { initLogFile, closeLogFile, log, setStdioMode } from "./logger.js";

const useStdio = process.argv.includes("--stdio");

if (useStdio) {
  const { StdioServerTransport } =
    await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { createSessionServer } = await import("./server.js");

  setStdioMode();
  initLogFile();

  const server = createSessionServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("server", "stdio transport connected");

  function shutdown(): void {
    log("server", "Shutting down...");
    transport.close().catch(() => {});
    closeLogFile();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else {
  const { createServer } = await import("node:http");
  const { createMcpHandler, getTransports } = await import("./server.js");

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
}
