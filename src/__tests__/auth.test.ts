import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { login, fetchCsrfToken, getConfig } from "../auth.js";
import type { BcsConfig } from "../auth.js";

const mockConfig: BcsConfig = {
  BCS_URL: "https://bcs.example.com",
  BCS_USERNAME: "testuser",
  BCS_PASSWORD: "testpass",
  BCS_USER_OID: "OID123",
};

describe("auth", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("getConfig", () => {
    it("throws on missing env vars", () => {
      const original = { ...process.env };
      delete process.env["BCS_URL"];
      delete process.env["BCS_USERNAME"];
      delete process.env["BCS_PASSWORD"];
      delete process.env["BCS_USER_OID"];

      expect(() => getConfig()).toThrow("Missing or invalid env vars");

      Object.assign(process.env, original);
    });

    it("returns config when env vars are set", () => {
      process.env["BCS_URL"] = mockConfig.BCS_URL;
      process.env["BCS_USERNAME"] = mockConfig.BCS_USERNAME;
      process.env["BCS_PASSWORD"] = mockConfig.BCS_PASSWORD;
      process.env["BCS_USER_OID"] = mockConfig.BCS_USER_OID;

      const config = getConfig();
      expect(config.BCS_URL).toBe(mockConfig.BCS_URL);
      expect(config.BCS_USERNAME).toBe(mockConfig.BCS_USERNAME);
    });
  });

  describe("login", () => {
    it("extracts JSESSIONID from Set-Cookie header", async () => {
      const mockFetch = vi
        .fn<
          (
            input: string | URL | Request,
            init?: RequestInit,
          ) => Promise<Response>
        >()
        .mockResolvedValue(
          new Response(null, {
            status: 302,
            headers: { "set-cookie": "JSESSIONID=abc123; Path=/; HttpOnly" },
          }),
        );
      vi.stubGlobal("fetch", mockFetch);

      const sessionId = await login(mockConfig);
      expect(sessionId).toBe("abc123");

      expect(mockFetch).toHaveBeenCalledWith(
        `${mockConfig.BCS_URL}/bcs/login`,
        expect.objectContaining({
          method: "POST",
          redirect: "manual",
        }),
      );
    });

    it("throws when no JSESSIONID in response", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn<
            (
              input: string | URL | Request,
              init?: RequestInit,
            ) => Promise<Response>
          >()
          .mockResolvedValue(new Response(null, { status: 302, headers: {} })),
      );

      await expect(login(mockConfig)).rejects.toThrow("no JSESSIONID");
    });
  });

  describe("fetchCsrfToken", () => {
    it("extracts CSRF token from page HTML", async () => {
      const html = `
        <html>
        <head>
          <meta name="PageKey" content="csrf-token-xyz">
        </head>
        <body></body>
        </html>
      `;
      vi.stubGlobal(
        "fetch",
        vi
          .fn<
            (
              input: string | URL | Request,
              init?: RequestInit,
            ) => Promise<Response>
          >()
          .mockResolvedValue(new Response(html, { status: 200 })),
      );

      const token = await fetchCsrfToken(mockConfig, "session123");
      expect(token).toBe("csrf-token-xyz");
    });

    it("throws when no PageKey meta tag found", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn<
            (
              input: string | URL | Request,
              init?: RequestInit,
            ) => Promise<Response>
          >()
          .mockResolvedValue(
            new Response("<html><body></body></html>", { status: 200 }),
          ),
      );

      await expect(fetchCsrfToken(mockConfig, "session123")).rejects.toThrow(
        "CSRF token not found",
      );
    });
  });
});
