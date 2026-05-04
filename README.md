# bcs-mcp

MCP server for [Projektron BCS](https://www.projektron.de/) time tracking. Connects Claude Desktop (or any MCP client) to BCS so you can book your work week via natural language.

## What it does

BCS has no public API — it uses server-side rendered HTML forms. This server scrapes and submits those forms, exposing 8 MCP tools:

| Tool | Description |
|------|-------------|
| `bcs_get_week_summary` | Week overview (Mon-Fri) with per-day attendance, day type, booked/unbooked hours |
| `bcs_get_day_summary` | Day detail: attendance, projects, booked/unbooked hours, day type (workday/holiday/absence) |
| `bcs_get_tasks` | List bookable tasks for a project |
| `bcs_book_effort` | Book time to a task (always creates a new entry) |
| `bcs_delete_effort` | Delete a booked effort entry |
| `bcs_set_attendance` | Set attendance times (start, end, pause) |
| `bcs_get_overtime_balance` | Working time account: flexi-time balance, target vs actual hours |
| `bcs_get_vacation_status` | Vacation budget: total, used, planned, available days |

## Prerequisites

- Node.js 18+
- pnpm
- A Projektron BCS account with day effort recording enabled

## Setup

```bash
git clone <repo-url> && cd bcs-mcp
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

# Optional: only needed if 2FA (TOTP) is enabled on your BCS account
BCS_TOTP_SECRET=your-base32-totp-secret
```

To find your `BCS_USER_OID`: open BCS, navigate to day effort recording, and look for the `oid` query parameter in the URL.

`BCS_TOTP_SECRET` is the Base32-encoded secret from your authenticator app setup. If your BCS account does not use 2FA, leave it empty or omit it entirely.

## Build and run

```bash
pnpm build
pnpm start         # starts HTTP server on PORT (default 3000)
pnpm start:stdio   # starts in stdio mode (for Claude Desktop)
```

For development:

```bash
pnpm dev           # build with watch mode
pnpm test          # run tests
```

## Claude Desktop integration

### Stdio (recommended)

Claude Desktop launches and manages the server process directly. Add to your `claude_desktop_config.json`:

**macOS / Linux:**

```json
{
  "mcpServers": {
    "bcs": {
      "command": "node",
      "args": ["/absolute/path/to/bcs-mcp/dist/index.js", "--stdio"],
      "env": {
        "BCS_URL": "https://your-bcs-instance.example.com",
        "BCS_USERNAME": "your-username",
        "BCS_PASSWORD": "your-password",
        "BCS_USER_OID": "your-user-oid"
      }
    }
  }
}
```

**Windows (native Node.js):**

Same as above. Use a Windows-style path for `args` (e.g. `"C:\\Users\\you\\bcs-mcp\\dist\\index.js"`).

**Windows with WSL:**

If the project lives inside WSL, use `wsl.exe` to bridge into the Linux environment:

```json
{
  "mcpServers": {
    "bcs": {
      "command": "wsl.exe",
      "args": ["bash", "-ic", "node /absolute/path/to/bcs-mcp/dist/index.js --stdio"],
      "env": {
        "BCS_URL": "https://your-bcs-instance.example.com",
        "BCS_USERNAME": "your-username",
        "BCS_PASSWORD": "your-password",
        "BCS_USER_OID": "your-user-oid"
      }
    }
  }
}
```

Env vars in the config override `.env` file values. If a `.env` file exists, it is also loaded.

### HTTP (for development / debugging)

Start the server manually, then connect via URL:

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
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Then ask Claude something like:

> "Book 2 hours on project X, task Y for today with description 'API integration'"

> "Show me my week summary"

> "How many vacation days do I have left?"

## Architecture

```
src/index.ts   — Entry point (--stdio for stdio transport, default: HTTP)
src/server.ts  — MCP session management and request routing
src/tools.ts   — MCP tool definitions (8 tools, input schemas, response formatting)
src/api.ts     — BCS form-based API (HTML parsing, form submission)
src/auth.ts    — BCS authentication (login, CSRF tokens, session persistence)
```

## How it works

1. **Login** — POST to `/bcs/login` with credentials, capture `JSESSIONID` + `CSRF_Token` cookies. If 2FA is enabled, the TOTP code is generated automatically from `BCS_TOTP_SECRET`. Sessions are cached locally (30 min TTL).
2. **Read** — GET the day effort recording page (~600KB HTML), parse all form fields (~400+). Days are classified as `workday`, `holiday`, or `absence` based on attendance and event records.
3. **Expand** — AJAX request to expand project tree nodes and reveal bookable tasks.
4. **Book** — Append a new effort row to the form state, POST the entire form back. Each booking always creates a new entry (dual-path strategy for empty vs. occupied task rows).
5. **Verify** — Re-read the page after booking to confirm the entry was saved.
6. **Overtime** — AJAX lazy-load request to the notification board retrieves the working time account balance (flexi-time, target/actual hours).
7. **Vacation** — GET the vacation page, parse the budget table (total, used, planned, available days).

## License

ISC
