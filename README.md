# String

<p align="center">
  <img src="./assets/string-logo.png" alt="String" width="440" />
</p>

**An app framework and browser for AI agents.**

String unifies apps, the web, and Markdown documents into one agent-native
surface. A website can expose navigation and actions in Markdown, so an agent
can use it like an app. Ordinary web pages still open as clean Markdown.
Installed apps, local documents, web pages, files, APIs, and shell sessions all
use the same commands.

The core loop is intentionally small:

```text
/open  read a document, app, web page, file, or shell session
/act   call an available action
/info  understand where you are
```

String can run as a CLI, a daemon, or one MCP tool named `string`. The agent
learns one surface and uses it everywhere.

Available String apps are maintained at
[github.com/string-os/apps](https://github.com/string-os/apps).

---

## Why

Most agent integrations grow the agent's context: another tool schema, another
API manual, another set of examples. String moves that knowledge into the app
or page itself.

An agent opens a page, sees what actions are available, calls one, and follows
the next hint. The page may be a local Markdown file, an installed app, an
agent-native website, or a normal website rendered as Markdown. The interaction
is the same.

What changes:

- **Apps and web share one model.** A String app and an agent-native web page
  expose the same surface: Markdown content, navigation, actions, state, and
  hints.
- **One browser for agent work.** `/open`, `/act`, `/info`, and topics work the
  same for documents, apps, web pages, files, APIs, and shell sessions.
- **Self-discovery.** Actions expose schemas with `/act --help`; responses carry
  `next:` hints; errors carry recovery hints.
- **Local command boundary.** Web-hosted SFMD can call web APIs, but local shell
  commands run only from local files or locally installed apps.
- **Agent event inbox.** Local webhooks can deliver text events to an agent,
  which reads and acknowledges them through the same CLI/MCP surface, or
  receives as a Claude Code channel notification.
- **Credentials stay scoped.** App secrets are set inside app topics with
  `/set $VAR = "..."`, not pasted into the agent's prompt.
- **Portable by default.** A String surface is Markdown. It can live in a file,
  an installed package, a GitHub repo, or on the web.

String calls this format **SFMD**: String Flavored Markdown. It is normal
Markdown plus lightweight navigation, action blocks, and response conventions.

---

## One Surface

No SDK. No endpoint memorized. The surface tells the agent what it can do.

Open a web page as Markdown:

```bash
string main '/open https://docs.string-os.org/runtime/mcp'
```

Open an installed app and follow its actions:

```bash
string app:moltbook '/open'
# [actions] home, feed, read, comment, post, search
# next: /act.feed · /act.search "..."

string app:moltbook '/act.feed'
# Feed: @post-1 through @post-20
# next: /act.read @post-N

string app:moltbook '/act.read @post-3'
# ...post body...
# next: /act.comment @post "..."
```

The same interaction over MCP is one tool call:

```json
{ "topic": "app:moltbook", "cmd": "/act.read @post-3" }
```

---

## Install

### Claude Code Plugin

```text
/plugin marketplace add string-os/string
/plugin install string@string-os
```

This installs the String MCP tool and a short skill for using it. The tool is
registered as server `string` and exposes one tool named `string`.

For multiple local agents or workspace-specific homes, see
[Agent Identity](./docs/start/agent-identity.md).

### Codex Plugin

```bash
codex plugin marketplace add string-os/string
codex plugin add string@string-os
```

### CLI

```bash
npm install -g @string-os/string
string --help
```

The daemon starts automatically on first use. Default port: `3923`.

---

## Basic CLI

```bash
string main '/open ./README.md'
string main '/open https://docs.string-os.org/runtime/mcp'
string app:weather '/act.now Seoul'
string bash:dev 'pwd && ls'
```

Topics scope state:

| Topic | Use |
|---|---|
| `main`, `notes`, `research` | free-form document/web sessions |
| `app:<name>` | installed app session |
| `app:<name>:<config>` | app session with config-scoped env |
| `bash:<name>` | persistent shell session |
| `app`, `tool`, `bash`, `event`, `system`, `agent` | hub topics for runtime views and management |

Hub topics are reserved. Open them to inspect runtime state, or send
management commands through their hub:

```bash
string app            # installed apps + active app sessions
string event          # event inbox + local webhook URL
string system status
string agent list
```

Every response is wrapped so an agent can separate String output from shell
noise:

```text
<𝒞=string:main>
...
</𝒞>
```

---

## MCP

String serves MCP directly. No separate MCP package is needed.

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

The MCP tool takes:

```json
{ "topic": "main", "cmd": "/info" }
```

For local webhook event delivery into Claude Code Remote Control channels, see
[Events and Local Webhooks](./docs/runtime/events.md).

Use `/help`, `/info`, and `/act --help` to discover what is available.

---

## Surfaces, Not SDKs

A String surface can be:

- a local Markdown document
- an installed app
- a web page that exposes Markdown navigation and actions
- an ordinary web page rendered as Markdown
- a shell session or file workspace

The agent uses the same commands either way. When a surface includes SFMD action
blocks, it becomes executable.

````markdown
---
name: weather
type: app
default: now
---

# Weather

```act.now
GET https://wttr.in/{city}?format=%l:+%C+%t+%w&m
  city, -c: string (required) "City name"
```
````

Install that file as an app and call it:

```bash
string main '/install --app ./weather.md'
string app:weather '/act.now Seoul'
```

The Markdown is the interface. The runtime handles discovery, argument parsing,
execution, output framing, state, and credentials.

---

## Docs

- [Documentation](https://docs.string-os.org)
- [Agent Identity](./docs/start/agent-identity.md)
- [MCP](./docs/runtime/mcp.md)
- [Runtime Overview](./docs/runtime/overview.md)
- [SFMD Overview](./docs/sfmd/overview.md)
- [Cookbook](https://github.com/string-os/cookbook)

## Packages

- `@string-os/string` — CLI, daemon, MCP server, runtime
- `@string-os/client` — HTTP/SSE client for `stringd`
- `@string-os/core` — SFMD parser
- `@string-os/compiler` — SFMD validator/compiler

## License

MIT
