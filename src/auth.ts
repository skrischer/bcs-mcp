import { z } from "zod";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";

const SESSION_FILE = resolve(process.cwd(), ".bcs-session");
const SESSION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

const envSchema = z.object({
  BCS_URL: z.string().url(),
  BCS_USERNAME: z.string().min(1),
  BCS_PASSWORD: z.string().min(1),
  BCS_USER_OID: z.string().min(1),
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

export async function login(config: BcsConfig): Promise<string> {
  const body = new URLSearchParams({
    username: config.BCS_USERNAME,
    password: config.BCS_PASSWORD,
    loginButton: "Anmelden",
  });

  const response = await fetch(`${config.BCS_URL}/bcs/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual",
  });

  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = /JSESSIONID=([^;]+)/.exec(setCookie);
  if (!match?.[1]) {
    throw new Error(
      `Login failed: no JSESSIONID in response (status ${response.status})`,
    );
  }

  return match[1];
}

export async function fetchCsrfToken(
  config: BcsConfig,
  sessionId: string,
): Promise<string> {
  const url = `${config.BCS_URL}/bcs/mybcs/dayeffortrecording/display?oid=${config.BCS_USER_OID}`;
  const response = await fetch(url, {
    headers: { Cookie: `JSESSIONID=${sessionId}` },
    redirect: "manual",
  });

  const html = await response.text();
  const match = /<meta\s+name="PageKey"\s+content="([^"]+)"/.exec(html);
  if (!match?.[1]) {
    throw new Error("CSRF token not found in page HTML");
  }

  return match[1];
}

export async function getSession(): Promise<SessionData> {
  if (
    cachedSession &&
    Date.now() - cachedSession.timestamp < SESSION_MAX_AGE_MS
  ) {
    return cachedSession;
  }

  const persisted = await loadSession();
  if (persisted) {
    cachedSession = persisted;
    return persisted;
  }

  const config = getConfig();
  const sessionId = await login(config);
  const csrfToken = await fetchCsrfToken(config, sessionId);
  const session: SessionData = { sessionId, csrfToken, timestamp: Date.now() };
  cachedSession = session;
  await saveSession(session);
  return session;
}

export async function refreshCsrfToken(): Promise<SessionData> {
  const config = getConfig();
  const current = await getSession();
  const csrfToken = await fetchCsrfToken(config, current.sessionId);
  const session: SessionData = {
    sessionId: current.sessionId,
    csrfToken,
    timestamp: Date.now(),
  };
  cachedSession = session;
  await saveSession(session);
  return session;
}

export async function authenticatedFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const session = await getSession();

  const makeRequest = (s: SessionData): Promise<Response> => {
    const headers = new Headers(options.headers);
    headers.set("Cookie", `JSESSIONID=${s.sessionId}`);
    headers.set("X-CSRF-Token", s.csrfToken);
    return fetch(url, { ...options, headers });
  };

  const response = await makeRequest(session);

  if (response.status === 401 || response.status === 403) {
    await invalidateSession();
    const newSession = await getSession();
    return makeRequest(newSession);
  }

  return response;
}
