# bcs-mcp

MCP server for [Projektron BCS](https://www.projektron.de/) time tracking. Connects Claude Desktop (or any MCP client) to BCS so you can book your work week via natural language.

## What it does

BCS has no public API — it uses server-side rendered HTML forms. This server scrapes and submits those forms, exposing 6 MCP tools:

| Tool | Description |
|------|-------------|
| `bcs_get_week_summary` | Week overview (Mon-Fri) with per-day hours and totals |
| `bcs_get_day_summary` | Day detail: attendance, projects, tasks, booked/unbooked hours |
| `bcs_get_tasks` | List bookable tasks for a project |
| `bcs_book_effort` | Book time to a task (always creates a new entry) |
| `bcs_delete_effort` | Delete a booked effort entry |
| `bcs_set_attendance` | Set attendance times (start, end, pause) |

## Prerequisites

- Node.js 18+
- pnpm
- A Projektron BCS account with day effort recording enabled

## Setup

```bash
pnpm install
cp .env.example .env
```

Fill in `.env`:

```env
BCS_URL=https://your-bcs-instance.example.com
BCS_USERNAME=your-username
BCS_PASSWORD=your-password
BCS_USER_OID=your-user-oid
PORT=3000
```

To find your `BCS_USER_OID`: open BCS, navigate to day effort recording, and look for the `oid` query parameter in the URL.

## Build and run

```bash
pnpm build
pnpm start        # starts HTTP server on PORT (default 3000)
```

For development:

```bash
pnpm dev           # build with watch mode
pnpm test          # run tests
```

## Claude Desktop integration

Add to your `claude_desktop_config.json`:

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
- **Windows (Store):** `%LOCALAPPDATA%\Packages\Claude_...\LocalCache\Roaming\Claude\claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Then ask Claude something like:

> "Book 2 hours on project X, task Y for today with description 'API integration'"

> "Show me my week summary"

> "Set my attendance for today: 8:30 - 17:00 with 30 min lunch break"

## Architecture

```
src/index.ts   — HTTP server entry point
src/server.ts  — MCP session management and request routing
src/tools.ts   — MCP tool definitions (input schemas, response formatting)
src/api.ts     — BCS form-based API (HTML parsing, form submission)
src/auth.ts    — BCS authentication (login, CSRF tokens, session persistence)
```

## How it works

1. **Login** — POST to `/bcs/login` with credentials, capture `JSESSIONID` + `CSRF_Token` cookies. Sessions are cached locally (30 min TTL).
2. **Read** — GET the day effort recording page (~600KB HTML), parse all form fields (~400+).
3. **Expand** — AJAX request to expand project tree nodes and reveal bookable tasks.
4. **Book** — Append a new effort row to the form state, POST the entire form back. Each booking always creates a new entry (dual-path strategy for empty vs. occupied task rows).
5. **Verify** — Re-read the page after booking to confirm the entry was saved.

## License

ISC
