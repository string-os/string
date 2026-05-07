# String

**HTML for humans, SFMD for agents.**

A markdown format and runtime that lets AI agents read and execute apps as portable documents.

---

## Why now

AI agents have started doing real autonomous work — reading, navigating, deciding, executing. But the infrastructure they operate on was designed for humans: HTML rendered for visual parsing, apps built around click journeys, docs optimized for skim-reading. Agents parse all of it indirectly, slowly, and expensively.

SFMD is a bet that giving agents a surface designed for *them* — a portable document format that is simultaneously human-readable, AI-readable without HTML parsing, and AI-executable via inline action commands — makes agent work cheaper and more reliable. We don't have the cost/quality numbers yet. We will publish them as the research matures. In the meantime, the format, the runtime, and the cross-agent portability demo let you see the shape of the bet for yourself.

---

## See it in 20 lines

This is a real SFMD file. It renders as readable Markdown for humans, and an AI agent reading it can navigate the three link styles and invoke the two actions without any custom integration.

```markdown
# 🌤️ Weather Dashboard
**Location:** Suwon-si, Gyeonggi-do **Status:** Live (Last Updated: 14:19 KST)

### 🌡️ Current Conditions
- **Temperature:** 18°C (Feels like 17°C)
- **Weather:** Partly Cloudy ⛅
- **Humidity:** 45%
- **Wind:** 3 m/s (NW)

### 📌 Navigation
- [Hourly Forecast for today][@link-1]   (auto shortcut)
- [7-Day Extended Forecast][@link-2]
- [Saved city][@saved_city]              (named shortcut)
- [App configurations](./settings.md)    (relative path)

### ⚡ Quick Actions
**1. Search for a different city:** `/act.search_city --name "{City Name}"`
**2. Set a Custom Weather Alert:** `/act.create_alert --condition "{rain|snow|temp}"`
```

One file. Live data. Three link styles. Typed action commands. No HTML parsing, no protocol handshake, no per-agent custom code.

---

## Quick Start

```bash
npm install -g @string-os/string
echo '# Hello, SFMD' > /tmp/hello.md
string file:hello '/open /tmp/hello.md'
```

