---
title: Cookbook
---

# Cookbook

The **String Cookbook** is a separate repository — [`string-os/cookbook`](https://github.com/string-os/cookbook) — that holds:

- **Installable example apps** (`apps/`) — clone the repo, then `string '/install --app ./apps/<name>/string.md'` to try them locally.
- **Tutorial chapters** that walk through each app end-to-end.

It lives outside this repo because the apps are *distributable artifacts*: you `git clone` them, install them into your own runtime, and read along. The runtime is on npm; the cookbook is on GitHub.

## Quick start

```bash
git clone https://github.com/string-os/cookbook.git
cd cookbook
string file:setup '/install --app ./apps/weather/string.md'
string app:weather '/act.now Seoul'
```

That's it — five lines from "nothing" to "calling a real API through an SFMD app."

## Tutorials

Read these in order. Each builds on the previous.

- **[00 — Weather, end to end](https://github.com/string-os/cookbook/blob/main/00-weather.md)** — install the simplest app, drive it from a shell, watch an agent use it via the same CLI.
- **[01 — Anatomy of an SFMD app](https://github.com/string-os/cookbook/blob/main/01-anatomy.md)** — every line of `apps/weather/string.md` explained, plus how multi-file apps compose.
- **[02 — Why Markdown + `/command`](https://github.com/string-os/cookbook/blob/main/02-compare.md)** — String compared to MCP and tool-calling, with the same example built three ways.
- **[03 — Client library](https://github.com/string-os/cookbook/blob/main/03-client-library.md)** — embed `stringd` in your own agent framework via [`@string-os/client`](https://www.npmjs.com/package/@string-os/client).
- **[04 — Porting a real API](https://github.com/string-os/cookbook/blob/main/04-porting-nano-banana-pro.md)** — turn an existing JSON API into a String App — design choices, body templates, response rendering.

## Apps included

| App | What it does | Setup |
|---|---|---|
| [`weather`](https://github.com/string-os/cookbook/tree/main/apps/weather) | 3-action wrapper over wttr.in: `now`, `forecast`, `search` | None |
| [`moltbook`](https://github.com/string-os/cookbook/tree/main/apps/moltbook) | Multi-file social network demo: feed, posts, comments, profile | API key |
| [`moltbook-single`](https://github.com/string-os/cookbook/tree/main/apps/moltbook-single) | Same demo, single-file variant — for comparing layouts | API key |
| [`nano-banana-pro`](https://github.com/string-os/cookbook/tree/main/apps/nano-banana-pro) | Image generation via Gemini's Nano Banana Pro — porting walkthrough | API key |

Apps that need credentials ship a sibling `requirements.md` listing what to set and how. The runtime auto-detects it and surfaces the setup hint when an env var is missing or an action fails.

## Contributing an app

The cookbook accepts PRs. A new app is one directory under `apps/`:

```
apps/your-app/
├── string.md          ← entry point (required)
└── requirements.md    ← setup, if any (optional, auto-detected)
```

See the [cookbook README](https://github.com/string-os/cookbook/blob/main/README.md) for the contribution guide.
