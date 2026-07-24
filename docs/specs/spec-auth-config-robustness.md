# Spec: Auth & config robustness

> Created: 2026-07-24

Make startup configuration forgiving and location-independent: an empty
`BCS_TOTP_SECRET` no longer breaks login, and `.env` loads from the project root
regardless of the working directory the MCP client launches the server from.

## Outcome

- [ ] `getConfig()` succeeds when `BCS_TOTP_SECRET` is present but empty or
      whitespace-only, treating it as unset (2FA path stays optional).
- [ ] The server loads `.env` from the project root regardless of the process
      working directory; env vars supplied by the MCP client still take
      precedence over `.env` values.
- [ ] The config error for a genuinely missing/invalid required var remains
      clear and names the offending var(s).
- [ ] `pnpm verify` is green with regression tests covering the empty-secret and
      the env-path behaviors.

## Scope

### In scope

- Coerce an empty / whitespace-only `BCS_TOTP_SECRET` to unset in the `zod`
  config schema (`src/auth.ts`).
- Resolve `.env` relative to the compiled entry file via `import.meta.url` in
  `src/index.ts`, preserving MCP-client env precedence.
- Regression tests for both.

### Out of scope

- The cross-instance login POST-URL fix — already landed on `main` (PR #6).
- Speculative browser-like `User-Agent` / `Referer` headers on the login POST —
  verified unnecessary on our instance; deferred under constitution minimalism
  until a concrete instance is shown to need them.
- Any refactor of `login()` or the session-cache flow.

## Constraints

- 2FA is optional; all auth code must handle both the 2FA and non-2FA paths
  (`docs/constitution.md`, `CLAUDE.md`).
- Config validation uses `zod`; fail fast on genuinely missing/invalid vars
  (`docs/constitution.md` tech stack).
- No `any`; ESM with `.js` imports; strict TypeScript (`docs/constitution.md`).
- `dotenv` must not override an env var already present in `process.env` — the
  MCP client's `env` block wins over `.env` (`README.md` Claude Desktop section).

## Prior art

- [BCS data access — form scraping vs. official API](../prior-art.md#bcs-data-access--form-scraping-vs-official-api-phase-1)
  — tangential: informs the resilience theme of this phase (why we scrape and
  must stay forgiving across instances), not the two specific papercuts, which
  are internal config bugs with no external precedent.

## Human prerequisites

- none — code-only changes; the existing `.env` already covers runtime, and no
  new secret or external provisioning is required.

## Prior decisions

| Decision | Rationale | Date |
|---|---|---|
| Coerce empty/whitespace `BCS_TOTP_SECRET` to `undefined` via a `zod` preprocess wrapping `z.string().min(1).optional()` | 2FA is optional; `BCS_TOTP_SECRET=` (empty) is a common `.env` pattern and currently trips `min(1)`; coercion is more forgiving than requiring users to delete the line | 2026-07-24 |
| Resolve `.env` with `resolve(dirname(fileURLToPath(import.meta.url)), "../.env")` and load via `dotenv.config({ path })`, not `import "dotenv/config"` | Runtime entry is `dist/index.js`, so `../.env` is the project root; `import "dotenv/config"` resolves against CWD, which the MCP client does not control | 2026-07-24 |
| Keep `dotenv`'s default no-override behavior (do not pass `override: true`) | The MCP client's `env` block must win over `.env` (documented in README) | 2026-07-24 |
| Extract the `.env`-path derivation into a **pure function** taking `import.meta.url` and returning the resolved path; `index.ts` calls it before importing config-reading modules, and the test exercises the function directly | `index.ts` has top-level startup side effects and no tests; a pure helper makes the path derivation unit-testable without triggering server startup (mirrors the existing `SESSION_FILE` pattern in `auth.ts`) | 2026-07-24 |
| Do NOT add speculative `User-Agent`/`Referer` headers | Verified unnecessary on our instance during the #4 investigation; constitution forbids handling impossible/unproven scenarios | 2026-07-24 |

## Tracking

- Milestone: created at the spec-acceptance gate (linked on merge).
- Issues: created from this spec once merged (one per implementable step).

## Verification

- [ ] `pnpm verify` passes (`tsc --noEmit && vitest run`).
- [ ] Unit test: `getConfig()` returns config with `BCS_TOTP_SECRET` undefined
      when the env var is `""` or whitespace, and still throws for a genuinely
      missing required var (e.g. `BCS_URL`).
- [ ] Unit test: the pure `.env`-path function, given a representative
      `import.meta.url`, returns the project-root `.env` path (derived from the
      module location, not CWD).
- [ ] Behavioral check: a non-empty `BCS_TOTP_SECRET` still enables the 2FA path
      unchanged (no regression to existing TOTP tests).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Env-path change breaks the MCP-client-env-override contract | Assert `.env` is loaded without `override`; keep a test/behavioral note that a client-provided var wins |
| `zod` preprocess accidentally coerces a legitimately-set secret | Only coerce when the trimmed string is empty; a non-empty value passes through untouched (covered by a test) |

## Decision log

- 2026-07-24: Scoped Phase 1 to the two known config papercuts; cross-instance
  login POST-URL already fixed (PR #6), UA/Referer deferred under minimalism.
