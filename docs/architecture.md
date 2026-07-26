# Architecture

> Structural, living document — the most volatile artifact. Update whenever a
> change alters components, boundaries, or flows.

## Component map

| Component | Responsibility |
| --------- | -------------- |
| `src/index.ts` | Entry point; selects transport (`--stdio` vs. default HTTP), wires shutdown |
| `src/server.ts` | MCP session management and request routing |
| `src/tools.ts` | The 8 MCP tool definitions: input schemas + response formatting |
| `src/api.ts` | BCS form-based API: HTML GET/POST, form-state parsing, day-type classification |
| `src/auth.ts` | BCS authentication: login, CSRF, TOTP 2FA, `.bcs-session` persistence, config (`zod`) |
| `src/logger.ts` | Console + file logging (`bcs-mcp.log`), imported by all modules |

## Boundaries

- Dependency direction: `index` → `server` → `tools` → `api` → `auth` → BCS.
- Only `auth.ts` and `api.ts` perform network `fetch`; `tools.ts` and
  `server.ts` never touch BCS directly.
- `logger.ts` is a leaf — it depends on nothing and is imported everywhere.
- Transport concerns (`index`/`server`) are decoupled from BCS logic
  (`tools`/`api`/`auth`): swapping stdio↔HTTP touches no BCS code.

## Key flows

1. **Startup** — `index.ts` picks the transport → `server.ts` creates the MCP
   server and registers the 8 tools.
2. **Auth** — `auth.login()`: GET login page → POST credentials to the form's
   session-specific action URL → probe `GET /bcs` → if redirected to
   `totpVerification`, generate a TOTP (server-time corrected) and POST it →
   cache the session (30-min TTL).
3. **Read (day/week)** — `api.ts` GETs the day-effort page → parses 400+ form
   fields → classifies each day as `workday` / `holiday` / `absence`. Week
   summary iterates days sequentially (never `Promise.all`).
4. **Book** — GET page → AJAX-expand the project tree → dedupe fields →
   dual-path (set empty `neweffort` vs. append `$new$` `unsavedeffort`) → POST
   the whole form → verify by re-reading.
5. **Overtime / Vacation** — AJAX lazy-load of the notification board
   (overtime); GET + parse the vacation page (budget + absences).

## Where new code goes

- A new MCP tool → its definition/schema in `tools.ts`, its BCS interaction in
  `api.ts`.
- A new BCS page interaction (parse/submit) → `api.ts`.
- Anything touching login, session, CSRF, TOTP, or config → `auth.ts`.
- Transport, routing, or session lifecycle → `server.ts` / `index.ts`.
- Cross-cutting logging → `logger.ts`; never add a second logging path.
- Never add a `fetch` call outside `api.ts` / `auth.ts`.
