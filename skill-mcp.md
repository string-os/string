---
title: String MCP — Skill for AI Agents
---

# Using String via MCP

You are an AI agent and you have a tool called **`string`**. It is your bridge to the **String OS** — an AI-facing runtime layer for Markdown apps. You log into it as a sandboxed agent (your `--agent <id>`), with your own home directory mapped onto the host but isolated from it. One tool, one call shape, the entire surface.

## 1. The only call shape you need

```ts
string({ topic: <string>, cmd: <string> })
```

- **`topic`** — the session label. State (current document, history, env vars, installed apps) is scoped by topic.
- **`cmd`** — a String command. **Must start with `/`**.

That's it. Everything else is discovered by running commands inside that surface.

## 2. The response

```ts
{
  content: [{ type: "text", text: "<𝒞=string:TOPIC>\n<body>\n</𝒞>" }],
  isError: <bool>
}
```

The body is wrapped in a **ChanFlow envelope** — the same text the CLI prints. The topic is encoded in the opening tag, so you always know which session produced the output even if you batch many calls.

- **`content[0].text`** — the full rendered output. Read this. Nothing else carries the body.
- **`isError`** — `true` on failure. The body still tells you what failed.

Errors carry their code in the body:

```
<𝒞=string:main>
ERROR(NOT_FOUND): File not found: ./missing.md
Recovery: Use /ls to list available files, or check the path spelling.
</𝒞>
```

Parse `ERROR(CODE):` if you want machine-readable handling.

## 3. Topics — pick the right one

| Form | Meaning |
|---|---|
| `main` | Free-form tab. Default for general work, opening files, running `/exec`, browsing. |
| `app:NAME` | An installed app (e.g. `app:weather`). Each app has its own actions and env. |
| `app:NAME:CONFIG` | App with a config-scoped env (e.g. `app:weather:seoul` — same app, Seoul-specific `$CITY`). |

Each topic keeps its own history. Switching between them is free — state is preserved per topic.

> `/info` on an `app:NAME` topic always reports the install state in the body:
> `status: not installed` (with the list of installed apps + `/install` hint), `status: installed, not yet opened` (run `/open` first), or the full app metadata once the app is loaded. Read the body to decide your next step.

## 4. The five commands you'll use most

| Command | Purpose |
|---|---|
| `/info` | Current session state — what's open, vars, history, available actions. **Run this first when entering a new topic.** |
| `/help` | Top-level command reference. |
| `/open <uri-or-path>` | Open a document, URL, directory, app, or `@shortcut`. |
| `/act.<name> [args]` | Run an action defined in the current document. `/act --help` lists them all. |
| `/set $X = "value"` | Set an app-scoped persistent env var. **Must be in an `app:NAME` session.** |

Plus `/exec <shell-command>` for one-off shell calls, `/back`, `/refresh`, `/install`, `/ls`, `/nav`, `/write`, `/append`, `/replace`, `/edit`. Discover them with `/help`.

## 5. The self-discovery loop

You don't need to remember everything. When you enter a topic, the document body tells you what's possible:

```
string({ topic: "app:moltbook", cmd: "/info" })
```

Once the app is loaded (after `/open`), the text body returns something like:

```
Session info
---
app:       moltbook
title:     Moltbook
actions:   home, feed, read, comment, upvote, search, post, ...
history:   3 entries
vars:      $MOLTBOOK_API_KEY = "moltbook_..."
```

Now you know the actions. Run `/act --help` for full signatures, or `/act.feed` to start using them.

**Before the app is loaded**, `/info` reports the install state instead:

```
app:       moltbook
status:    installed, not yet opened
hint:      run /open to load the app
```

…or, if the app isn't installed:

```
app:       totally_fake_app
status:    not installed
installed: dict, weather, moltbook, ...
hint:      run /install <source> to install this app
```

Read the `status:` and `hint:` lines, then act on them.

## 6. Concrete patterns

**Read a local document:**
```
string({ topic: "main", cmd: "/open /absolute/path/to/README.md" })
```
> Relative paths (`./README.md`) resolve from **your** String home (`~/.string/agents/<your-id>/`) — not the OS shell's cwd. The host filesystem is out of scope unless you explicitly `/exec` something (see §8). Prefer absolute paths or `/exec pwd` to confirm where you are.

**Browse the web:**
```
string({ topic: "main", cmd: "/open https://developer.mozilla.org" })
```

**Use an app:**
```
string({ topic: "app:weather:seoul", cmd: "/set $CITY = \"seoul\"" })   # one-time
string({ topic: "app:weather:seoul", cmd: "/open" })                     # → Seoul weather
string({ topic: "app:weather", cmd: "/act.now Tokyo" })                  # ad-hoc, any city
```

**Run a shell command:**
```
string({ topic: "main", cmd: "/exec ls -la" })
```

**Install a new app:**
```
string({ topic: "main", cmd: "/install --app /path/to/app.md" })
```

## 7. When things fail

Errors include a `code` and a recovery hint in the text. Read both.

```
isError: true
content[0].text:
<𝒞=string:main>
ERROR(NOT_FOUND): File not found: ./missing.md
Recovery: Use /ls to list available files.
</𝒞>
```

Common codes you'll handle by retrying with different args:
- `NOT_FOUND` — bad path, missing app, unknown shortcut, or `#fragment` not present in the file
- `INVALID_PAYLOAD` — missing `$VAR` (need `/set $X = "..."`), bad args
- `INVALID_TARGET` — bad topic format (e.g. dots in name); also returned if `/set` is used outside an `app:` topic
- `COMMAND_UNSUPPORTED` — command doesn't apply here (e.g. plain text instead of `/`)

When you see a `Recovery:` line in the output, follow it.

## 8. Mental model recap

- **You are a String agent, not the OS user.** Your home (`~/.string/agents/<your-id>/`) is mapped onto the host but isolated from it. Other agents have other homes. Treat the host filesystem as out of scope unless `/exec` says otherwise — this is why `./foo.md` resolves to your home, not the host's cwd.
- **One tool, two args:** `string({topic, cmd})`.
- **Topic = session.** Pick a topic for a piece of work, stay in it. `main` for general work, `app:NAME` for app-specific flows.
- **Cmd starts with `/`.** Plain text is rejected.
- **Self-discover:** `/info` shows where you are, `/help` lists commands, `/act --help` lists actions, the document body shows what's available.
- **Read `content[0].text`** — the ChanFlow envelope (`<𝒞=string:TOPIC>…</𝒞>`) carries everything: topic, body, error codes. Same format as the CLI.
- **App env is app-scoped:** `/set $X` requires an `app:NAME` session and the value is invisible to other apps and to the OS shell.

You don't need any other tool. `string` gives you Markdown documents, web pages, shell, installable apps, and persistent state — all through this one entry point.
