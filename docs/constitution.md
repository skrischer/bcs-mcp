# Constitution

## Tech stack

| Area | Choice | Rationale |
| ---- | ------ | --------- |
| Language | TypeScript, strict | Type safety over 400+ HTML form fields; `any` forbidden |
| Runtime | Node.js 18+, ESM | Modern async `fetch`; ESM matches the SDK and tooling |
| MCP | `@modelcontextprotocol/sdk` | The protocol this server speaks |
| HTML parsing | `node-html-parser` | Lightweight, sync parse of BCS's server-rendered forms |
| 2FA | `otpauth` | Base32 TOTP generation for BCS 2FA |
| Config | `zod` + `dotenv` | Schema-validated env; fail fast on misconfig |
| Build | `tsup` | Zero-config ESM bundling |
| Tests | `vitest` | Fast, ESM-native; `fetch` stubbed per test |

## Architecture principles

- No `any` anywhere — use `unknown` + type guards. Checkable: `tsc --noEmit`
  clean and no `any` token in `src/`.
- ESM only; every relative import ends in `.js`. Checkable by grep/review.
- All BCS HTTP access flows through `auth.ts` (login/session) and `api.ts`
  (forms); `tools.ts` and `server.ts` never call `fetch` directly.
- Stateful BCS page reads run sequentially, never `Promise.all` — concurrent
  requests race on BCS's server-side session state (e.g. week summary).
- Every module logs through `logger.ts`; no bare `console.*` in `src/`.
- Sessions are cached in `.bcs-session` with a 30-minute TTL; auth code must
  handle both the 2FA and non-2FA paths.
- Max function length 120 lines (checkable by line count). Known exceeders are
  tracked as tech debt below, not normalized; split opportunistically when a
  change touches them, never as a standalone refactor.

## Conventions

- Naming: BCS field names are matched verbatim, including the vendor's
  misspelling `attandence` — do not "correct" them.
- Commits: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`,
  `refactor:`).
- Minimal code: no speculative abstraction or configurability beyond the stated
  requirement; every changed line traces to a request.
- Secrets and session files (`.env`, `.bcs-session`) are never committed.

## Quality gates

- `tsc --noEmit` is clean (no type errors, no `any`).
- `pnpm test` (vitest) is green.
- `pnpm build` (tsup) succeeds for app-affecting changes.
- Commit messages follow Conventional Commits.

## Don'ts

- Don't introduce `any`, non-ESM imports, or bare `console.*`.
- Don't call `fetch` from `tools.ts`/`server.ts` — go through `api.ts`/`auth.ts`.
- Don't use `Promise.all` for stateful BCS page sequences.
- Don't add a runtime dependency without a one-line rationale in the PR.
- Don't depend on the licensed BCS SOAP/REST API — the scraping path is
  deliberate (see vision non-goals).

## Tech debt (brownfield)

| Deviation | Where | Plan |
| --------- | ----- | ---- |
| No linter — only `tsc` + tests gate quality | repo (no eslint) | Verify chains `tsc` + `vitest`; add eslint only if churn warrants |
| Large form-field-heavy module | `src/api.ts` | Accept given BCS form complexity; split only if a change needs it |
| Empty `BCS_TOTP_SECRET=` rejected by config | `src/auth.ts` `getConfig` | Treat empty as unset (backlog phase 1) |
| `dotenv` resolves `.env` relative to CWD | `src/index.ts` | Resolve via `import.meta.url` (backlog phase 1) |
| Function > 120 lines | `registerTools` (~216, `src/tools.ts`), `login` (~155, `src/auth.ts`) | Split opportunistically when next touched (per-tool registration; extract auth steps) |
