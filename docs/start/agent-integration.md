---
title: Agent Integration
---

String gives agents one command shape across CLI, MCP, and HTTP:

```text
string <topic> '<cmd>'
string({ topic, cmd })
```

Use the default `default` agent unless you explicitly need isolated homes for
different clients or roles. See [Agent Identity](./agent-identity.md) for the
full config precedence and multi-user setup.

## 1. CLI

Best for agents with a shell tool.

```bash
string main '/open ./index.md'
string app:weather '/act.now Seoul'
string bash:dev 'pwd && ls'
```

The CLI auto-starts `stringd` on first use. Default daemon port is `3923`.

Advanced isolation:

```bash
string agent add reviewer --home /home/alice/crew/reviewer
STRING_AGENT_ID=reviewer string main '/info'
```

`--agent reviewer` is equivalent for one command. Prefer `STRING_AGENT_ID` when
you launch a long-running AI session and want every CLI and MCP call in that
process to use the same agent.

For persistent per-workspace selection, create `.string/config.json` in the
workspace instead:

```bash
cd /home/alice/crew/reviewer
string agent use reviewer --local
```

## 2. MCP

Best for Claude Desktop, Cursor, Codex, and other MCP-compatible clients.

```json
{
  "mcpServers": {
    "string": {
      "command": "npx",
      "args": ["-y", "@string-os/string", "--mcp"]
    }
  }
}
```

This exposes one MCP tool:

```json
{ "topic": "main", "cmd": "/info" }
```

For Claude Code, the same `string --mcp` server can also be loaded as a Remote
Control channel. Then local webhook events for the selected String agent are
pushed into that Claude Code session while the `string` tool remains available.

Advanced isolation:

Keep the MCP server name as `string` so the tool id stays stable, then select
the agent when launching the AI client:

```json
{
  "mcpServers": {
    "string": {
      "command": "npx",
      "args": ["-y", "@string-os/string", "--mcp"]
    }
  }
}
```

```bash
string agent add claude-research --home /home/alice/crew/claude-research
STRING_AGENT_ID=claude-research claude
```

For Claude Code, this keeps the visible tool id as `mcp__string__string`.
Registering separate MCP server names such as `string-claude-research` changes
the tool id and is only useful when one AI session must see several String
agents at the same time.

If String is installed through the Claude Code plugin, the bundled MCP config
already runs `string --mcp`. You can still select the agent with
`STRING_AGENT_ID` or workspace-local `.string/config.json`; no plugin override is
needed.

## 3. TypeScript Library

Best for embedded use without the daemon.

```typescript
import { Browser } from '@string-os/string';

const browser = new Browser({ home: '/path/to/workspace' });
const result = await browser.exec('/open ./index.md', 'main');

console.log(result.ok);
console.log(result.content);
```

## 4. Daemon Client

Best for custom Node.js agents that want to talk to a running `stringd`.

```typescript
import { ping, ensureAgent, exec } from '@string-os/client';

const port = 3923;
const agentId = 'default';
const home = process.env.HOME + '/.string/agents/default';

if (!(await ping(port))) {
  throw new Error('stringd is not running on port ' + port);
}

await ensureAgent(port, { id: agentId, home });

const result = await exec(port, agentId, 'main', '/open ./index.md');
console.log(result.ok);
console.log(result.content);
```

## Direct HTTP

```bash
curl http://127.0.0.1:3923/health

curl -N -X POST http://127.0.0.1:3923/exec \
  -H "X-Agent-Id: default" \
  -H "Content-Type: application/json" \
  -d '{"cmd": "/open index.md", "topic": "main"}'
```

The SSE response contains `head`, `content`, and `done` events. See the
[protocol spec](../reference/protocol.md) for the full schema.
