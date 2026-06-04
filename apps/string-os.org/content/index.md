---
title: String — A surface for agent work
---

# String

The web gave humans a universal surface for information. String gives AI agents one for **work**.

[!nav:main](./nav/main.md)

---

## If you're an AI agent

Follow [skill.md](./skill.md). It walks through install, calling, app discovery, and error handling in order — written for you to execute.

## What changes for your agent

- **Scales without growing context.** Most tool integrations add to the agent's context with each new tool (docs, schemas, examples). With String, the same small surface (`/open`, `/act`, `/info`) covers every installable app — adding apps doesn't grow what the agent has to know.
- **Credentials kept out of the agent's context.** App credentials live in app-scoped environment variables — the agent doesn't see them, so direct exfiltration through prompt injection on the agent isn't a path. The app running an action still has the key; v0.1 doesn't yet sandbox an app's own HTTP/CLI calls, so app trust still matters.
- **Portable across runtimes.** The same `.sfmd` app works in Claude Desktop, Cursor, your CLI, your daemon — anywhere String runs. Install once, use everywhere.
- **Self-onboarding.** Every response carries a `next:` hint. Errors carry recovery lines. Your agent learns new apps without prior documentation.

---

## What an agent does

Three commands. No documentation read in advance. The agent ends up reading a post in a social network it has never seen:

```
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

No SDK. No API key in the agent's context. No endpoint memorized. Each response tells the agent what to do next — the way a human app does.

---

## How it compares

- **vs MCP.** MCP is a protocol with a server per tool. SFMD is a file — works over `file://`, HTTP, or a USB drive. String *speaks* MCP natively (one tool, `string({topic, cmd})`, wraps the entire surface), but SFMD itself isn't tied to any one protocol.
- **vs SKILL.md / agent skills.** A SKILL.md is written for one agent runtime. An SFMD file is an app surface any runtime can read and execute — one shared surface covers all installed apps, not a separate skill per app per runtime.
- **vs llms.txt.** Static, read-only index. SFMD is read *and* execute. Actions are first-class.

---

## How it works

Two verbs the agent learns once and uses everywhere:

- `/open` — see something (document, page, app, URL, block). Opening an app may also run its declared `default` action to show the app's first useful view.
- `/act` — do something explicit (call an API, run a CLI tool, submit data).

The separation is still the important habit: use `/open` to orient, then use `/act.<name>` for intentional work. App authors should keep `default` actions read-only and idempotent.

| Resource | Read | Act |
|---|---|---|
| Document | `/open file.md` | `/act.<name>` if defined |
| Installed app | `/open app:weather` | `/act.now --city Seoul` |
| Web URL | `/open https://docs.example.com` | (link traversal) |

See the [syscall surface](https://docs.string-os.org/runtime/overview/#syscall-surface-for-ai-agents) for what's actually standardized.

---

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
string main '/install --app ./weather.md'
string app:weather '/act.now --city Seoul'
```

```
Seoul: ☀️ +20°C
```

No server. No SDK. The file is the deliverable.

---

## More

- [Skill for AI agents](./skill.md) — written for agent self-onboarding
- [Documentation](https://docs.string-os.org) — full guide
- [Cookbook](https://github.com/string-os/cookbook) — runnable example apps
- [GitHub](https://github.com/string-os/string)
