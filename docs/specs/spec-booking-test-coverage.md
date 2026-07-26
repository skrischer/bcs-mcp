# Spec: Booking test coverage

> Created: 2026-07-26

Close the two genuine gaps in the booking test suite — `bookEffort` Path B
(booking onto a task that already has effort) and the page-vs-AJAX field
deduplication — without touching production code.

## Outcome

- [ ] `bookEffort` Path B is covered: booking onto a task that already has a
      saved effort row creates a `$new$` `unsavedeffort` row (appended, not set)
      and the POST body carries the new entry alongside the existing one.
- [ ] Field deduplication is covered: when the day page HTML already contains a
      task's fields (server-remembered tree expansion) and the AJAX expand
      returns them again, the booking is submitted exactly once — no duplicated
      or conflicting effort field set in the POST body.
- [ ] `pnpm verify` is green with the new tests; no production code changed.

## Scope

### In scope

- New unit tests for `bookEffort` Path B in `src/__tests__/api.bookEffort.test.ts`.
- New unit test(s) for page-vs-AJAX field dedup in `bookEffort` and
  `deleteEffort` (their existing dedicated test files).
- Test fixtures modeling a task row with an existing `effort` record and an
  overlapping page/AJAX field set.

### Out of scope

- Any production code change. If a new test surfaces a real bug, file a separate
  issue and do NOT fix it under this phase (keeps this scope test-only).
- Coverage tooling / a broad coverage sweep — the rest of `api.ts` parsing and
  `deriveDayType` are already well covered.
- Day-type classification tests — `deriveDayType` is already fully covered.

## Constraints

- Test framework is vitest. The booking test files mock the auth module
  directly — `vi.mock("../auth.js")` with `authenticatedFetch = vi.fn()` and
  chained `.mockResolvedValueOnce()` for the sequential HTTP responses — not the
  global `fetch` stub used in `auth.test.ts`. Follow the existing per-file
  pattern (`docs/constitution.md`, `CLAUDE.md` Testing).
- Match BCS field names verbatim, including the `attandence` misspelling and the
  `$new$`/`recordType` conventions (`CLAUDE.md`).
- No `any`; ESM with `.js` imports; strict TypeScript.

## Prior art

- none relevant — internal test hardening; no external precedent.

## Human prerequisites

- none — test-only changes, no secret or provisioning.

## Prior decisions

| Decision | Rationale | Date |
|---|---|---|
| Test-only phase; if a test reveals a real bug, file a separate issue rather than fix it here | Keeps the scope a clean coverage increase; a fix is its own traceable change | 2026-07-26 |
| Extend the existing dedicated test files (`api.bookEffort.test.ts`, `api.deleteEffort.test.ts`) rather than new files | Mirrors the established one-file-per-operation test layout | 2026-07-26 |
| Path B fixture = AJAX tree-expand response whose task row carries a saved `recordType=effort` record, forcing the `$new$` `unsavedeffort` append path | This is exactly the branch `bookEffort` takes for occupied task rows (Path B), the untested one (Path A is already tested) | 2026-07-26 |
| Dedup assertion = the POST body contains exactly one new effort entry when page HTML and AJAX response overlap | Directly exercises the dedup filter both `bookEffort` and `deleteEffort` apply (the CLAUDE.md gotcha) | 2026-07-26 |
| Assert dedup on a field NOT rewritten by `body.set()` (e.g. `recordType`, `recordOid`, or `effortTargetOid`), never on `effortExpense_*`/`description` | `body.set()` collapses duplicate keys automatically, so asserting a set-field would pass even with the dedup filter removed (false negative). The test must fail if the filter is deleted | 2026-07-26 |
| Match the Path B `$new$` row by iterating entries for the `unsavedeffort` value, not by a fixed key | The `$new$` OID embeds `Date.now()` and is non-deterministic | 2026-07-26 |

## Tracking

- Milestone: created at the spec-acceptance gate (linked on merge).
- Issues: created from this spec once merged (one per implementable step).

## Verification

- [ ] `pnpm verify` passes (`tsc --noEmit && vitest run`).
- [ ] A test asserts Path B: for a task with an existing effort, the POST body
      contains a `$new$` `unsavedeffort` row (appended) plus the pre-existing
      effort — not an overwrite of the existing row.
- [ ] A test asserts dedup: with overlapping page + AJAX fields, the POST body
      books the effort exactly once (no duplicate/conflicting effort field set).
- [ ] `git diff --stat` for the change touches only files under
      `src/__tests__/` (no production code).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| A new test reveals a real Path B / dedup bug mid-phase | Per Prior decisions: file a separate issue, keep this phase test-only |
| Fixture drifts from the real BCS HTML shape | Model fixtures on the existing `api.bookEffort.test.ts` Path A fixture and the CLAUDE.md field-structure notes |

## Decision log

- 2026-07-26: Narrowed the roadmap's "Test coverage for booking/parsing" phase
  to the two genuine gaps (Path B, field dedup) after finding the parsing and
  day-type logic already comprehensively covered.
