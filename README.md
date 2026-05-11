# String

> Markdown that runs. One file, any agent.

A `.sfmd` file is a markdown document an agent can both **read** (like Markdown) and **execute** (calls APIs, runs CLI tools, navigates pages). The same file works in any runtime that speaks the format — no per-tool server, no per-agent code.

---

## See it

A complete app, in one file:

````markdown
---
name: weather
type: app
default: now
---

# Weather

Get current conditions anywhere on Earth.

```act.now
GET https://wttr.in/{city}?format=%l:+%C+%t+%w&m
  city, -c: string (required) "City name"
```
````

Install and call:

```bash
npm install -g @string-os/string
string '/install --app ./weather.md'
string app:weather '/act.now Seoul'
# → Seoul: ☀️ +20°C ↘6km/h
```

A markdown file declared the API. The runtime called it. The agent got the result. No protocol handshake, no per-tool server, no HTML parsing.

---

## What it is

**Format.** SFMD (String Flavored Markdown) is 100% CommonMark with a few inline conventions: `[!nav:main]` for navigation menus, `[@slug]` for shortcut references, and fenced ` ```act.<id> ` blocks that declare typed callable actions (HTTP, CLI, or anything else the runtime supports).

**Runtime.** This repo ships `@string-os/string` — Browser, Session, Loader, Resolver. It loads SFMD files from `file://`, `http(s)://`, or installed packages; exposes their actions as `/act.<name>` calls; tracks per-session state; and renders results as Markdown.

**What's standardized.** A small surface that doesn't change with the resource:

- `/open` — see something (document, page, app, URL, shortcut)
- `/act` — do something (call an API, run a CLI tool, submit data)

Plus consistent rules for how state is scoped, how outputs are framed, and how errors carry recovery hints. Not a kernel — a stable, syscall-shaped surface every resource exposes the same way. [Full surface →](https://docs.string-os.org/runtime/overview/)

Different resource types get the same shape:

| Resource | Read | Act |
|---|---|---|
| Document | `/open file.md` | `/act.<name>` if defined |
| Installed app | `/open app:weather` | `/act.now --city Seoul` |
| Web URL | `/open https://docs.example.com` | (link traversal) |
| Shell session | `string bash:dev 'ls'` | (plain stdin) |

The agent learns the verbs once and uses them everywhere. New capabilities come from new documents, not new code.

---

## Try it

```bash
npm install -g @string-os/string
git clone https://github.com/string-os/cookbook.git
cd cookbook

string setup '/install --app ./apps/weather/string.md'
string app:weather '/act.now Seoul'
```

The cookbook has a dozen runnable examples — kanban over GitHub Projects, an AI social network, search, code review, k8s helpers — each a single `.sfmd` file you can read end-to-end.

### Other ways to embed the runtime

- **MCP server** (Claude Desktop, Cursor, …) — add `@string-os/string-mcp` to your MCP config
- **In-process library** — `import { Browser } from '@string-os/string'`. No daemon, no HTTP
- **HTTP daemon + any-language client** — `string --daemon start`. Wire spec in [`stringd protocol v0.1`](https://docs.string-os.org/reference/protocol/); reference TS client in `@string-os/client`

Add a feature once, it works in all four paths.

---

## How it compares

- **vs MCP.** MCP is a protocol with a custom server per tool. SFMD is a file — works over `file://`, HTTP, email, or a USB drive. An SFMD file can be *served by* an MCP server (that's what `string-mcp` does), but it isn't tied to one.
- **vs llms.txt.** `llms.txt` is a static index, read-only. SFMD is read *and* execute. Actions are first-class.
- **vs SKILL.md / agent skills.** A SKILL.md is written for one agent runtime. An SFMD file is an app surface any runtime can read and execute.

The novelty is the combination: human-readable + AI-readable without HTML parsing + AI-executable + cross-agent portable, in one Markdown primitive with a small runtime.

---

## v0.1 — what ships now

Working:

- SFMD parser, runtime, CLI, MCP server, daemon
- App / tool install from local files or HTTPS
- Action methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `CLI`
- `bash:` topics and `/exec` (opt-in)
- Cookbook with a dozen working apps

Not yet:

- Signed packages — **run SFMD files from trusted sources only**
- Fine-grained capability permissions — `/exec` and `bash:` topics are opt-in, but an installed app's own HTTP fetches and `CLI` actions run unsandboxed. Inspect before installing.

**Platform.** Tested on Linux. macOS should work — `/bin/bash` is available and CLI actions use POSIX shell features only — but isn't routinely tested yet. **Windows is not supported in 0.1.x**: the runtime spawns `/bin/bash` for every CLI action. Use WSL on Windows, or wait for portable execution in v0.2.

Trust model in [`SECURITY.md`](./SECURITY.md). The full spec for parser implementors lives in the [SFMD spec repo](https://github.com/string-os/sfmd).

---

## Packages

| Package | What |
|---|---|
| [`@string-os/core`](./packages/core) | SFMD parser, extractor, utilities |
| [`@string-os/compiler`](./packages/compiler) | Compiler and validator |
| [`@string-os/string`](./packages/string) | Runtime — Browser, Session, Loader, daemon, CLI |
| [`@string-os/client`](./packages/client) | HTTP/SSE client for `stringd` — zero deps |
| [`@string-os/string-mcp`](./packages/string-mcp) | MCP server wrapper |

---

## More

- [docs.string-os.org](https://docs.string-os.org) — full guide
- [Cookbook](https://github.com/string-os/cookbook) — runnable example apps
- [SFMD spec](https://github.com/string-os/sfmd) — format specification
- [Skill for AI agents](https://string-os.org/skill/) — written for agent self-onboarding

Contributing: [CONTRIBUTING.md](./CONTRIBUTING.md). Security: [SECURITY.md](./SECURITY.md). License: [MIT](./LICENSE).
