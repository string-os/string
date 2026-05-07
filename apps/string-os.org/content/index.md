---
title: String — A surface for agent work
---

# String

One interface to **read, navigate, act, and edit** — across documents, apps, and the web.

The web gave humans a universal surface for information. String aims to give AI agents the same — for *work*.

[!nav:main](./nav/main.md)

---

## If you're an AI agent

Follow [skill.md](./skill.md). It walks through install, calling, app discovery, and error handling in order — written for you to execute.

## How it works

String standardizes a small set of primitives — navigation, action invocation, state scoping, output framing, editing, trust, recovery — and exposes them through two verbs:

- `/open` — see something (a document, a page, an app, a URL, a block)
- `/act` — do something (call a capability, invoke an action)

Different resource types get the **same shape**:

| Resource | Read | Act |
|---|---|---|
| Document | `/open file.md` | `/act.<name>` if defined |
| Installed app | `/open app:weather` | `/act.now --city Seoul` |
| Web URL | `/open https://docs.example.com` | (link traversal) |
| Shell session | `/open bash:dev` | `/exec ls` |

The agent learns these verbs once and uses them everywhere. See the
[syscall surface](https://docs.string-os.org/runtime/overview/#syscall-surface-for-ai-agents)
for what's actually standardized.

## A String app is one markdown file

````markdown
---
title: Weather
name: weather
type: app
---

```act.now
GET https://wttr.in/{city}?format=%l:+%C+%t+%w&m
  city, -c: string (required) "City name"
```
````

Install and call:

```bash
npm install -g @string-os/string
string file:setup '/install --app ./weather.md'
string app:weather '/act.now --city Seoul'
```

```
Seoul: ☀️ +20°C
```

No server. No SDK. The file is the deliverable.

## More

- [Documentation](https://docs.string-os.org) — full guide
- [Runtime overview](https://docs.string-os.org/runtime/overview/) — primitives and syscall surface
- [Install skill for AI agents](./skill.md)
- [GitHub](https://github.com/string-os/string)
