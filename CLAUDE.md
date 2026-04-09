# bcs-mcp

MCP server for Projektron BCS time tracking. Gives Claude Desktop direct access to BCS for booking time via natural language.

## Stack

- TypeScript (strict, no `any`)
- Node.js 18+
- pnpm
- tsup (bundler)
- @modelcontextprotocol/sdk
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
src/api.ts    — BCS REST API calls (bookings, tasks, effort)
src/tools.ts  — MCP tool definitions (4 tools)
src/index.ts  — Server entry point (stdio transport)
```

Flow: `index.ts` -> `tools.ts` -> `api.ts` -> `auth.ts` -> BCS

## BCS API Endpoints

All endpoints require `Cookie: JSESSIONID=...` and `X-CSRF-Token: ...` headers.

### Auth
- `POST /bcs/login` — Form login (username, password, loginButton). Returns 302 with JSESSIONID cookie.
- `GET /bcs/mybcs/dayeffortrecording/display?oid=USER_OID` — Page with CSRF token in `<meta name="PageKey" content="...">`.

### REST API
- `POST /rest/frontend/timerecording/daybooking/bookings` — Get bookings (body: `{date, oid}`) or create booking (body: `{date, oid, taskOid, effortExpense_hour, effortExpense_minute, description}`).
- `GET /rest/frontend/timerecording/daybooking/bookingTasks?oid=OID&date=DATE` — Get bookable tasks.

Response envelope: `{ ok: boolean, type: string, result: T, messages: [], issues: unknown }`

## MCP Tools

| Tool | Description |
|------|-------------|
| `bcs_get_bookings` | Get bookings for a date |
| `bcs_get_booking_tasks` | Get available tasks to book to |
| `bcs_book_effort` | Book time to a task |
| `bcs_get_day_summary` | Get day overview with totals |

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

- BCS REST API field names are based on reverse engineering and may differ. First successful responses are logged to stderr for verification.
- Session persistence uses a local `.bcs-session` file (30 min TTL).

## Coding Conventions

- Strict TypeScript: `any` is forbidden, use `unknown` + type guards
- ESM throughout (import/export, `.js` extensions in imports)
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`
- Minimal code, no over-engineering
