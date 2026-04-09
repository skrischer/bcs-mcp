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

- Events (booked efforts): `daytimerecording,Content,daytimerecordingEvents,Columns,{column},listeditoid_{OID}.{field}`
- PSP Tree (projects): `daytimerecording,Content,daytimerecordingPspTree,Columns,{column},listeditoid_{OID}.{field}`
- Date params: `year`, `month` (1-based), `day` as separate query params
- Auth: `Cookie: JSESSIONID=...; CSRF_Token=...` + `X-CSRF-Token: ...` header

### Key fields per effort entry

- `effortExpense_hour` / `effortExpense_minute` — booked time
- `description` — work description
- `effortTargetOid` — task OID
- `effortEventRefOid.name` — event/appointment name
- `recordType` — "effort", "project", or "root"

## MCP Tools

| Tool | Description |
|------|-------------|
| `bcs_get_bookings` | Get booked efforts for a date |
| `bcs_get_booking_tasks` | Get available projects/tasks to book to |
| `bcs_book_effort` | Book time to a project via form POST |
| `bcs_get_day_summary` | Get day overview with totals + available tasks |

## Claude Desktop Integration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bcs": {
      "command": "node",
      "args": ["/absolute/path/to/bcs-mcp/dist/index.js"],
      "env": {
        "BCS_URL": "https://bcs.medienwerft.de",
        "BCS_USERNAME": "your-username",
        "BCS_PASSWORD": "your-password",
        "BCS_USER_OID": "your-oid"
      }
    }
  }
}
```

## Known Issues

- Project/task names are not available in the HTML (rendered clientside). Only OIDs are returned.
- Task-level OIDs (below projects) are only visible when the project tree node is expanded.
- Booking via form POST sends the entire form state (~400 fields). The `bookEffort` function replaces only the target effort fields.
- Session persistence uses a local `.bcs-session` file (30 min TTL).

## Coding Conventions

- Strict TypeScript: `any` is forbidden, use `unknown` + type guards
- ESM throughout (import/export, `.js` extensions in imports)
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`
- Minimal code, no over-engineering
