// Live invokes the real login() from src/auth.ts. Run with:
//   npx tsx scripts/live-login-real.mts
import { config } from "dotenv";
import { unlink } from "node:fs/promises";

config({ path: ".env.local", override: true });
try { await unlink(".bcs-session"); } catch {}

const { login, getConfig } = await import("../src/auth.js");

console.log("calling login()...");
const cfg = getConfig();
console.log("  totpConfigured =", Boolean(cfg.BCS_TOTP_SECRET));
const result = await login(cfg);
console.log("SUCCESS:");
console.log("  sessionId =", result.sessionId.slice(0, 12) + "…");
console.log("  csrfToken =", result.csrfToken.slice(0, 12) + "…");
