// Probes the BCS login flow once with active 2FA on the account.
// Dumps the HTML body of the password-POST response to bcs-2fa-challenge.html
// so we can inspect the real form-field names if the auth.ts heuristic misses.
//
// Usage: BCS_USERNAME / BCS_PASSWORD / BCS_URL must be set in .env.local.
//   node scripts/probe-2fa.mjs

import { writeFile } from "node:fs/promises";
import { config } from "dotenv";

config({ path: ".env.local", override: true });

const url = process.env.BCS_URL;
const user = process.env.BCS_USERNAME;
const pwd = process.env.BCS_PASSWORD;

if (!url || !user || !pwd) {
  console.error("[FAIL] missing BCS_URL / BCS_USERNAME / BCS_PASSWORD");
  process.exit(1);
}

console.log(`[1/2] GET ${url}/bcs/login`);
const preRes = await fetch(`${url}/bcs/login`, { redirect: "manual" });
const preCookies = preRes.headers.getSetCookie();
const initialSessionId = preCookies.join(";").match(/JSESSIONID=([^;]+)/)?.[1];
if (!initialSessionId) {
  console.error("[FAIL] no initial JSESSIONID");
  process.exit(2);
}
const preHtml = await preRes.text();
const pagetimestamp =
  /name="pagetimestamp"[^>]*value="([^"]+)"/.exec(preHtml)?.[1] ?? "";

console.log(`[2/2] POST ${url}/bcs/login`);
const body = new URLSearchParams({
  user,
  pwd,
  isPassword: "pwd",
  login: "Anmelden",
  ...(pagetimestamp ? { pagetimestamp } : {}),
});
const loginRes = await fetch(`${url}/bcs/login`, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: `JSESSIONID=${initialSessionId}`,
  },
  body: body.toString(),
  redirect: "manual",
});

const setCookies = loginRes.headers.getSetCookie();
const html = await loginRes.text();
const csrf = setCookies.join(";").match(/CSRF_Token=([^;]+)/)?.[1];

const outFile = "bcs-2fa-challenge.html";
await writeFile(outFile, html, "utf-8");

console.log("");
console.log(`status:        ${loginRes.status}`);
console.log(`location:      ${loginRes.headers.get("location") ?? "(none)"}`);
console.log(`set-cookie:    ${setCookies.length} cookie(s)`);
console.log(`CSRF_Token:    ${csrf ? "present (no 2FA)" : "MISSING (2FA likely required)"}`);
console.log(`response body: ${html.length} bytes -> ${outFile}`);
console.log("");

if (csrf) {
  console.log("[OK] login succeeded without 2FA — nothing more to probe.");
  process.exit(0);
}

const inputs = [
  ...html.matchAll(/<input[^>]*name="([^"]+)"[^>]*type="([^"]+)"[^>]*>/gi),
  ...html.matchAll(/<input[^>]*type="([^"]+)"[^>]*name="([^"]+)"[^>]*>/gi),
];
console.log("Form inputs found in challenge HTML:");
for (const m of inputs) {
  console.log(`  - name=${m[1] ?? m[2]} type=${m[2] ?? m[1]}`);
}
console.log("");
console.log(`Inspect ${outFile} to confirm the OTP field name and form action.`);
