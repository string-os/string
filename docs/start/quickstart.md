---
title: Quick Start
---

Get from `npm install` to running a real String app in five minutes.

## 1. Install

```bash
npm install -g @string-os/string
string --help
```

Requires Node.js 20+. The daemon (`stringd`) auto-starts on first call — no
manual start needed.

## 2. Your first app

Clone the cookbook (a collection of working String apps) and install one:

```bash
git clone https://github.com/string-os/cookbook.git
cd cookbook

string '/install --app ./apps/weather/string.md'
string app:weather '/act.now Seoul'
# → Seoul: ☀️ +20°C ↘6km/h
```

That's the loop: **clone → install → call**. A String daemon started, the
weather app got copied under `~/.string/agents/default/packages/weather/` and
registered, and your `/act.now` ran an HTTP `GET` declared in a Markdown file.

## 3. Open a document

```bash
string main '/open ./apps/weather/string.md'
```

The runtime renders the app body as clean Markdown and prepends an
`[actions] now, forecast, search · /act --help (all) · /act.<name> --help`
line — the action menu an AI agent discovers automatically.

For a URL:

```bash
string docs '/open https://example.com'
```

String fetches the page, converts HTML to Markdown, and auto-generates
`@`-shortcuts for the links it found so the agent can navigate without
re-pasting URLs.

## 4. Apps that need credentials

Some apps declare required env vars in frontmatter:

```yaml
---
requires: [REPO]
---
```

When you `/open` such an app with the var unset, the response starts with a
`[!] Missing required env: $REPO` hint. Set it from the app's session —
**persistent env is app-scoped**, so a secret you `/set` for one app never
leaks into another:

```bash
string '/install --app ./apps/gh-issue/string.md'
string app:gh-issue '/set $REPO = "string-os/string"'
string app:gh-issue /act.repo
```

For region- or account-specific keys, use a config sub-topic. They cascade
`app:<name>:<config>` → `app:<name>`:

```bash
string 'app:weather:korea' '/set $WEATHER_API_KEY = "..."'
string 'app:weather:usa'   '/set $WEATHER_API_KEY = "..."'
```

## 5. Discover what's running

```bash
string main /topics       # every active session, with the current doc
string app /open          # installed apps + active app sessions
string system /open       # daemon stats, sessions count, env-store hints
```

The four hub topics — `app`, `bash`, `tool`, `system` — aggregate over their
kind. Use them when you're not sure what's installed or which session is
where.

## Where to go next

- [**Writing your first app**](./writing-an-app.md) — author your own SFMD
  app, end-to-end: response templates, credentials, multi-file layout,
  output conventions.
- [**Agent integration**](./agent-integration.md) — embed the runtime four
  ways: CLI (what you just used), MCP server (Claude Desktop, Cursor),
  TypeScript library, HTTP daemon with any-language clients.
- [**Cookbook**](https://github.com/string-os/cookbook) — runnable examples:
  weather, an AI social network (moltbook), GitHub issue triage, Kanban
  over GitHub Projects, semantic search.
- [**SFMD spec**](https://github.com/string-os/sfmd) — the format spec, for
  parser implementors.
