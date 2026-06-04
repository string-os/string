# @string-os/client

HTTP/SSE client for `stringd` — talk to a running String daemon from any Node.js or TypeScript program. No runtime dependencies (uses only Node's built-in `http` module).

This is the same client library that `@string-os/string`'s CLI uses internally. Extracted as a standalone package so you can write a custom tool that speaks to `stringd` without pulling in the full runtime.

## Install

```bash
npm install @string-os/client
```

## Prerequisites

You need a running `stringd` daemon. The simplest path:

```bash
npm install -g @string-os/string
string --daemon start
```

Default port is `3923`. Change with `STRING_PORT=...` in the daemon's environment.

## Usage

```typescript
import { ping, ensureAgent, exec } from '@string-os/client';

const port = 3923;
const agentId = 'default';
const home = '/home/alice/.string/agents/default';

// 1. Check the daemon is alive
const alive = await ping(port);
if (!alive) throw new Error('stringd not running on port ' + port);

// 2. Make sure the agent exists (idempotent)
await ensureAgent(port, { id: agentId, home });

// 3. Execute a command in a topic
const result = await exec(port, agentId, 'main', '/open ./README.md');

console.log(result.ok);       // true
console.log(result.code);     // null on success, error code on failure
console.log(result.content);  // the command output
console.log(result.meta);     // current document metadata or null
```

## API

```typescript
ping(port: number): Promise<boolean>
ensureAgent(port: number, agent: { id: string; home: string }): Promise<void>
exec(port: number, agentId: string, topic: string, cmd: string, requestId?: string): Promise<ExecResult>
health(port: number): Promise<{ ok: boolean; agents: number; sessions: number }>
shutdown(port: number): Promise<void>

// SSE utilities
parseSSE(raw: string): Array<{ event: string; data: string }>
sseToExecResult(raw: string): ExecResult
stripContentPrefix(raw: string): string

interface ExecResult {
  ok: boolean;
  code: string | null;
  content: string;
  meta: object | null;
}
```

## Protocol

The client speaks [stringd protocol v0.1](https://github.com/string-os/string/blob/main/docs/reference/protocol.md). If you want to implement this protocol in another language, start there — the spec is the source of truth, not this TypeScript client.

## Related

- [`@string-os/string`](https://www.npmjs.com/package/@string-os/string) — the runtime, daemon, and CLI
- [`@string-os/string`](https://www.npmjs.com/package/@string-os/string) — MCP server for Claude Code, Claude Desktop, Codex, Cursor, etc.
- [stringd protocol v0.1](https://github.com/string-os/string/blob/main/docs/reference/protocol.md)
- [SFMD spec](https://github.com/string-os/sfmd)

## License

MIT
