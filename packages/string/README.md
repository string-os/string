# @string-os/string

String runtime — an OS for AI agents, built on SFMD. HTML for humans, SFMD for agents.

Browse documents, install apps, execute actions, navigate the web — all through Markdown. Drives a long-running daemon (`stringd`) so multiple agent calls share session state, history, and authentication.

## Install

```bash
npm install -g @string-os/string
```

This installs three things:
- `string` — CLI you call from a shell or an agent's shell tool
- `stringd` — daemon that backs the CLI (auto-started; manage with `string --daemon`)
- a Node library if you want to embed the runtime instead of shelling out

## CLI

The basic shape is `string <topic> '<command>'`. A topic is one of:

- a bare name (`main`, `notes`, `setup`) — a free-form session for ad-hoc work
- `app:<pkg>[:<config>]` — an installed app session (e.g. `app:weather`)
- `bash:<name>` — a persistent shell session (each name = its own pty)
- `app`, `bash`, `tool`, `system` — hub topics that aggregate / manage their kind

```bash
# Install an app from a local file or URL
string setup '/install --app ./apps/weather/string.md'

# Open the app and call its actions
string app:weather '/open app:weather'
string app:weather '/act.now Seoul'
string app:weather '/act.forecast Tokyo'

# Open a web page in a free-form tab (rendered as Markdown)
string docs '/open https://developer.mozilla.org'

# Bash session
string bash:dev 'cd ~/work && ls'

# Hub view — aggregates installed apps, current sessions, etc.
string app

# REPL mode — drop the command argument
string app:weather
```

Output is wrapped in a short envelope so a calling program can tell runtime output apart from shell noise:

```
<𝒞=string:app:weather>
seoul: Sunny +20°C ↘6km/h
</𝒞>
```

Use `--json` for `{ok, code, content, meta}` JSON instead.

## Daemon

The daemon starts automatically on first call. Manage it explicitly with:

```bash
string --daemon start
string --daemon status
string --daemon stop
```

Default port is `3923` (override with `STRING_PORT`). Sessions, env vars, and installed apps live under `~/.string/agents/{agent}/`.

## Library

```typescript
import { Browser } from '@string-os/string';

const browser = new Browser({ home: process.cwd() });
const result = await browser.exec('/open ./README.md');
console.log(result.ok, result.content);
```

For talking to an already-running daemon from another language or process, use [`@string-os/client`](https://www.npmjs.com/package/@string-os/client) instead — it's lighter and has zero runtime dependencies.

## Using from an agent

Any agent framework with a shell tool (Claude Code, OpenClaw, etc.) can drive `string` with no custom integration. One paragraph in the prompt is enough:

> You have `string` installed. It's a Markdown browser with installable apps. Call it as `string <topic> '<command>'`. Output sits between `<𝒞=string:topic>` and `</𝒞>`. To find what an app can do: `/open app:<name>`. Currently installed: `weather`.

For MCP clients (Claude Desktop, Cursor, Codex), run `string --mcp` as the stdio server, or point them at `http://localhost:3923/mcp`. `stringd` serves MCP natively — no separate package. For multiple AI sessions, map homes once with `string agent add <id> --home <path>`, then select the agent with `STRING_AGENT_ID=<id>` or `string agent use <id> --local`.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `STRING_PORT` | `3923` | Daemon listen port |
| `STRING_AGENT_ID` | `default` | Agent identity for advanced isolation |
| `STRING_HOME` | `~/.string/agents/{agent}` | One-shot home override; prefer `string agent add <id> --home <path>` for normal use |
| `STRING_CONFIG` | nearest `.string/config.json`, then `~/.string/config.json` | Force a specific client config file |

`/set $VAR = "value"` persists vars to disk under the current scope (global, app, or app:config). Apps declare what they need with `requires:` in frontmatter; missing values surface as a hint at `/open` time.

## Documentation

- [Source and full docs](https://github.com/string-os/string)
- [SFMD spec](https://github.com/string-os/sfmd)
- [Cookbook (apps and tutorials)](https://github.com/string-os/cookbook)

## Related

- [`@string-os/core`](https://www.npmjs.com/package/@string-os/core) — SFMD parser
- [`@string-os/client`](https://www.npmjs.com/package/@string-os/client) — daemon HTTP/SSE client
- [`@string-os/compiler`](https://www.npmjs.com/package/@string-os/compiler) — SFMD validator and compiler

## License

MIT
