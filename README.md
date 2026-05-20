# String

> The web gave humans a universal surface for information.
> SFMD gives AI agents one for work.

AI agents today read web pages designed for humans, parse JSON from per-tool servers, and memorize per-skill protocols. The infrastructure was built for someone else. They cope because they're capable — but the cost is paid in tokens, latency, and security promises that don't hold under pressure.

**SFMD** (String Flavored Markdown) is one Markdown format an agent can both *read* (like documentation) and *execute* (calls APIs, runs CLI tools, navigates pages). **String** is the reference runtime: one tool, one call shape — the entire surface.

> **AI agents reading this:** the [skill](./skill.md) is written for you. Execute it and you'll be using String in a couple of minutes.
> **Humans:** read on.

---

## What an agent sees

Three commands. Zero prior documentation read. The agent ends up reading a post in a social network app it has never seen.

```bash
$ string app:moltbook /open
> Opened. [actions] home, feed, read, comment, post, search, ...
> next: /act.read @post-N · /act.feed · /act.search "..."

$ string app:moltbook /act.feed
> Feed (hot): 20 posts. @post-1 through @post-20 registered.

$ string app:moltbook /act.read @post-3
> the curator is the lawmaker — by Starfish in /general
> (post body)
> next: /act.upvote @post · /act.comment @post "..."
```

No SDK installed. No API key in the agent's context. No endpoint memorized. Each response tells the agent what it can do next — the same way a human app does.

## What an author writes

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

A Markdown file declared the API. The runtime called it. The agent got the result. The file is the deliverable.

---

## What you get

**Scales without growing context.** Most tool integrations add to the agent's context with each new tool — docs, schemas, examples. With String, the same small surface (`/open`, `/act`, `/info`) covers every installable app. Adding apps doesn't grow what the agent has to know.

**Credentials kept out of the agent's context.** API keys live in app-scoped environment variables — the agent doesn't see them, so direct exfiltration through prompt injection on the agent isn't a path. (The app running an action still has the key; v0.1 doesn't sandbox an installed app's HTTP/CLI calls — see "Not yet" below.)

**Self-discoverable.** Every response carries a `next:` hint. Errors carry `Recovery:` lines. `/info` shows where you are; `/act --help` lists what you can do. Agents onboard onto unknown apps without prior documentation.

**Portable.** The same `.sfmd` file works in any runtime that speaks the format — CLI, MCP server, in-process library, HTTP daemon. Tomorrow, anything that parses CommonMark.

---

## How it works

Three layers, cleanly separated:

```
String OS         ← execution, navigation, state, trust
  ↑
SFMD              ← structure, references, declarations (no execution)
  ↑
CommonMark        ← base syntax
```

The same shape SFMD wears in HTML's role for the browser. Format and runtime are decoupled — any runtime can read SFMD, just as any browser can render HTML.

**Two verbs.** A small surface that doesn't change with the resource:

- `/open` — see something (document, page, app, URL, shortcut). Pure read.
- `/act` — do something (call an API, run a CLI tool, submit data). Side effects.

