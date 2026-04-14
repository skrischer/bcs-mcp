import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

// We test the HTTP server behavior directly with raw fetch requests
// to verify session management, routing, and error handling.

// Import the server factory (to be implemented)
import { createMcpHandler, getTransports } from "../server.js";

let httpServer: Server;
let baseUrl: string;

function jsonRpcRequest(
  method: string,
  id: number,
  params?: Record<string, unknown>,
) {
  return {
    jsonrpc: "2.0" as const,
    method,
    id,
    ...(params && { params }),
  };
}

function initializeRequest(id = 0) {
  return jsonRpcRequest("initialize", id, {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  });
}

interface McpResponse {
  status: number;
  sessionId: string | null;
  body: Record<string, unknown> | null;
  raw: Response;
}

function parseSseMessages(text: string): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const block of text.split("\n\n")) {
    const dataLine = block
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (dataLine) {
      messages.push(JSON.parse(dataLine.slice(6)));
    }
  }
  return messages;
}

async function postMcp(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<McpResponse> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });

  const contentType = res.headers.get("content-type") ?? "";
  let parsed: Record<string, unknown> | null = null;

  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const messages = parseSseMessages(text);
    // The last message with a result is the JSON-RPC response
    parsed =
      (messages.find((m) => "result" in m || "error" in m) as Record<
        string,
        unknown
      >) ?? null;
  } else if (contentType.includes("application/json")) {
    parsed = await res.json();
  }

  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    body: parsed,
    raw: res,
  };
}

async function initSession(): Promise<string> {
  const res = await postMcp(initializeRequest());
  if (!res.sessionId) throw new Error("No session ID returned");

  // Send initialized notification
  await postMcp(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { "mcp-session-id": res.sessionId },
  );

  return res.sessionId;
}

beforeAll(async () => {
  const handler = createMcpHandler();
  httpServer = createServer(async (req, res) => {
    await handler(req, res);
  });
  httpServer.listen(0);
  await once(httpServer, "listening");
  const addr = httpServer.address();
  if (typeof addr === "object" && addr) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterEach(() => {
  // Clean up any remaining transports between tests
  const transports = getTransports();
  for (const [sid, transport] of transports) {
    transport.close().catch(() => {});
    transports.delete(sid);
  }
});

afterAll(async () => {
  httpServer.close();
});

describe("HTTP MCP Server", () => {
  it("should return 404 for non-/mcp paths", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(404);

    const res2 = await fetch(`${baseUrl}/health`);
    expect(res2.status).toBe(404);
  });

  it("should create a session on initialize request", async () => {
    const res = await postMcp(initializeRequest());

    expect(res.status).toBe(200);
    expect(res.sessionId).toBeTruthy();
    expect(res.body).toBeDefined();

    const result = (res.body as Record<string, unknown>).result as Record<
      string,
      unknown
    >;
    expect(result).toBeDefined();
    expect((result.serverInfo as Record<string, unknown>).name).toBe("bcs-mcp");
  });

  it("should route requests with session ID to existing transport", async () => {
    const sessionId = await initSession();

    const res = await postMcp(jsonRpcRequest("tools/list", 1), {
      "mcp-session-id": sessionId,
    });

    expect(res.status).toBe(200);
    const result = (res.body as Record<string, unknown>).result as Record<
      string,
      unknown
    >;
    const tools = result.tools as { name: string }[];
    expect(tools).toBeDefined();
    expect(tools.length).toBe(6);

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("bcs_get_week_summary");
    expect(toolNames).toContain("bcs_book_effort");
  });

  it("should reject non-initialize requests without session ID", async () => {
    const res = await postMcp(jsonRpcRequest("tools/list", 1));

    expect(res.status).toBe(400);
  });

  it("should reject requests with unknown session ID", async () => {
    const res = await postMcp(jsonRpcRequest("tools/list", 1), {
      "mcp-session-id": "nonexistent-session-id",
    });

    expect(res.status).toBe(404);
  });

  it("should terminate session on DELETE", async () => {
    const sessionId = await initSession();

    // DELETE the session
    const deleteRes = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId },
    });
    expect(deleteRes.status).toBe(200);

    // Subsequent request with old session should fail
    const res = await postMcp(jsonRpcRequest("tools/list", 1), {
      "mcp-session-id": sessionId,
    });
    expect(res.status).toBe(404);
  });

  it("should support multiple concurrent sessions", async () => {
    const sessionA = await initSession();
    const sessionB = await initSession();

    expect(sessionA).not.toBe(sessionB);

    const [resA, resB] = await Promise.all([
      postMcp(jsonRpcRequest("tools/list", 1), {
        "mcp-session-id": sessionA,
      }),
      postMcp(jsonRpcRequest("tools/list", 2), {
        "mcp-session-id": sessionB,
      }),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const resultA = (resA.body as Record<string, unknown>).result as Record<
      string,
      unknown
    >;
    const resultB = (resB.body as Record<string, unknown>).result as Record<
      string,
      unknown
    >;
    expect((resultA.tools as unknown[]).length).toBe(6);
    expect((resultB.tools as unknown[]).length).toBe(6);
  });

  it("should return 405 for unsupported HTTP methods", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "PUT" });
    expect(res.status).toBe(405);
  });
});
