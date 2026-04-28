// End-to-end login probe that mirrors src/auth.ts login() including the TOTP
// step. Uses BCS_* env vars from .env.local and reports each phase.

import { config } from "dotenv";
import { parse as parseHtml } from "node-html-parser";
import { TOTP, Secret } from "otpauth";

config({ path: ".env.local", override: true });

const url = process.env.BCS_URL;
const user = process.env.BCS_USERNAME;
const pwd = process.env.BCS_PASSWORD;
const totpSecret = process.env.BCS_TOTP_SECRET;

if (!url || !user || !pwd) {
  console.error("[FAIL] missing BCS_URL / BCS_USERNAME / BCS_PASSWORD");
  process.exit(1);
}

const TOTP_FIELD_CANDIDATES = [
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

function parseSessionId(setCookies) {
  return setCookies.join(";").match(/JSESSIONID=([^;]+)/)?.[1] ?? null;
}
function parseCsrfToken(setCookies) {
  return setCookies.join(";").match(/CSRF_Token=([^;]+)/)?.[1] ?? null;
}

function detectTotpChallenge(html, baseUrl) {
  const root = parseHtml(html);
  const forms = root.querySelectorAll("form");

  // BCS sometimes places <input name="pagetimestamp"> outside the form, at the
  // bottom of <body>. Capture it so we can include it in the POST.
  const stragglerHidden = {};
  for (const inp of root.querySelectorAll("input")) {
    const name = inp.getAttribute("name");
    if (!name) continue;
    const type = (inp.getAttribute("type") ?? "text").toLowerCase();
    if (type === "hidden") stragglerHidden[name] = inp.getAttribute("value") ?? "";
  }

  for (const form of forms) {
    const inputs = form.querySelectorAll("input");
    let totpField = null;
    const hidden = { ...stragglerHidden };
    for (const input of inputs) {
      const name = input.getAttribute("name");
      if (!name) continue;
      const type = (input.getAttribute("type") ?? "text").toLowerCase();
      if (type === "hidden") {
        hidden[name] = input.getAttribute("value") ?? "";
        continue;
      }
      // Only text-like inputs are valid OTP code fields.
      if (!["text", "number", "tel", "password"].includes(type)) continue;
      const lower = name.toLowerCase();
      if (
        TOTP_FIELD_CANDIDATES.some((c) => c.toLowerCase() === lower) ||
        /otp|token|2fa|twofactor|mfa|verification|verificationcode/i.test(name)
      ) {
        totpField = name;
      }
    }
    // Honour the "Anmelden" submit button — BCS expects login=true on this form.
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

console.log(`[1/5] GET ${url}/bcs/login`);
const preRes = await fetch(`${url}/bcs/login`, { redirect: "manual" });
console.log(`      status=${preRes.status}`);
const initialSessionId = parseSessionId(preRes.headers.getSetCookie());
if (!initialSessionId) {
  console.error("[FAIL] no initial JSESSIONID");
  process.exit(2);
}
const preHtml = await preRes.text();
const pagetimestamp =
  /name="pagetimestamp"[^>]*value="([^"]+)"/.exec(preHtml)?.[1] ?? "";
console.log(`      JSESSIONID=${initialSessionId.slice(0, 12)}…  pagetimestamp=${pagetimestamp || "(none)"}`);

console.log(`[2/5] POST ${url}/bcs/login (user=${user})`);
const pwdBody = new URLSearchParams({
  user,
  pwd,
  isPassword: "pwd",
  login: "Anmelden",
  ...(pagetimestamp ? { pagetimestamp } : {}),
});
const pwdRes = await fetch(`${url}/bcs/login`, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: `JSESSIONID=${initialSessionId}`,
  },
  body: pwdBody.toString(),
  redirect: "manual",
});
console.log(`      status=${pwdRes.status}  location=${pwdRes.headers.get("location") ?? "(none)"}`);

const pwdCookies = pwdRes.headers.getSetCookie();
const sessionAfterPwd = parseSessionId(pwdCookies) ?? initialSessionId;
const csrfAfterPwd = parseCsrfToken(pwdCookies);
console.log(`      JSESSIONID=${sessionAfterPwd.slice(0, 12)}…  CSRF_Token=${csrfAfterPwd ? csrfAfterPwd.slice(0, 12) + "…" : "(missing)"}`);

let finalSessionId;
let finalCsrf;

