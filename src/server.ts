import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import { log } from "./logger.js";

export { log };

const transports = new Map<string, StreamableHTTPServerTransport>();

export function getTransports(): Map<string, StreamableHTTPServerTransport> {
  return transports;
}

function createSessionServer(): McpServer {
  const server = new McpServer({ name: "bcs-mcp", version: "1.0.0" });
  registerTools(server);
  return server;
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  log(
    "http",
    `${req.method} /mcp`,
    sessionId ? `session=${sessionId.slice(0, 8)}...` : "no-session",
  );

  if (req.method === "POST") {
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res);
    } else if (!sessionId) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports.set(sid, transport);
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) transports.delete(sid);
      };
      const server = createSessionServer();
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } else {
      // Session ID provided but not found
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: Invalid session ID",
          },
          id: null,
        }),
      );
    }
  } else if (req.method === "GET") {
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res);
    } else {
      res.writeHead(400).end("Invalid or missing session ID");
    }
  } else if (req.method === "DELETE") {
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res);
    } else {
      res.writeHead(400).end("Invalid or missing session ID");
    }
  } else {
    res.writeHead(405).end("Method Not Allowed");
  }
}

export type McpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>;

export function createMcpHandler(): McpHandler {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    if (url.pathname === "/mcp") {
      await handleMcp(req, res);
    } else {
      res.writeHead(404).end("Not Found");
    }
  };
}
