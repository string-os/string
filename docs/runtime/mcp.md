---
title: MCP
---

`stringd` serves the [Model Context Protocol](https://modelcontextprotocol.io) natively. Claude Desktop, Cursor, Codex, or any MCP-compatible client can drive the entire String surface through a single tool — `string({ topic, cmd })` — exactly mirroring the CLI's `string <topic> '<cmd>'`.

The MCP server is **not a separate package**. It's part of the daemon. Two transports:

- **stdio** — `string --mcp`. The CLI hosts an stdio MCP server, auto-starts the daemon, and forwards calls to it. Easiest for clients that spawn child processes.
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
      "args": ["--mcp"]
    }
  }
}
```

Restart Claude Desktop. The `string` tool appears in the tool list. Claude calls it with `{topic, cmd}` for everything — `/open`, `/act`, `/exec`, `/set`, etc.

---

## Quick start (Cursor / Codex / other clients)

Same shape:

```json
{
  "mcpServers": {
    "string": {
      "command": "string",
      "args": ["--mcp"]
    }
  }
}
```

That is enough for the common single-agent setup. String uses the `default` agent automatically.

### Custom agent id

Only set an agent id when you intentionally want separate homes, installed apps,
history, and `/set $X` values for different AI clients or roles:

```json
{
  "mcpServers": {
    "string": {
      "command": "string",
      "args": ["--mcp", "--agent", "codex-reviewer"]
    }
  }
}
```

The equivalent environment variable is `STRING_AGENT_ID`.

---

## HTTP transport

For clients that connect by URL (some MCP libraries, custom agent frameworks, remote/server scenarios):

```json
{
  "mcpServers": {
    "string": {
      "type": "http",
      "url": "http://127.0.0.1:3923/mcp",
      "headers": { "X-Agent-Id": "my-agent" }
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

The tool returns two things:

- **`content[0].text`** — the command's rendered output, wrapped in a **ChanFlow envelope** (`<𝒞=string:TOPIC>\n<body>\n</𝒞>`). Identical to what the CLI prints for the same call. The topic is encoded in the opening tag; error codes are encoded in the body as `ERROR(CODE): …`.
- **`isError`** — `true` if the command failed (sets MCP's standard error flag).

No `structuredContent`. The envelope already carries topic + status — keeping the response shape minimal makes the tool behave like every other standard MCP server (filesystem, git, github, fetch, …) and lets agents apply the same reading habits.

### Example

A call to `string({ topic: "main", cmd: "/info" })` returns:

```json
{
  "content": [{
    "type": "text",
    "text": "<𝒞=string:main>\nSession info\n---\ncwd:       ~/\nfile:      (none open)\n</𝒞>"
  }],
  "isError": false
}
```

On error (`string({ topic: "main", cmd: "/open ./missing.md" })`):

```json
{
  "content": [{
    "type": "text",
    "text": "<𝒞=string:main>\nERROR(NOT_FOUND): File not found: ./missing.md\nRecovery: Use /ls to list available files.\n</𝒞>"
  }],
  "isError": true
}
```

---

## Agent isolation

Every request carries an agent identity:

- stdio shim: `--agent <id>` flag (or `STRING_AGENT_ID` env)
- HTTP: `X-Agent-Id` header

Each agent has a private home at `~/.string/agents/{id}/`. Sessions, history, installed apps, and `/set $X` env vars are scoped to that home.

Unknown agents are auto-registered on first call — no separate provisioning step.

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
