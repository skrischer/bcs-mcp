# Prior Art

> Descriptive, living document. Indexed BY CONCERN, not by project. Add
> entries whenever new references surface; gaps are fine.
>
> Tag each concern header with the one roadmap phase it feeds: `(Phase N)` for a
> roadmap P-number or `(feature: <slug>)` for a Features-table row (one tag, not
> both) — so `/loopkit:plan` can resolve "prior art for phase N" deterministically.

## BCS data access — form scraping vs. official API (Phase 1)

### pgebert/projektron-bcs-cli

- Path: whole repo (TypeScript/Node CLI)
- License: MIT
- Verdict: reference-only — same problem and auth model (`BCS_URL`/`BCS_USERNAME`/`BCS_PASSWORD` env), but far narrower and not MCP.
- Date: 2026-07-23
- Notes:
  - ADOPT: task-to-projectId mapping as a convenience layer (its `mapping` command); env-based configuration; the "reduce manual steps" design goal.
  - AVOID: no 2FA/TOTP support; no attendance / week overview / overtime / vacation coverage; pinned to BCS V21.4 (version-brittle scraping) — we must stay resilient across instances/versions rather than hardcode one.

### Projektron BCS Web Services (SOAP) + REST interface

- Path: https://www.projektron.de/en/bcs/technical-aspects/interfaces/web-services/
- License: proprietary (vendor add-on)
- Verdict: avoid (for us) — official query/create/change/delete web services exist, but as a licensed, separately-provisioned add-on that is NOT enabled on our target instance.
- Date: 2026-07-23
- Notes:
  - ADOPT: nothing directly usable — access is gated behind licensing/instance config.
  - AVOID: assuming API availability. This is our differentiation evidence: form scraping is the pragmatic path precisely because the official API is not accessible. If an instance ever grants API access, that would be a separate, future concern — not a replacement for the scraping core.

## Task → project mapping (Phase 3)

### pgebert/projektron-bcs-cli — `mapping`

- Path: `mapping` command
- License: MIT
- Verdict: reference-only — a QoL layer that maps friendly task names to BCS project/task OIDs so users don't hunt for OIDs.
- Date: 2026-07-23
- Notes:
  - ADOPT: the idea of a user-maintained alias→OID map to shorten natural-language booking.
  - AVOID: a rigid config file that goes stale; prefer resolving live against `bcs_get_tasks` where possible.

## Natural-language booking UX (Phase 4)

### adrian-dotco/harvest-mcp-server

- Path: whole repo (TypeScript MCP server)
- License: MIT
- Verdict: reference-only — the closest MCP-time-tracking UX, but backed by Harvest's clean v2 REST API rather than scraping.
- Date: 2026-07-23
- Notes:
  - ADOPT: tool decomposition (`list_projects` / `list_tasks` / `log_time` / `get_time_report`) — mirrors our `bcs_get_tasks` / `bcs_book_effort` / `bcs_get_*_summary`; contextual NL date parsing (chrono-node: "today", "last Friday"); leave/absence detection from phrases ("I'm off sick today") applying standard-day hours.
  - AVOID: assuming a clean REST backend — our stateful form scraping cannot mirror their simplicity; NL sugar must sit above a robust scraping core, not replace it.

### lumile/timetracker-mcp

- Path: whole repo
- License: see repo
- Verdict: reference-only — a conversational-first MCP time-tracking framing.
- Date: 2026-07-23
- Notes:
  - ADOPT: conversational-first interaction as the primary surface (not a UI afterthought).
  - AVOID: over-indexing on chat ergonomics before the underlying booking operations are reliable.