Full guide: [docs.string-os.org/start/quickstart](https://docs.string-os.org/start/quickstart/).

### As an MCP server (Claude Desktop, Cursor, etc.)

Add to your MCP config:

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

### As an in-process library

Use the runtime directly, no daemon.

```typescript
import { Browser } from '@string-os/string';

const browser = new Browser({ home: process.cwd() });
const result = await browser.exec('/open ./index.md');
console.log(result.content);
```

### As a client library (talk to a running daemon)

If you already have `stringd` running — started by the CLI, by another process, or by a team service — you can talk to it from any Node.js program with `@string-os/client`. No runtime deps, only Node's built-in `http`.

```typescript
import { ping, ensureUser, exec } from '@string-os/client';

const port = 3100;
const userId = 'default';

if (!(await ping(port))) throw new Error('stringd is not running');

await ensureUser(port, { id: userId, home: process.env.HOME + '/.string/users/default' });

const result = await exec(port, userId, 'file:main', '/open ./README.md');
console.log(result.ok);       // true
console.log(result.content);  // the rendered document
console.log(result.meta);     // current document metadata
```

This is the same client the CLI uses internally. It speaks the [stringd protocol v0.1](https://docs.string-os.org/reference/protocol/), which is the source of truth for any other-language client (Python, Go, etc.).

---

## Security model (v0.1)

String OS ships with a restrictive default action allowlist. Only `read`, `write_artifact`, `checklist`, `handoff`, and `fetch` are enabled by default. `bash:` sessions and `/exec` are opt-in and require explicit configuration. SFMD files are not signed in v0.1 — **run SFMD files from trusted sources only.** Fine-grained permissions and signed packages land in v0.2.

See [`spec/trust-and-execution-v0.1.md`](https://github.com/string-os/sfmd/blob/main/spec/trust-and-execution-v0.1.md) in the SFMD spec repo for the full trust and execution model.

---

## Why not MCP / llms.txt / SKILL.md?

The question you should ask. SFMD is a deliberate synthesis of prior art, not a replacement for any single piece.

**vs MCP (Model Context Protocol):**
- MCP is a protocol with servers; SFMD is a file. An SFMD file works over HTTP, `file://`, email, or a USB drive.
- MCP requires a custom server per tool; SFMD declares actions inline in the document.
- SFMD can be used *by* an MCP server (that's what `@string-os/string-mcp` does), but it is not tied to MCP.

**vs llms.txt:**
- `llms.txt` is a static index for documentation. Read-only.
- SFMD is read *and* execute. Actions are first-class.
- An SFMD file can include an `llms.txt`-style navigation section and also invoke an API.

**vs SKILL.md / agentskills.io:**
- SKILL.md is an instruction bundle for one agent runtime.
- SFMD is an *app surface* that any runtime can read. The same file runs across Claude, OpenClaw, and other agents with zero per-agent code.
- A SKILL.md author writes for Claude. An SFMD author writes for agents-in-general.

The defensible novelty is the combination: human-readable + AI-native readable + AI-executable + cross-agent portable + renderable, all in one markdown primitive with a small runtime.

---

## Cross-agent portability

The central claim of SFMD is that one file runs in multiple agents with semantically equivalent behavior. See the [cookbook portability walkthrough](https://github.com/string-os/cookbook/blob/main/07-portability.md) for a step-by-step demonstration: one `weather-dashboard.sfmd` file executed via the String CLI, Claude Desktop (through `string-mcp`), and one additional agent — with captured outputs for each.

---

## How it works

**Context is text.** String presents all content as Markdown — the format AI understands best. SFMD (String Flavored Markdown) adds lightweight extensions for navigation, block addressing, and actions while remaining 100% CommonMark compatible.

**Actions are commands.** Two primitives cover nearly everything:

- `/open` — see something (a document, a page, a shortcut)
- `/act` — do something (call an API, run a CLI tool, submit data)

New capabilities come from new documents, not new code.

## Architecture

```
                     @string-os/string (runtime package)
                     ─────────────────────────────────────
                     Browser  Session  Loader  Resolver
                            ▲                ▲
                            │                │
                            │       ┌────────┴────────┐
                            │       │    stringd       │  ◄── daemon (HTTP)
                            │       └────────┬────────┘
                            │                │
                            │                ▼
                            │     ┌─────────────────────┐
                            │     │  @string-os/client  │  ◄── HTTP/SSE client
                            │     │  (stringd protocol) │      standalone, no deps
                            │     └──────────┬──────────┘
                            │                │
              ┌─────────────┴────┐      ┌────┴────┐
              │                  │      │         │
       Library import    MCP Server    CLI    Any client
        (in-process)     (string-mcp)  (string)  (TS, Python...)
```

Four integration paths, one runtime:

1. **In-process library** — `import { Browser } from '@string-os/string'`. No daemon, no HTTP. Best for tight integration like MCP.
2. **MCP server** — `@string-os/string-mcp` wraps the in-process Browser for Claude Desktop, Cursor, and any MCP-aware client.
3. **CLI** — `string file:main '/open ./doc.md'`. The CLI is itself an `@string-os/client` consumer that talks to a local `stringd` daemon.
4. **Custom client** — any program in any language that speaks the [stringd protocol v0.1](https://docs.string-os.org/reference/protocol/). `@string-os/client` is the reference TypeScript client; Python and other-language clients follow the same wire spec.

Add a feature once, it works everywhere.

## Packages

| Package | Description |
|---------|-------------|
| [`@string-os/core`](./packages/core) | SFMD parser, extractor, and utilities |
| [`@string-os/compiler`](./packages/compiler) | Document compiler and validator |
| [`@string-os/client`](./packages/client) | HTTP/SSE client for stringd — standalone, zero runtime deps |
| [`@string-os/string`](./packages/string) | String runtime — Browser, Session, Loader, daemon, CLI |
| [`@string-os/string-mcp`](./packages/string-mcp) | MCP server for AI agent integration |

## CLI usage

```bash
# Topic mode (auto-starts daemon)
string file:main '/open ./index.md'
string app:weather '/act.forecast --city "Seoul"'
string web:docs '/open https://docs.example.com'

# Daemon mode
string daemon                    # Start daemon (port 3100)
string daemon --log 4000         # Enable logging, custom port
```

### Apps vs Tools

**App** — has its own view and session. You enter it with `/open app:name` and explore its pages. Think: a website you visit.

**Tool** — no view of its own. You call it with `/tool:name` and it runs in your current context, returning output. Think: a shell command.

Both are `.md` files with action blocks. The difference is how they're accessed, not how they're written. See [Tools guide](https://docs.string-os.org/runtime/tools/) for details.

### Topic types

| Topic | Description | Examples |
|--------|-------------|----------|
| `file:name` | File-based session | `file:main`, `file:work` |
| `app:name` | Installed app | `app:weather`, `app:gmail:work` |
| `web:name` | Web document session | `web:docs` |
| `bash:name` | Shell session (PTY, opt-in) | `bash:dev` |

### Commands

| Command | Description |
|---------|-------------|
| `/open <topic>` | Open a document, URI, `@shortcut`, or `file.md#block` |
| `/act[.name] [--flags]` | Execute an action (list all if no name) |
| `/write <path>` | Create or overwrite a file |
| `/edit <path>[#block]` | Edit a file or block (shows diff) |
| `/ls [path]` | List files and directories |
| `/nav [menu]` | Navigate menus and shortcuts |
| `/info` | Show document/session status |
| `/back` | Go back in history |
| `/tool:name [args]` | Run a tool |
| `/set {var} = "value"` | Set session variable |
| `/set $VAR = "value"` | Set persistent variable |

## Writing apps

An app is a single `.md` file with action definitions. Any AI agent can fetch and use it:

````markdown
---
name: git
default: run
---

Run git commands.

```act.run
CLI git $ARGS
```
````

See the [Writing your first app guide](https://docs.string-os.org/start/writing-an-app/) for more.

## Documentation

Full docs at **[docs.string-os.org](https://docs.string-os.org)**. The Markdown source lives at [`docs/`](./docs/) in this repo and is built into the site by [`apps/docs/`](./apps/docs/).

- [Quick Start](https://docs.string-os.org/start/quickstart/)
- [Agent Integration](https://docs.string-os.org/start/agent-integration/)
- [Writing your first app](https://docs.string-os.org/start/writing-an-app/)
- [Runtime](https://docs.string-os.org/runtime/overview/) — design, model, and runtime behavior
- [stringd protocol v0.1](https://docs.string-os.org/reference/protocol/) — wire protocol for any-language clients
- [SFMD Spec](https://docs.string-os.org/sfmd/overview/) — format specification for parser implementors
- [Cookbook](https://github.com/string-os/cookbook) — practical examples

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and guidelines. Typo and doc fixes welcome immediately. Spec changes go through an issue-first discussion in the [SFMD spec repo](https://github.com/string-os/sfmd).

## Security

See [SECURITY.md](./SECURITY.md) for how to report vulnerabilities responsibly.

## License

[MIT](./LICENSE)