The separation is load-bearing. `/open` never executes; `/act` always does. An agent reading a feed never accidentally posts. [Full surface →](https://docs.string-os.org/runtime/overview/)

**Same shape, any resource.**

| Resource | Read | Act |
|---|---|---|
| Document | `/open file.md` | `/act.<name>` if defined |
| Installed app | `/open app:weather` | `/act.now --city Seoul` |
| Web URL | `/open https://docs.example.com` | (link traversal) |

The agent learns the verbs once and uses them everywhere. New capabilities come from new documents, not new code.

**Shortcuts let authors keep URLs in the runtime.** A markdown link in SFMD can reach the agent as `[Documentation][@docs]` instead of `[Documentation](https://example.com)` — useful when output flows back into the agent's context (e.g. spoofed-domain tricks like `g1thub.com` displayed as `github.com`). It's an authoring pattern, not a runtime invariant: direct `/open <url>` still puts the URL in the agent's view.

---

## Install

**Option A — npm (recommended)**

```bash
npm install -g @string-os/string
string --help
```

Requires Node.js 20+. The `stringd` daemon launches automatically on first use.

**Option B — from source**

For contributors, or to run the latest unreleased code. Requires Node.js 20+ and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/string-os/string.git
cd string
pnpm install
pnpm -r --filter "./packages/*" build      # build the packages → dist/
```

Run the built CLI:

```bash
node packages/string/dist/cli.js --help
```

Or run straight from TypeScript, no build step (handy while developing):

```bash
npx tsx packages/string/src/cli.ts --help
```

To expose it as `string` on your PATH, link the built bin — e.g. `cd packages/string && npm link`, or a shim that runs `node /abs/path/to/string/packages/string/dist/cli.js "$@"`.

---

## Try it

```bash
npm install -g @string-os/string
git clone https://github.com/string-os/cookbook.git
cd cookbook

string setup '/install --app ./apps/weather/string.md'
string app:weather '/act.now Seoul'
```

The cookbook has a dozen runnable examples — Kanban over GitHub Projects, an AI social network, semantic search, code review, k8s helpers — each a single `.sfmd` file you can read end-to-end. These aren't toy demos; they're how real apps look in SFMD.

---

## Four ways to embed

- **CLI** — `string '/open something'`. The default; what you just ran.
- **MCP server** (Claude Desktop, Cursor, …) — `string --mcp` (stdio) or point a client at `http://localhost:3100/mcp` (HTTP). One MCP tool, `string({topic, cmd})`, wraps the entire command surface.
- **In-process library** — `import { Browser } from '@string-os/string'`. No daemon, no HTTP.
- **HTTP daemon + any-language client** — `string --daemon start`. Wire spec at [`stringd` protocol v0.1](https://docs.string-os.org/reference/protocol/); reference TS client in `@string-os/client`.

Add a feature once — it works in all four paths.

---

## How it compares

| | What it is | What enters the agent's context |
|---|---|---|
| **SFMD via String** | Markdown app + small runtime | One surface, regardless of app count |
| **MCP** | Protocol with per-tool server | Tool list + per-tool schemas (credentials depend on the server's design) |
| **llms.txt** | Static read-only index | URL list. No execution. |
| **SKILL.md / agent skills** | Per-runtime instruction file | One instruction set per tool, per runtime |

The structural differences matter more than the protocol differences:

- **vs MCP.** Many MCP setups end up surfacing credentials or auth'd schemas in the agent's tool context. SFMD apps in String default to app-scoped env vars — credentials don't pass through the agent. The app itself still uses the key, so app trust still matters in v0.1.
- **vs llms.txt.** Read-only. SFMD declares executable actions as first-class.
- **vs SKILL.md.** A skill is per-agent-runtime instruction. An SFMD file is a portable app surface — any runtime that speaks SFMD can use it. One surface covers every installable app, not one set of instructions per app per runtime.

The novelty is the combination: human-readable + AI-readable without HTML parsing + AI-executable + cross-agent portable, in a single Markdown primitive with a small runtime.

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

**Platform.** Tested on Linux. macOS should work (`/bin/bash` available, POSIX shell only) but isn't routinely tested. **Windows is not supported in 0.1.x**: the runtime spawns `/bin/bash` for every CLI action. Use WSL on Windows, or wait for portable execution in v0.2.

Trust model in [`SECURITY.md`](./SECURITY.md). Full spec for parser implementors in the [SFMD spec repo](https://github.com/string-os/sfmd).

---

## Packages

| Package | What |
|---|---|
| [`@string-os/core`](./packages/core) | SFMD parser, extractor, utilities |
| [`@string-os/compiler`](./packages/compiler) | Compiler and validator |
| [`@string-os/string`](./packages/string) | Runtime — Browser, Session, Loader, daemon (HTTP/SSE + MCP), CLI, stdio MCP shim |
| [`@string-os/client`](./packages/client) | HTTP/SSE client for `stringd` — zero deps |

---

## The bet

The web of pages, JS-hydrated SPAs, and per-tool MCP servers — none of it was designed for agents. They use it anyway because models got good enough to brute-force through bad UX. That works until apps multiply, tasks chain, and adversaries probe; then the hidden tax compounds.

SFMD is the bet that agents deserve the same thing humans got: a universal, discoverable surface where the format is the API, the document is the app, and the cost of trying a new thing is one `/open`.

---

## More

- [docs.string-os.org](https://docs.string-os.org) — full guide
- [Cookbook](https://github.com/string-os/cookbook) — runnable example apps
- [SFMD spec](https://github.com/string-os/sfmd) — format specification
- [Skill for AI agents](./skill.md) — written for agent self-onboarding

Contributing: [CONTRIBUTING.md](./CONTRIBUTING.md). Security: [SECURITY.md](./SECURITY.md). License: [MIT](./LICENSE).
