import { z } from "zod";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseHtml } from "node-html-parser";
import { TOTP, Secret } from "otpauth";
import { log } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = resolve(__dirname, "..", ".bcs-session");
const SESSION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

const envSchema = z.object({
  BCS_URL: z.string().url(),
  BCS_USERNAME: z.string().min(1),
  BCS_PASSWORD: z.string().min(1),
  BCS_USER_OID: z.string().min(1),
  BCS_TOTP_SECRET: z.string().min(1).optional(),
});

export type BcsConfig = z.infer<typeof envSchema>;

interface SessionData {
  sessionId: string;
  csrfToken: string;
  timestamp: number;
}

let cachedSession: SessionData | null = null;

export function getConfig(): BcsConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid env vars: ${missing}`);
  }
  return result.data;
}

async function loadSession(): Promise<SessionData | null> {
  try {
    const raw = await readFile(SESSION_FILE, "utf-8");
    const data: unknown = JSON.parse(raw);
    if (
      typeof data === "object" &&
      data !== null &&
      "sessionId" in data &&
      "csrfToken" in data &&
      "timestamp" in data
    ) {
      const session = data as SessionData;
      if (Date.now() - session.timestamp < SESSION_MAX_AGE_MS) {
        return session;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function saveSession(session: SessionData): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(session), "utf-8");
}

async function invalidateSession(): Promise<void> {
  cachedSession = null;
  try {
    await unlink(SESSION_FILE);
  } catch {
    // file may not exist
  }
}

const TOTP_FIELD_CANDIDATES = [
  "totpVerificationCode",
  "otp",
  "token",
  "code",
  "pin",
  "tan",
  "twoFactorCode",
  "twofactor",
  "verificationCode",
  "mfaToken",
  "secondFactor",
  "pwd2",
];

interface LoginResult {
  sessionId: string;
  csrfToken: string;
}

interface TotpChallenge {
  fieldName: string;
  actionUrl: string;
  hiddenFields: Record<string, string>;
}

function parseSessionId(setCookies: string[]): string | null {
  return setCookies.join(";").match(/JSESSIONID=([^;]+)/)?.[1] ?? null;
}

function parseCsrfToken(setCookies: string[]): string | null {
  return setCookies.join(";").match(/CSRF_Token=([^;]+)/)?.[1] ?? null;
}

function detectTotpChallenge(
  html: string,
  baseUrl: string,
): TotpChallenge | null {
  const root = parseHtml(html);
  const forms = root.querySelectorAll("form");

  const stragglerHidden: Record<string, string> = {};
  for (const inp of root.querySelectorAll("input")) {
    const name = inp.getAttribute("name");
    if (!name) continue;
    const type = (inp.getAttribute("type") ?? "text").toLowerCase();
    if (type === "hidden") {
      stragglerHidden[name] = inp.getAttribute("value") ?? "";
    }
  }

  for (const form of forms) {
    const inputs = form.querySelectorAll("input");
    let totpField: string | null = null;
    const hidden: Record<string, string> = { ...stragglerHidden };
    for (const input of inputs) {
      const name = input.getAttribute("name");
      if (!name) continue;
      const type = (input.getAttribute("type") ?? "text").toLowerCase();
      if (type === "hidden") {
        hidden[name] = input.getAttribute("value") ?? "";
        continue;
      }
      if (!["text", "number", "tel", "password"].includes(type)) continue;
      const lower = name.toLowerCase();
      if (
        TOTP_FIELD_CANDIDATES.some((c) => c.toLowerCase() === lower) ||
        /otp|token|2fa|twofactor|mfa|verification/i.test(name)
      ) {
        totpField = name;
      }
    }
    for (const btn of form.querySelectorAll("button, input")) {
      const name = btn.getAttribute("name");
      const type = (btn.getAttribute("type") ?? "").toLowerCase();
      if (name === "login" && (type === "submit" || btn.tagName === "BUTTON")) {
        hidden["login"] = btn.getAttribute("value") ?? "true";
      }
    }
    if (totpField) {
      const action = form.getAttribute("action") ?? "/bcs/login";
      const actionUrl = action.startsWith("http")
        ? action
        : `${baseUrl}${action.startsWith("/") ? action : `/${action}`}`;
      return { fieldName: totpField, actionUrl, hiddenFields: hidden };
    }
  }
  return null;
}

function generateTotpCode(secret: string): string {
  const totp = new TOTP({
    secret: Secret.fromBase32(secret.replace(/\s+/g, "").toUpperCase()),
  });
  return totp.generate();
}

export async function login(config: BcsConfig): Promise<LoginResult> {
  log("auth", "Login attempt", {
    user: config.BCS_USERNAME,
    url: config.BCS_URL,
    totpConfigured: Boolean(config.BCS_TOTP_SECRET),
  });

  const preRes = await fetch(`${config.BCS_URL}/bcs/login`, {
    redirect: "manual",
  });
  const preCookies = preRes.headers.getSetCookie();
  const initialSessionId = parseSessionId(preCookies);
  if (!initialSessionId) {
    log("auth", "Login failed: no initial JSESSIONID");
    throw new Error("Login failed: no initial JSESSIONID from login page");
  }

  const preHtml = await preRes.text();
  const timestampMatch = /name="pagetimestamp"[^>]*value="([^"]+)"/.exec(
    preHtml,
  );
  const pagetimestamp = timestampMatch?.[1] ?? "";

  const body = new URLSearchParams({
    user: config.BCS_USERNAME,
    pwd: config.BCS_PASSWORD,
    isPassword: "pwd",
    login: "Anmelden",
    ...(pagetimestamp ? { pagetimestamp } : {}),
  });

  const response = await fetch(`${config.BCS_URL}/bcs/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `JSESSIONID=${initialSessionId}`,
    },
    body: body.toString(),
    redirect: "manual",
  });

  const setCookies = response.headers.getSetCookie();
  const sessionAfterPwd = parseSessionId(setCookies) ?? initialSessionId;
  const csrfAfterPwd = parseCsrfToken(setCookies);

  if (response.status === 302) {
    const location = response.headers.get("location") ?? "";
    if (location.includes("/login")) {
      log("auth", "Login failed: redirected back to login page");
      throw new Error("Login failed: redirected back to login page");
    }
  }

  const cookieHeader = `JSESSIONID=${sessionAfterPwd}${csrfAfterPwd ? `; CSRF_Token=${csrfAfterPwd}` : ""}`;
  const probeHeaders: Record<string, string> = { Cookie: cookieHeader };
  if (csrfAfterPwd) probeHeaders["X-CSRF-Token"] = csrfAfterPwd;

  const probeRes = await fetch(`${config.BCS_URL}/bcs`, {
    headers: probeHeaders,
    redirect: "manual",
  });
  const probeLocation = probeRes.headers.get("location") ?? "";
  const needs2fa = /totpVerification/i.test(probeLocation);

  if (!needs2fa) {
    if (!csrfAfterPwd) {
      log("auth", "Login failed: no CSRF_Token cookie");
      throw new Error(
        "Login failed: no CSRF_Token cookie (invalid credentials?)",
      );
    }
    log("auth", "Login successful (no 2FA)", {
      sessionId: sessionAfterPwd.slice(0, 8) + "...",
    });
    return { sessionId: sessionAfterPwd, csrfToken: csrfAfterPwd };
  }

  log("auth", "2FA required, fetching TOTP challenge", {
    redirect: probeLocation,
  });

  if (!config.BCS_TOTP_SECRET) {
    throw new Error(
      "BCS requires 2FA but BCS_TOTP_SECRET is not set in environment",
    );
  }

  const challengeUrl = probeLocation.startsWith("http")
    ? probeLocation
    : `${config.BCS_URL}${probeLocation.startsWith("/") ? probeLocation : `/${probeLocation}`}`;
  const challengeRes = await fetch(challengeUrl, {
    headers: probeHeaders,
    redirect: "manual",
  });
  const challengeHtml = await challengeRes.text();
  const challenge = detectTotpChallenge(challengeHtml, config.BCS_URL);
  if (!challenge) {
    throw new Error("Could not parse 2FA challenge form from BCS response");
  }

  log("auth", "2FA challenge parsed", {
    field: challenge.fieldName,
    action: challenge.actionUrl,
    hiddenFields: Object.keys(challenge.hiddenFields).join(","),
  });

  const code = generateTotpCode(config.BCS_TOTP_SECRET);
  log("auth", "TOTP code generated", { length: code.length });

  const totpBody = new URLSearchParams({
    ...challenge.hiddenFields,
    [challenge.fieldName]: code,
  });

  const totpRes = await fetch(challenge.actionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader,
      ...(csrfAfterPwd ? { "X-CSRF-Token": csrfAfterPwd } : {}),
    },
    body: totpBody.toString(),
    redirect: "manual",
  });

  const totpCookies = totpRes.headers.getSetCookie();
  const finalSessionId = parseSessionId(totpCookies) ?? sessionAfterPwd;
  const finalCsrf = parseCsrfToken(totpCookies) ?? csrfAfterPwd;
  const totpLocation = totpRes.headers.get("location") ?? "";

  if (
    totpLocation.includes("/login") ||
    /totpVerification/i.test(totpLocation)
  ) {
    log("auth", "2FA code rejected", { location: totpLocation });
    throw new Error("2FA code rejected by BCS");
  }

  if (!finalCsrf) {
    throw new Error("Login failed: no CSRF_Token after 2FA verification");
  }

  log("auth", "Login successful (2FA)", {
    sessionId: finalSessionId.slice(0, 8) + "...",
  });
  return { sessionId: finalSessionId, csrfToken: finalCsrf };
}

