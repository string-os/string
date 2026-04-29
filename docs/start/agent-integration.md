---
title: Agent Integration
---

# Agent Integration

String provides four ways for AI agents to interact with documents and skills. Pick the one that matches how your agent runs.

## 1. CLI Pipe

Best for: shell scripts, simple automation, AI agents with command execution.

```bash
# Topic mode: string <topic> '<command>'
string file:main '/open ./index.md'
string file:main '/act.search --query "hello"'
string app:weather '/act.forecast --city "Seoul"'
```

The CLI auto-starts a daemon process. Multiple commands share the same session state.

### Topic Types

| Topic | Use Case |
|--------|----------|
| `file:name` | Local file browsing and editing |
| `app:name` | Installed SFMD apps |
| `web:name` | Web browsing (HTML → Markdown) |
| `bash:name` | Interactive shell sessions |

### Environment Variables

```bash
export STRINGD_PORT=3100    # Daemon port (default: 3100)
export STRINGD_USER=default # User ID
export STRINGD_HOME=~       # Home directory
```

## 2. MCP Server

Best for: Claude Desktop, Cursor, and other MCP-compatible AI clients.

### Setup

```json
{
  "mcpServers": {
    "string": {
      "command": "npx",
      "args": ["@string-os/string-mcp"]
    }
  }
}
```

### Available Tools

| Tool | Maps to | Description |
|------|---------|-------------|
| `string_open` | `/open` | Open a document, URL, or directory |
| `string_act` | `/act` | Execute an action |
| `string_exec` | `/exec` | Run a shell command |
| `string_ls` | `/ls` | List files and directories |
| `string_nav` | `/nav` | Navigate shortcuts and menus |
| `string_info` | `/info` | Get session state |
| `string_write` | `/write` | Write content to a file |

Each tool wraps the corresponding String command. The MCP server creates a single Browser instance and routes tool calls through it.

## 3. TypeScript Library

Best for: custom agents, embedded use, programmatic control.

```typescript
import { Browser } from '@string-os/string';

// Create a browser with a home directory
const browser = new Browser({
  home: '/path/to/workspace',
  allowHttp: true,
});

// Execute commands
const result = await browser.exec('/open ./index.md');
console.log(result.ok);       // true
console.log(result.content);   // Rendered document

// Work with multiple sessions
await browser.exec('/open ./app.md', 'app:myapp');
await browser.exec('/act.fetch --query "test"', 'app:myapp');

// Session management
browser.listSessions();         // ['main', 'app:myapp']
browser.switchSession('main');
browser.closeSession('app:myapp');
```

### Key Classes

| Class | Purpose |
|-------|---------|
| `Browser` | Top-level entry point. Manages sessions and loader. |
| `Session` | Single browsing session with history, variables, and state. |
| `Loader` | Loads documents from file:// and http:// URIs. |

### Loader Options

```typescript
const browser = new Browser({
  home: '/workspace',
  allowHttp: true,           // Enable web fetching (default: true)
  accessMode: 'workspace',   // Restrict file access to home directory
  htmlToMarkdown: customFn,  // Custom HTML→Markdown converter
});
```

## 4. Daemon Client (`@string-os/client`)

Best for: custom Node.js programs that want to talk to a running `stringd` without pulling in the full runtime, and as a reference for implementing the protocol in other languages.

```typescript
import { ping, ensureUser, exec } from '@string-os/client';

const port = 3100;
const userId = 'default';
const home = process.env.HOME + '/.string/users/default';

if (!(await ping(port))) {
  throw new Error('stringd is not running on port ' + port);
}

await ensureUser(port, { id: userId, home });

const result = await exec(port, userId, 'file:main', '/open ./index.md');
console.log(result.ok);       // true on success
console.log(result.code);     // null on success, string error code on failure
console.log(result.content);  // the command output
console.log(result.meta);     // current document metadata or null
```

No runtime dependencies — the client uses only Node's built-in `http` module.

The CLI itself is built on `@string-os/client`. If you wrote `cli.ts` from scratch using this package, the result would be nearly identical.

### Protocol

`@string-os/client` speaks the [stringd protocol v0.1](./stringd-protocol-v0.1.md). That document is normative and is the source of truth for any other-language client. Planned clients include:

- **Python** (`string-os` on PyPI, in progress) — for Python-based agents and shell tools
- Other languages welcome — open an issue if you implement one

### Direct HTTP

You can also talk to `stringd` with any HTTP client and no SDK:

```bash
# Health check
curl http://localhost:3100/health

# Execute a command (SSE response)
curl -N -X POST http://localhost:3100/exec \
  -H "X-User-Id: default" \
  -H "Content-Type: application/json" \
  -d '{"cmd": "/open index.md", "topic": "file:main"}'
```

The SSE response contains `head`, `content`, and `done` events. See the [protocol spec](./stringd-protocol-v0.1.md) for the full schema.
