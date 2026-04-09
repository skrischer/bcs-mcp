import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { login, getConfig } from "../auth.js";
import type { BcsConfig } from "../auth.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const mockConfig: BcsConfig = {
  BCS_URL: "https://bcs.example.com",
  BCS_USERNAME: "testuser",
  BCS_PASSWORD: "testpass",
  BCS_USER_OID: "OID123",
};

function makeLoginPageResponse(): Response {
  const html = '<input name="pagetimestamp" type="hidden" value="123456">';
  return new Response(html, {
    status: 200,
    headers: {
      "set-cookie": "JSESSIONID=initial123; Path=/; HttpOnly",
    },
  });
}

function makeLoginSuccessResponse(): Response {
  return new Response(null, {
    status: 302,
    headers: [
      ["set-cookie", "JSESSIONID=abc123; Path=/; HttpOnly; SameSite=Lax"],
      ["set-cookie", "CSRF_Token=csrftoken456; Path=/; SameSite=Lax"],
      ["location", "/bcs"],
    ],
  });
}

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
    it("extracts JSESSIONID and CSRF_Token from login response", async () => {
      const mockFetch = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(makeLoginPageResponse())
        .mockResolvedValueOnce(makeLoginSuccessResponse());
      vi.stubGlobal("fetch", mockFetch);

      const result = await login(mockConfig);
      expect(result.sessionId).toBe("abc123");
      expect(result.csrfToken).toBe("csrftoken456");

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("throws when no initial JSESSIONID from login page", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn<FetchFn>()
          .mockResolvedValue(new Response("", { status: 200, headers: {} })),
      );

      await expect(login(mockConfig)).rejects.toThrow("no initial JSESSIONID");
    });

    it("throws when no CSRF_Token cookie in login response", async () => {
      const mockFetch = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(makeLoginPageResponse())
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: {
              "set-cookie": "JSESSIONID=abc123; Path=/",
              location: "/bcs",
            },
          }),
        );
      vi.stubGlobal("fetch", mockFetch);

      await expect(login(mockConfig)).rejects.toThrow("no CSRF_Token cookie");
    });

    it("throws when redirected back to login page", async () => {
      const mockFetch = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(makeLoginPageResponse())
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: [
              ["set-cookie", "JSESSIONID=abc123; Path=/"],
              ["set-cookie", "CSRF_Token=tok; Path=/"],
              ["location", "/bcs/login"],
            ],
          }),
        );
      vi.stubGlobal("fetch", mockFetch);

      await expect(login(mockConfig)).rejects.toThrow(
        "redirected back to login",
      );
    });
  });
});
