import { z } from "zod";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = resolve(__dirname, "..", ".bcs-session");
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

interface LoginResult {
  sessionId: string;
  csrfToken: string;
}

export async function login(config: BcsConfig): Promise<LoginResult> {
  // Step 1: GET login page for initial JSESSIONID + pagetimestamp
  const preRes = await fetch(`${config.BCS_URL}/bcs/login`, {
    redirect: "manual",
  });
  const preCookies = preRes.headers.getSetCookie();
  const preSessionMatch = preCookies.join(";").match(/JSESSIONID=([^;]+)/);
  const initialSessionId = preSessionMatch?.[1];
  if (!initialSessionId) {
    throw new Error("Login failed: no initial JSESSIONID from login page");
  }

  const preHtml = await preRes.text();
  const timestampMatch = /name="pagetimestamp"[^>]*value="([^"]+)"/.exec(
    preHtml,
  );
  const pagetimestamp = timestampMatch?.[1] ?? "";

  // Step 2: POST login with correct field names
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
  const cookieStr = setCookies.join(";");

  // Extract JSESSIONID (new or keep initial)
  const newSessionMatch = cookieStr.match(/JSESSIONID=([^;]+)/);
  const sessionId = newSessionMatch?.[1] ?? initialSessionId;

  // Extract CSRF_Token cookie (set by BCS on successful login)
  const csrfMatch = cookieStr.match(/CSRF_Token=([^;]+)/);
  if (!csrfMatch?.[1]) {
    throw new Error(
      "Login failed: no CSRF_Token cookie (invalid credentials?)",
    );
  }

  // Verify login succeeded: 302 redirect to non-login page
  if (response.status === 302) {
    const location = response.headers.get("location") ?? "";
    if (location.includes("/login")) {
      throw new Error("Login failed: redirected back to login page");
    }
  }

  return { sessionId, csrfToken: csrfMatch[1] };
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

  if (response.status === 401 || response.status === 403) {
    await invalidateSession();
    const newSession = await getSession();
    return makeRequest(newSession);
  }

  return response;
}
