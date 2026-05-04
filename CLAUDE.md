# bcs-mcp

MCP server for Projektron BCS time tracking.

## Commands

```bash
pnpm build        # Build to dist/
pnpm dev          # Build with watch mode
pnpm test         # Run tests
pnpm start        # Start HTTP server (default port 3000)
pnpm start:stdio  # Start in stdio mode (for Claude Desktop)
```

## Architecture

```
src/index.ts   — Entry point (--stdio for stdio transport, default: HTTP)
src/server.ts  — MCP session management, request routing
src/logger.ts  — Console + file logging (bcs-mcp.log, truncated per start)
src/tools.ts   — MCP tool definitions (8 tools)
src/api.ts     — BCS form-based API (HTML GET/POST, form state parsing)
src/auth.ts    — BCS authentication (login, CSRF, TOTP 2FA, session persistence)
```

Flow: `index.ts` -> `server.ts` -> `tools.ts` -> `api.ts` -> `auth.ts` -> BCS
Logging: `logger.ts` imported by all modules. File log at `bcs-mcp.log` (project root), truncated on each server start.

## BCS Integration

BCS uses **form-based server-side rendering**, not a REST API.

### Authentication

`POST /bcs/login` with fields `user`, `pwd`, `isPassword=pwd`, `login=Anmelden`. Requires pre-fetching the login page for initial JSESSIONID + pagetimestamp. Returns `JSESSIONID` + `CSRF_Token` cookies. Sessions cached in `.bcs-session` file (30 min TTL).

**2FA (TOTP):** When 2FA is enabled, BCS redirects all requests to `/bcs/totpVerification` after the password POST. `login()` probes with `GET /bcs` after the password step; on redirect to `/bcs/totpVerification`, it fetches the challenge page, parses the OTP input field (`totpVerificationCode`), generates a 6-digit code from `BCS_TOTP_SECRET` (Base32) via `otpauth`, and POSTs it with hidden fields (`pagetimestamp`, `!totpTrustBrowser`, `login=true`). If 2FA is required but `BCS_TOTP_SECRET` is not configured, login throws.

### Login flow

1. GET `/bcs/login` -> extract JSESSIONID + pagetimestamp
2. POST `/bcs/login` with credentials -> extract JSESSIONID + CSRF_Token
3. Redirect-to-login check (definite auth failure -> throw)
4. Probe GET `/bcs` -> check if BCS redirects to `/bcs/totpVerification`
5. **No 2FA**: validate CSRF_Token present, return session
6. **2FA**: validate `BCS_TOTP_SECRET` set -> GET challenge page -> parse form -> generate TOTP -> POST code -> validate success

### Form field structure

- PSP Tree: `daytimerecording,Content,daytimerecordingPspTree,Columns,{column},listeditoid_{OID}.{field}`
- Attendance: `daytimerecording,Content,daytimerecordingAttendance,Columns,{column},listeditoid_{OID}.{field}`
- Events: `daytimerecording,Content,daytimerecordingEvents,Columns,{column},listeditoid_{OID}.{field}`
- Date params: `year`, `month` (1-based), `day` as separate query params
- Auth: `Cookie: JSESSIONID=...; CSRF_Token=...` + `X-CSRF-Token: ...` header

**Note:** BCS misspells "attendance" as `attandence` in all field names — must match exactly.

### Page structure

- **PSP Tree**: Project rows are readonly aggregates. Task rows appear after AJAX tree expansion (`ajax_request=open`).
- **Attendance**: Has `$new$` rows with `recordType=unsavedAttendance` / `unsavedPause` for creating entries. `$new$` OIDs change per page load. On days without saved attendance, `$new$` rows are pre-filled with default values (e.g. 8:00–17:00, 1h pause).
- **Events**: Absence entries (vacation, sick leave, comp time). `recordType=event`, OID ends in `_JAppointment`. Label extracted from `<a><span>` in `attandenceLabel` cell. `_helper` JSON contains `_subtyp` (e.g. `OvertimeCompensation`).

### Day type interpretation

`DaySummary.dayType` classifies each day:

| dayType | Condition | unbookedHours |
|---------|-----------|---------------|
| `workday` | Attendance with duration > 0 (saved or unsaved) | Calculated normally |
| `absence` | Has `event` row (vacation, sick, comp time) | Always 0 |
| `holiday` | No attendance, no events (empty unsavedAttendance 0h) | Always 0 |

`absenceReason` contains the human-readable label (e.g. "Freizeitausgleich", "Urlaub") parsed from the event row's `attandenceLabel` cell.

### Attendance recordTypes

| recordType | Meaning | Source |
|------------|---------|--------|
| `attendance` | Saved working time | Non-`$new$` row |
| `pause` | Saved pause | Non-`$new$` row |
| `unsavedAttendance` | Template / default attendance | `$new$` row, pre-filled on days without bookings |
| `unsavedPause` | Template / default pause | `$new$` row |
| `event` | Absence (vacation, sick, comp time) | `_JAppointment` OID |
| `distributed` | BCS-internal: booked portion of attendance | `_Temp` OID, ignored in calculations |
| `undistributed` | BCS-internal: unbooked portion of attendance | `_Temp` OID, ignored in calculations |

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

### Overtime balance (Arbeitszeitkonto)

Fetched via AJAX from the notification board (`/bcs/mybcs/notificationoverview/display`). BCS uses lazy-loaded board components — the overtime chart data is not in the initial HTML but loaded via a separate GET request with `bcs_ajax_type=2&bcs_ajax_component=mybcsboard,Content,overtimeDiagram&bcs_ajax_additional_param,ListDisplayAJAXTrigger=LazyLoad`. Response is JSON: `loadEvents[0].event.data` contains an array of data points with `orgKey` identifiers and values in minutes (`deputatSummaryEffortSum`).

### Vacation status (Urlaubsbudget)

Fetched from `/bcs/mybcs/vacation/display` with query params `userbudgets,Choices,sourcechoice,tab=budgets&group,Choices,sourcechoice,tab=vacationlist`. The vacation budget is a regular HTML table with `thead` containing "Urlaubsbudget". Each `<td>` has a `name` attribute matching the column identifier (e.g. `vacationIndicatorTotalBudget`, `appointmentIndicatorRemainingVacationToday`). Values use German decimal format (comma separator).

## Known Gotchas

- `expandTreeNode()` returns `_JEffort` OIDs when effort exists on a task, not `_JTask`. Fallback verification via `effortTargetOid` matching is needed.
- Form field deduplication: page HTML may already contain task fields from server-remembered tree expansion. Both `bookEffort()` and `deleteEffort()` filter duplicates.
- `_helper` JSON metadata fields must be appended (not set) for `$new$` rows — BCS expects duplicate keys.
- Attendance field names: column is the base name (e.g. `attandenceStart`), field includes suffix (e.g. `attandenceStart_hour`). See "Attendance recordTypes" table above for all types.
- `$new$` attendance rows must not be filtered from `parseAttendance()` — on days without saved attendance, they contain the actual default values. `setAttendance()` separates saved vs. `$new$` rows for write logic.
- Project/task names are extracted from `<a><span>` elements in PSP tree `<tr>` rows via `parsePspTreeNames()`.
- CSRF_Token check must happen AFTER the 2FA probe, not before — BCS may not set it until TOTP verification completes.
- `BCS_TOTP_SECRET` is optional. All auth code must handle both paths (with and without 2FA).

## Testing

- Test framework: vitest
- `fetch` is mocked via `vi.stubGlobal("fetch", vi.fn<FetchFn>())` with chained `.mockResolvedValueOnce()` for sequential HTTP responses
- Each mock response uses `new Response(body, { status, headers })` — headers as tuples for multiple Set-Cookie
- Auth tests mock the full login flow: login page -> password POST -> probe -> (optional: TOTP challenge -> TOTP POST)
- `BcsConfig` is constructed inline per test, not loaded from env

## Coding Conventions

- Strict TypeScript: `any` is forbidden, use `unknown` + type guards
- ESM throughout (import/export, `.js` extensions in imports)
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`
- Minimal code, no over-engineering