export async function getSession(): Promise<SessionData> {
  if (
    cachedSession &&
    Date.now() - cachedSession.timestamp < SESSION_MAX_AGE_MS
  ) {
    log("auth", "Session cache hit", {
      sessionId: cachedSession.sessionId.slice(0, 8) + "...",
      ageMinutes: Math.round((Date.now() - cachedSession.timestamp) / 60000),
    });
    return cachedSession;
  }

  const persisted = await loadSession();
  if (persisted) {
    log("auth", "Session restored from file", {
      sessionId: persisted.sessionId.slice(0, 8) + "...",
      ageMinutes: Math.round((Date.now() - persisted.timestamp) / 60000),
    });
    cachedSession = persisted;
    return persisted;
  }

  log("auth", "No valid session found, logging in");
  const config = getConfig();
  const { sessionId, csrfToken } = await login(config);
  const session: SessionData = { sessionId, csrfToken, timestamp: Date.now() };
  cachedSession = session;
  await saveSession(session);
  return session;
}

export async function refreshCsrfToken(): Promise<SessionData> {
  // CSRF token comes from login cookie — re-login to get a fresh one
  await invalidateSession();
  return getSession();
}

export async function authenticatedFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const session = await getSession();

  const makeRequest = (s: SessionData): Promise<Response> => {
    const headers = new Headers(options.headers);
    headers.set(
      "Cookie",
      `JSESSIONID=${s.sessionId}; CSRF_Token=${s.csrfToken}`,
    );
    headers.set("X-CSRF-Token", s.csrfToken);
    return fetch(url, { ...options, headers });
  };

  const response = await makeRequest(session);
  log("auth:fetch", `${options.method ?? "GET"} ${response.status}`, {
    url: url.replace(/\?.*/, "?..."),
    redirected: response.redirected,
    finalUrl: response.url.replace(/\?.*/, "?..."),
  });

  if (
    response.status === 401 ||
    response.status === 403 ||
    response.url.includes("/login")
  ) {
    log(
      "auth:fetch",
      "Session invalid (status or login redirect), re-authenticating",
    );
    await invalidateSession();
    const newSession = await getSession();
    const retryResponse = await makeRequest(newSession);
    log("auth:fetch", `Retry ${retryResponse.status}`, {
      redirected: retryResponse.redirected,
      finalUrl: retryResponse.url.replace(/\?.*/, "?..."),
    });
    if (retryResponse.url.includes("/login")) {
      throw new Error(
        "Authentication failed: redirected to login after re-authentication",
      );
    }
    return retryResponse;
  }

  return response;
}
