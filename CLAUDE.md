# bcs-mcp

MCP server for Projektron BCS time tracking.

## Commands

```bash
pnpm build        # Build to dist/
pnpm dev          # Build with watch mode
pnpm test         # Run tests
pnpm start        # Start HTTP server (default port 3000)
```

## Architecture

```
src/index.ts   — HTTP server entry point
src/server.ts  — MCP session management, request routing
src/logger.ts  — Console + file logging (bcs-mcp.log, truncated per start)
src/tools.ts   — MCP tool definitions (6 tools)
src/api.ts     — BCS form-based API (HTML GET/POST, form state parsing)
src/auth.ts    — BCS authentication (login, CSRF, session persistence)
```

Flow: `index.ts` -> `server.ts` -> `tools.ts` -> `api.ts` -> `auth.ts` -> BCS
Logging: `logger.ts` imported by all modules. File log at `bcs-mcp.log` (project root), truncated on each server start.

## BCS Integration

BCS uses **form-based server-side rendering**, not a REST API.

### Authentication

`POST /bcs/login` with fields `user`, `pwd`, `isPassword=pwd`, `login=Anmelden`. Requires pre-fetching the login page for initial JSESSIONID + pagetimestamp. Returns `JSESSIONID` + `CSRF_Token` cookies. Sessions cached in `.bcs-session` file (30 min TTL).

### Form field structure

- PSP Tree: `daytimerecording,Content,daytimerecordingPspTree,Columns,{column},listeditoid_{OID}.{field}`
- Attendance: `daytimerecording,Content,daytimerecordingAttendance,Columns,{column},listeditoid_{OID}.{field}`
- Events: `daytimerecording,Content,daytimerecordingEvents,Columns,{column},listeditoid_{OID}.{field}`
- Date params: `year`, `month` (1-based), `day` as separate query params
- Auth: `Cookie: JSESSIONID=...; CSRF_Token=...` + `X-CSRF-Token: ...` header

**Note:** BCS misspells "attendance" as `attandence` in all field names — must match exactly.

### Page structure

- **PSP Tree**: Project rows are readonly aggregates. Task rows appear after AJAX tree expansion (`ajax_request=open`).
- **Attendance**: Has `$new$` rows with `recordType=unsavedAttendance` / `unsavedPause` for creating entries. `$new$` OIDs change per page load.
- **Events**: Calendar appointments, read-only.

### Booking flow (dual-path)

1. GET day page -> parse form state (415+ fields)
2. AJAX expand project tree node -> get editable task rows
3. Deduplicate overlapping fields between page HTML and AJAX response
4. **Path A** (empty task, `recordType=neweffort`): Set values directly via `body.set()`
5. **Path B** (task has existing effort): Create `$new$` row with `recordType=unsavedeffort`, append via `body.append()` (duplicate keys = new row for BCS)
6. POST with `PageForm,formChangedIndicator=true` + `daytimerecording,Apply=Speichern`
7. Filter `$new$` attendance rows from POST to avoid side effects
8. Verify by re-reading the page

### Key fields per effort entry

| Field | Purpose |
|-------|---------|
| `effortExpense_hour` / `effortExpense_minute` | Booked time |
| `description` | Work description |
| `effortTargetOid` | Task OID |
| `recordType` | `effort` (saved), `neweffort` (empty), `unsavedeffort` (new `$new$` row) |
| `recordOid` | Empty string for new rows |
| `_helper` | JSON metadata, must appear twice in POST (original + new row) |

### Week summary

Uses sequential requests per day (not `Promise.all()`) because BCS is stateful and concurrent requests cause race conditions.

## Known Gotchas

- `expandTreeNode()` returns `_JEffort` OIDs when effort exists on a task, not `_JTask`. Fallback verification via `effortTargetOid` matching is needed.
- Form field deduplication: page HTML may already contain task fields from server-remembered tree expansion. Both `bookEffort()` and `deleteEffort()` filter duplicates.
- `_helper` JSON metadata fields must be appended (not set) for `$new$` rows — BCS expects duplicate keys.
- Attendance recordTypes: `unsavedAttendance`/`distributed`/`undistributed` = working time, `unsavedPause` = pause.
- Project/task names are extracted from `<a><span>` elements in PSP tree `<tr>` rows via `parsePspTreeNames()`.

## Coding Conventions

- Strict TypeScript: `any` is forbidden, use `unknown` + type guards
- ESM throughout (import/export, `.js` extensions in imports)
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`
- Minimal code, no over-engineering