if (csrfAfterPwd) {
  console.log(`[3/5] no 2FA challenge — login completed in one step`);
  finalSessionId = sessionAfterPwd;
  finalCsrf = csrfAfterPwd;
} else {
  console.log(`[3/5] CSRF_Token missing — looking for 2FA challenge`);
  const html = await pwdRes.text();
  const challenge = detectTotpChallenge(html, url);
  if (!challenge) {
    console.error("[FAIL] no 2FA challenge form detected — credentials invalid?");
    console.error(`      response body: ${html.length} bytes`);
    process.exit(3);
  }
  console.log(`      challenge field=${challenge.fieldName}  action=${challenge.actionUrl}`);
  console.log(`      hidden fields: ${Object.keys(challenge.hiddenFields).join(", ") || "(none)"}`);

  if (!totpSecret) {
    console.error("[FAIL] BCS_TOTP_SECRET not set");
    process.exit(4);
  }

  const code = new TOTP({
    secret: Secret.fromBase32(totpSecret.replace(/\s+/g, "").toUpperCase()),
  }).generate();
  console.log(`[4/5] POST ${challenge.actionUrl} with TOTP code (${code.length} digits)`);

  const totpBody = new URLSearchParams({
    ...challenge.hiddenFields,
    [challenge.fieldName]: code,
  });
  const totpRes = await fetch(challenge.actionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `JSESSIONID=${sessionAfterPwd}`,
    },
    body: totpBody.toString(),
    redirect: "manual",
  });
  console.log(`      status=${totpRes.status}  location=${totpRes.headers.get("location") ?? "(none)"}`);
  const totpCookies = totpRes.headers.getSetCookie();
  finalSessionId = parseSessionId(totpCookies) ?? sessionAfterPwd;
  finalCsrf = parseCsrfToken(totpCookies);
  console.log(`      JSESSIONID=${finalSessionId.slice(0, 12)}…  CSRF_Token=${finalCsrf ? finalCsrf.slice(0, 12) + "…" : "(missing)"}`);

  if (!finalCsrf) {
    console.error("[FAIL] 2FA code rejected by BCS");
    process.exit(5);
  }
}

console.log(`[5/7] sanity GET ${url}/bcs with established session`);
const sanityRes = await fetch(`${url}/bcs`, {
  headers: {
    Cookie: `JSESSIONID=${finalSessionId}; CSRF_Token=${finalCsrf}`,
    "X-CSRF-Token": finalCsrf,
  },
  redirect: "manual",
});
const sanityLoc = sanityRes.headers.get("location") ?? "(no redirect)";
console.log(`      status=${sanityRes.status}  location=${sanityLoc}`);

if (sanityLoc.includes("/totpVerification") || sanityLoc.includes("totp")) {
  const totpUrl = sanityLoc.startsWith("http")
    ? sanityLoc
    : `${url}${sanityLoc.startsWith("/") ? sanityLoc : "/" + sanityLoc}`;
  console.log(`[6/7] GET ${totpUrl}  (fetching TOTP challenge page)`);
  const challengeRes = await fetch(totpUrl, {
    headers: {
      Cookie: `JSESSIONID=${finalSessionId}; CSRF_Token=${finalCsrf}`,
      "X-CSRF-Token": finalCsrf,
    },
    redirect: "manual",
  });
  console.log(`      status=${challengeRes.status}`);
  const challengeHtml = await challengeRes.text();
  const challengeOut = "bcs-2fa-challenge.html";
  await (await import("node:fs/promises")).writeFile(
    challengeOut,
    challengeHtml,
    "utf-8",
  );
  console.log(`      HTML dumped (${challengeHtml.length} bytes) → ${challengeOut}`);

  const detected = detectTotpChallenge(challengeHtml, url);
  if (!detected) {
    console.error("[FAIL] could not detect TOTP form on /totpVerification");

    // Show all input names so we can adjust candidate list.
    const root = parseHtml(challengeHtml);
    const inputs = root.querySelectorAll("input");
    console.error("      inputs found in HTML:");
    for (const inp of inputs) {
      console.error(
        `        name=${inp.getAttribute("name")} type=${inp.getAttribute("type")}`,
      );
    }
    process.exit(7);
  }
  console.log(`      detected field=${detected.fieldName}  action=${detected.actionUrl}`);
  console.log(`      hidden fields: ${Object.keys(detected.hiddenFields).join(", ") || "(none)"}`);

  if (!totpSecret) {
    console.error("[FAIL] BCS_TOTP_SECRET missing");
    process.exit(8);
  }

  const code = new TOTP({
    secret: Secret.fromBase32(totpSecret.replace(/\s+/g, "").toUpperCase()),
  }).generate();
  console.log(`[7/7] POST ${detected.actionUrl} with TOTP code (${code.length} digits)`);
  const submitBody = new URLSearchParams({
    ...detected.hiddenFields,
    [detected.fieldName]: code,
  });
  const submitRes = await fetch(detected.actionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `JSESSIONID=${finalSessionId}; CSRF_Token=${finalCsrf}`,
      "X-CSRF-Token": finalCsrf,
    },
    body: submitBody.toString(),
    redirect: "manual",
  });
  const submitLoc = submitRes.headers.get("location") ?? "(no redirect)";
  console.log(`      status=${submitRes.status}  location=${submitLoc}`);

  const verifyRes = await fetch(`${url}/bcs`, {
    headers: {
      Cookie: `JSESSIONID=${finalSessionId}; CSRF_Token=${finalCsrf}`,
      "X-CSRF-Token": finalCsrf,
    },
    redirect: "manual",
  });
  const verifyLoc = verifyRes.headers.get("location") ?? "(no redirect)";
  console.log(`      verify GET /bcs → status=${verifyRes.status}  location=${verifyLoc}`);

  if (verifyLoc.includes("totp") || verifyLoc.includes("/login")) {
    console.error("[FAIL] still redirected after TOTP submission");
    process.exit(9);
  }
  console.log("");
  console.log("[OK] auth successful (TOTP step verified)");
  process.exit(0);
}

const isLoggedIn =
  !sanityLoc.includes("/login") &&
  (sanityRes.status < 400 || sanityRes.status === 302);

console.log("");
console.log(isLoggedIn ? "[OK] auth successful (no 2FA needed)" : "[FAIL] post-login request rejected");
process.exit(isLoggedIn ? 0 : 6);
