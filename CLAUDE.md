# bcs-mcp

MCP server for Projektron BCS time tracking. Gives Claude Desktop direct access to BCS for booking time via natural language.

## Stack

- TypeScript (strict, no `any`)
- Node.js 18+
- pnpm
- tsup (bundler)
- @modelcontextprotocol/sdk
- node-html-parser (HTML form parsing)
- vitest (tests)

## Commands

```bash
pnpm build        # Build to dist/
pnpm dev          # Build with watch mode
pnpm test         # Run tests
pnpm start        # Start MCP server (stdio)
```

## Architecture

```
src/auth.ts   — BCS authentication (login, CSRF, session persistence)
src/api.ts    — BCS form-based API (HTML GET/POST, form state parsing)
src/tools.ts  — MCP tool definitions (4 tools)
src/index.ts  — Server entry point (stdio transport)
```

Flow: `index.ts` -> `tools.ts` -> `api.ts` -> `auth.ts` -> BCS

## BCS Integration

BCS uses **form-based server-side rendering**, not a REST API. The integration works by:

1. **Login**: `POST /bcs/login` with fields `user`, `pwd`, `isPassword=pwd`, `login=Anmelden`. Requires pre-fetching the login page for initial JSESSIONID + pagetimestamp. Returns `JSESSIONID` + `CSRF_Token` cookies.
2. **Read day data**: `GET /bcs/mybcs/dayeffortrecording/display` with date query params + `oid`. Returns ~600KB HTML with all form fields.
3. **Parse form state**: Extract all `input[name]`, `textarea[name]`, `select[name]` from HTML (~400+ fields).
4. **Book effort**: Modify effort fields in form state, POST back as `application/x-www-form-urlencoded`.

### Form field structure

- PSP Tree (projects/tasks): `daytimerecording,Content,daytimerecordingPspTree,Columns,{column},listeditoid_{OID}.{field}`
- Attendance: `daytimerecording,Content,daytimerecordingAttendance,Columns,{column},listeditoid_{OID}.{field}`
- Events (calendar appointments, read-only): `daytimerecording,Content,daytimerecordingEvents,Columns,{column},listeditoid_{OID}.{field}`
- Date params: `year`, `month` (1-based), `day` as separate query params
- Auth: `Cookie: JSESSIONID=...; CSRF_Token=...` + `X-CSRF-Token: ...` header

**Note:** BCS misspells "attendance" as `attandence` in all field names.

### Page structure

- **PSP Tree**: Project rows are readonly aggregates. Task rows appear after AJAX tree expansion (`ajax_request=open`) and are editable.
- **Attendance**: Has `$new$` rows with `recordType=unsavedAttendance` / `unsavedPause` for creating entries. `$new$` OIDs change per page load.
- **Events**: Calendar appointments. Not used for manual effort booking.

### Key fields per effort entry

- `effortExpense_hour` / `effortExpense_minute` — booked time
- `description` — work description
- `effortTargetOid` — task OID
- `recordType` — "effort", "project", or "root"

### Booking flow

1. GET day page → parse form state (415+ fields)
2. AJAX expand project tree node → get editable task rows
3. Merge page fields + task fields, set effort values
4. POST with `PageForm,formChangedIndicator=true` + `daytimerecording,Apply=Speichern`
5. Filter `$new$` attendance rows from POST to avoid side effects

## MCP Tools

| Tool | Description |
|------|-------------|
| `bcs_get_week_summary` | Week overview (Mon-Fri): per-day booked/unbooked + weekly totals |
| `bcs_get_day_summary` | Day overview: attendance, projects with names and aggregate hours, booked/unbooked |
| `bcs_get_tasks` | List bookable tasks for a project with names (AJAX tree expansion) |
| `bcs_book_effort` | Book time to a task via 3-step form POST |
| `bcs_delete_effort` | Delete a booked effort entry |
| `bcs_set_attendance` | Set attendance times (start/end/pause), handles both new and existing entries |

## Setup

```bash
pnpm install
cp .env.example .env   # then fill in your BCS credentials
pnpm build
pnpm start             # starts HTTP server on PORT (default 3000)
```

## Claude Desktop Integration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bcs": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

Config file location:
- Windows (Store): `%LOCALAPPDATA%\Packages\Claude_...\LocalCache\Roaming\Claude\claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

## Known Issues

- Project/task names are extracted from `<a><span>` elements in PSP tree `<tr>` rows via `parsePspTreeNames()`. Same DOM structure for page HTML and AJAX expand responses.
- Task-level OIDs require AJAX tree expansion per project (`expandTreeNode`).
- Booking via form POST sends the entire form state (~430 fields). `$new$` attendance rows must be filtered to avoid side effects.
- `setAttendance` handles both new entries (`$new$` rows) and updating existing saved attendance.
- Attendance recordTypes: `unsavedAttendance`/`distributed`/`undistributed` = working time, `unsavedPause` = pause. All non-pause types count as working time.
- Session persistence uses a local `.bcs-session` file (30 min TTL).
- BCS field names use `attandence` (misspelled) — must match exactly.

## Coding Conventions

- Strict TypeScript: `any` is forbidden, use `unknown` + type guards
- ESM throughout (import/export, `.js` extensions in imports)
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`
- Minimal code, no over-engineering
