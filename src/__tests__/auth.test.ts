import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TOTP, Secret } from "otpauth";
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

const TEST_TOTP_SECRET = "JBSWY3DPEHPK3PXP";

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

function makeProbeNoTotpResponse(): Response {
  return new Response("<html><body>BCS dashboard</body></html>", {
    status: 200,
  });
}

function makeProbeRedirectToTotp(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: "/bcs/totpVerification" },
  });
}

function makeTotpChallengePageResponse(): Response {
  const html = `
    <html><body>
      <form method="post" action="/bcs/totpVerification/*/display?is_Ajax_Login=false">
        <input type="text" name="totpVerificationCode" autocomplete="off">
        <input type="hidden" name="!totpTrustBrowser" value="true">
        <input type="checkbox" name="totpTrustBrowser" value="true">
        <button type="submit" name="login" value="true">Anmelden</button>
      </form>
      <input type="hidden" name="pagetimestamp" value="999888">
    </body></html>
  `;
  return new Response(html, { status: 200 });
}

function makeTotpSuccessResponse(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: "/bcs" },
  });
}

function makeTotpRejectedResponse(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: "/bcs/totpVerification" },
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
    it("extracts JSESSIONID and CSRF_Token from login response (no 2FA)", async () => {
      const mockFetch = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(makeLoginPageResponse())
        .mockResolvedValueOnce(makeLoginSuccessResponse())
        .mockResolvedValueOnce(makeProbeNoTotpResponse());
      vi.stubGlobal("fetch", mockFetch);

      const result = await login(mockConfig);
      expect(result.sessionId).toBe("abc123");
      expect(result.csrfToken).toBe("csrftoken456");

      expect(mockFetch).toHaveBeenCalledTimes(3);
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
        )
        .mockResolvedValueOnce(makeProbeNoTotpResponse());
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

    it("submits TOTP code when probe redirects to /totpVerification", async () => {
      const mockFetch = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(makeLoginPageResponse())
        .mockResolvedValueOnce(makeLoginSuccessResponse())
        .mockResolvedValueOnce(makeProbeRedirectToTotp())
        .mockResolvedValueOnce(makeTotpChallengePageResponse())
        .mockResolvedValueOnce(makeTotpSuccessResponse());
      vi.stubGlobal("fetch", mockFetch);

      const result = await login({
        ...mockConfig,
        BCS_TOTP_SECRET: TEST_TOTP_SECRET,
      });

      expect(result.sessionId).toBe("abc123");
      expect(result.csrfToken).toBe("csrftoken456");
      expect(mockFetch).toHaveBeenCalledTimes(5);

      const totpCall = mockFetch.mock.calls[4];
      expect(totpCall).toBeDefined();
      const totpUrl = totpCall![0] as string;
      expect(totpUrl).toContain("/bcs/totpVerification/");

      const totpInit = totpCall![1] as RequestInit;
      const params = new URLSearchParams(totpInit.body as string);
      const expectedCode = new TOTP({
        secret: Secret.fromBase32(TEST_TOTP_SECRET),
      }).generate();
      expect(params.get("totpVerificationCode")).toBe(expectedCode);
      expect(params.get("pagetimestamp")).toBe("999888");
      expect(params.get("login")).toBe("true");

      const cookieHeader = (totpInit.headers as Record<string, string>)[
        "Cookie"
      ];
      expect(cookieHeader).toContain("JSESSIONID=abc123");
      expect(cookieHeader).toContain("CSRF_Token=csrftoken456");
    });

    it("throws when 2FA is required but BCS_TOTP_SECRET is not set", async () => {
      const mockFetch = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(makeLoginPageResponse())
        .mockResolvedValueOnce(makeLoginSuccessResponse())
        .mockResolvedValueOnce(makeProbeRedirectToTotp());
      vi.stubGlobal("fetch", mockFetch);

      await expect(login(mockConfig)).rejects.toThrow(
        /BCS requires 2FA but BCS_TOTP_SECRET is not set/,
      );
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("throws when BCS rejects the TOTP code", async () => {
      const mockFetch = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(makeLoginPageResponse())
        .mockResolvedValueOnce(makeLoginSuccessResponse())
        .mockResolvedValueOnce(makeProbeRedirectToTotp())
        .mockResolvedValueOnce(makeTotpChallengePageResponse())
        .mockResolvedValueOnce(makeTotpRejectedResponse());
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        login({ ...mockConfig, BCS_TOTP_SECRET: TEST_TOTP_SECRET }),
      ).rejects.toThrow("2FA code rejected by BCS");
    });
  });
});
