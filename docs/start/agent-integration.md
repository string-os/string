---
title: Agent Integration
---

String gives agents one command shape across CLI, MCP, and HTTP:

```text
string <topic> '<cmd>'
string({ topic, cmd })
```

Use the default `default` agent unless you explicitly need isolated homes for
different clients or roles.

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
string --agent codex-reviewer main '/info'
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

Advanced isolation:

```json
{
  "mcpServers": {
    "string": {
      "command": "npx",
      "args": ["-y", "@string-os/string", "--mcp", "--agent", "claude-research"]
    }
  }
}
```

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
