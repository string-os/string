---
title: MCP
---

`stringd` serves the [Model Context Protocol](https://modelcontextprotocol.io) natively. Claude Desktop, Cursor, Codex, or any MCP-compatible client can drive the entire String surface through a single tool — `string({ topic, cmd })` — exactly mirroring the CLI's `string <topic> '<cmd>'`.

The MCP server is **not a separate package**. It's part of the daemon. Two transports:

- **stdio** — `string --mcp [--user <id>]`. The CLI hosts an stdio MCP server, auto-starts the daemon, and forwards calls to it. Easiest for clients that spawn child processes.
- **HTTP** — `POST /mcp` on the running daemon (Streamable HTTP). Best for clients that connect by URL.

Both expose the same tool, the same behavior, the same isolation guarantees.

---

## Quick start (Claude Desktop)

Install String globally and add one config entry. The shim handles everything else.

```bash
npm install -g @string-os/string
```

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on your platform:

```json
{
  "mcpServers": {
    "string": {
      "command": "string",
      "args": ["--mcp", "--user", "claude-desktop"]
    }
  }
}
```

Restart Claude Desktop. The `string` tool appears in the tool list. Claude calls it with `{topic, cmd}` for everything — `/open`, `/act`, `/exec`, `/set`, etc.

---

## Quick start (Cursor / Codex / other clients)

Same shape, distinct `--user`:

```json
{
  "mcpServers": {
    "string": {
      "command": "string",
      "args": ["--mcp", "--user", "cursor"]
    }
  }
}
```

Each MCP client should use a different `--user` value. Sessions, history, `/set` env vars, and installed apps are isolated by user — no bleed-over between Claude, Cursor, Codex.

---

## HTTP transport

For clients that connect by URL (some MCP libraries, custom agent frameworks, remote/server scenarios):

```json
{
  "mcpServers": {
    "string": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp",
      "headers": { "X-User-Id": "my-agent" }
    }
  }
}
```

The daemon must already be running (`string --daemon start`). HTTP transport does not auto-start it.

`stringd` binds to `127.0.0.1` only. Remote deployments need an authentication layer (planned).

---

## The `string` tool

A single tool surfaces the entire command set. Description:

> Run a String command in a topic. Topic is `main`, `app:NAME`, `app:NAME:CONFIG`, or `bash:NAME`. `cmd` must start with `/`. To discover what is available in a topic, run `/info` or `/act --help`.

### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `topic` | string | yes | `main` (free-form tab), `app:NAME[:CONFIG]`, or `bash:NAME` |
| `cmd` | string | yes | Command starting with `/` |

### Output

The tool returns three things:

- **`content[0].text`** — the command's rendered output, same body that `string --json <topic> '<cmd>'` returns in its `content` field. Already stripped of the `re:` request prefix.
- **`isError`** — `true` if the command failed (sets MCP's standard error flag).
- **`structuredContent`** — machine-readable summary:
  - `ok` — boolean
  - `topic` — canonical topic (after any auto-routing)
  - `code` — error code string, present only on failure (`NOT_FOUND`, `INVALID_PAYLOAD`, …)

### Example

A call to `string({ topic: "main", cmd: "/info" })` returns:

```json
{
  "content": [{ "type": "text", "text": "Session info\n---\ncwd:       ~/\nfile:      (none open)" }],
  "isError": false,
  "structuredContent": { "ok": true, "topic": "main" }
}
```

On error (`string({ topic: "invalid.target", cmd: "/info" })`):

```json
{
  "content": [{ "type": "text", "text": "Invalid topic: invalid.target" }],
  "isError": true,
  "structuredContent": { "ok": false, "topic": "invalid.target", "code": "INVALID_TARGET" }
}
```

---

## User isolation

Every request carries a user identity:

- stdio shim: `--user <id>` flag (or `STRINGD_USER` env)
- HTTP: `X-User-Id` header

Each user has a private home at `~/.string/users/{id}/`. Sessions, history, installed apps, and `/set $X` env vars are scoped to that home. A `/set` from Claude Desktop never reaches Cursor's view, and vice versa.

Unknown users are auto-registered on first call — no separate provisioning step.

---

## Mental model for the agent

The MCP wrapping is intentionally minimal. The agent sees one tool and learns the command surface through the command surface itself:

1. Call `string({ topic: "main", cmd: "/info" })` to see the current session
2. Call `string({ topic: "main", cmd: "/act --help" })` to list available actions
3. Call `string({ topic: "app:weather", cmd: "/act.now Seoul" })` to use an app

This mirrors the CLI flow exactly. Every doc page about `/info`, `/act`, `/open`, `/set`, `/exec`, etc. applies unchanged. The MCP layer is a transport, not a new vocabulary.

---

## Security boundary

- `stringd` binds **loopback only** (`127.0.0.1`). External interfaces are not exposed.
- The HTTP MCP endpoint has no auth. It assumes local-only trust — the OS user that runs the daemon is the trust boundary.
- `/set $X` is app-scoped: no cross-app env leak, no `process.env` fallback. See [State and variables](./state.md).
- Remote / multi-host deployments need an authenticated transport, planned for a later release.

---

## When not to use MCP

Use the [`@string-os/client`](https://github.com/string-os/string/tree/main/packages/client) HTTP client if you're building a custom agent framework in Node — it's lower overhead than MCP and gives you direct access to the SSE stream's `head` metadata (uri, title, actions list). MCP is for off-the-shelf clients that already speak the protocol.
