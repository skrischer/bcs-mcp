# Vision

## Problem

Projektron BCS has no accessible API on our instance — booking time means
clicking through slow, server-rendered HTML forms (a ~600 KB page with 400+
fields) by hand. Daily effort recording is tedious, error-prone, and steals
time from the work it is meant to track.

## Why now

The team already works inside MCP clients (Claude Desktop / Code). An MCP bridge
turns "book my week" into a sentence. The 8 core tools already work against the
live instance; the project now needs a durable, iterative development footing
(loopkit) so it can harden and grow without regressing.

## Target users

- Primary: Medienwerft employees and developers who record time in Projektron
  BCS and drive it from an MCP client.
- Secondary: other BCS customers who self-host and want the same bridge.

## Goal

A reliable MCP server that exposes the full BCS booking surface — effort,
attendance, week/day summaries, overtime balance, and vacation status — over
the form-based UI, so a full work week can be recorded through natural language
without ever opening the BCS interface.

## USP / differentiation

The only known MCP server for Projektron BCS, covering the whole booking surface
over the scraped form UI, with automatic TOTP 2FA and stateful form handling —
where no official API access is available. It deliberately does not use the
licensed SOAP/REST web services (not enabled on our instances). See
`docs/prior-art.md` for the per-entry ADOPT/AVOID harvest (pgebert CLI, Harvest
MCP) that this differentiation rests on.

## Success criteria

- All 8 MCP tools succeed against a live BCS instance (week/day summary, tasks,
  book/delete effort, attendance, overtime, vacation).
- Login succeeds both with and without 2FA (TOTP), and across BCS instances that
  differ in login-form structure.
- A full Mon–Fri work week can be booked end-to-end via natural language with no
  manual BCS UI interaction.
- Test suite is green and the codebase contains no `any` (strict TypeScript).

## Scope

### In

- The 8 booking/reading tools over the BCS form UI.
- Form-based authentication incl. TOTP 2FA and 30-min session caching.
- HTTP and stdio transports.

### Out

- Write operations beyond effort/attendance (e.g. creating projects, editing
  master data).
- A graphical UI of our own.
- Backends other than Projektron BCS.

## Non-goals

- A general BCS API client — this is a booking bridge, not an SDK.
- A hosted multi-tenant service — single-user, run locally per person.
- Reverse-engineering or depending on a private/licensed REST/SOAP API — the
  scraping approach is deliberate, not a stopgap.
