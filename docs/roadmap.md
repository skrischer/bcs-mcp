# bcs-mcp — Roadmap

> Living document: the sequenced queue of phases. The hand-off to `/plan`, which
> picks the next phase, creates its spec + issues, and links them back here.
> No status markers — progress lives in the GitHub issues and milestones each
> phase links to. Specs (created by `/plan`) carry no lifecycle state either;
> a spec is "accepted" once merged on the default branch with a milestone and
> issues.

## Phase overview

| Phase | Name | Spec | Milestone |
|---|---|---|---|
| 1 | Auth & config robustness | [spec](specs/spec-auth-config-robustness.md) | [#1](https://github.com/skrischer/bcs-mcp/milestone/1) |
| 2 | Test coverage for booking/parsing | [spec](specs/spec-booking-test-coverage.md) | [#2](https://github.com/skrischer/bcs-mcp/milestone/2) |
| 3 | Task → project mapping (QoL) | — | — |
| 4 | Natural-language booking UX | — | — |

A phase gets a Spec link once `/plan` drafts it, and a Milestone link once the
spec is merged. The milestone (open/closed + issue progress) is where status
lives.

### Phase notes

- **Phase 1 — Auth & config robustness.** Cross-instance login resilience,
  empty `BCS_TOTP_SECRET` treated as unset, `dotenv` path resolved via
  `import.meta.url`, clearer config/login errors. Prior art: *BCS data access*
  (`docs/prior-art.md`). Absorbs the two known papercuts from the constitution's
  tech-debt table.
- **Phase 2 — Test coverage for booking/parsing.** Broaden vitest coverage over
  `api.ts` booking dual-path, form dedup, and day-type classification. Greenfield
  — no prior art (internal hardening). The single Verify command itself is
  established in `docs/workflow.md`, not here.
- **Phase 3 — Task → project mapping (QoL).** A user-maintained alias → OID map
  to shorten natural-language booking. Prior art: *Task → project mapping*
  (pgebert CLI `mapping`).
- **Phase 4 — Natural-language booking UX.** Contextual date parsing ("last
  Friday"), leave/absence detection with standard-day hours. Prior art:
  *Natural-language booking UX* (Harvest MCP, timetracker-mcp).

## North star

A reliable BCS booking bridge robust enough that a full work week flows through
it via natural language, without ever opening the BCS UI.
