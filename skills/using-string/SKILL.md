---
name: using-string
description: >
  Use String apps, web pages, and shell sessions through the `mcp__string__string`
  tool. Invoke when the user asks to install a String app from a GitHub URL or
  path, use an installed app like `app:weather`, read a web page as clean
  markdown, run a typed action with `/act.<name>`, set an app credential with
  `/set $VAR`, or anything else that mentions SFMD, `string-os`, `app:<name>`,
  `/act`, or installing from `gh:owner/repo`.
---

# Using String

You have a tool called **`mcp__string__string`** wired up by this plugin. It's your one entry point to the String runtime — a Markdown-native surface for documents, installable apps, web pages, and shell.

The MCP server is started for you on demand (the plugin's `.mcp.json` spawns `npx -y @string-os/string --mcp ...`). The first call may take a few seconds while npm fetches the package. Subsequent calls are instant.

## 1. The only call shape

```
mcp__string__string({ topic: <string>, cmd: <string> })
```

- **`topic`** — session label. State (current document, history, env) is scoped per topic.
  - `main` — free-form tab. Default.
  - `app:NAME` — an installed app (e.g. `app:weather`).
  - `app:NAME:CONFIG` — app with a config-scoped env (e.g. `app:weather:seoul`).
- **`cmd`** — a String command. **Must start with `/`**.

The response body is wrapped in a **ChanFlow envelope**:

```
<𝒞=string:TOPIC>
<rendered body>
</𝒞>
```

Read the body between the tags. Errors look the same but the body starts with `ERROR(CODE): …` and `isError` is `true`. Every error includes a `Recovery:` hint — follow it.

## 2. First call — verify

When this plugin is freshly installed, run one call to make sure the MCP server is reachable and the npm fetch completed:

```
mcp__string__string({ topic: "main", cmd: "/info" })
```

Expected response: a `Session info` block. If it errors, the npm fetch failed (network/registry issue) — report the error to the user, don't retry blindly.

## 3. Install a new app

**From a GitHub URL** (preferred — the URL a browser address bar shows):

```
mcp__string__string({ topic: "main", cmd: "/install https://github.com/string-os/apps/tree/main/apps/gh-kanban" })
```

**Short form** (less typing):

```
mcp__string__string({ topic: "main", cmd: "/install gh:string-os/apps/apps/gh-kanban" })
```

**Single-file app via blob URL:**

```
mcp__string__string({ topic: "main", cmd: "/install https://github.com/string-os/cookbook/blob/main/apps/weather/string.md" })
```

Behind the scenes: the daemon enumerates the directory via GitHub Contents API, fetches all files, marks shebang scripts executable, and registers the app. After a successful install, the response tells you the registry name (e.g. `app:gh-kanban`).

The cookbook has reference apps you can install this way: `weather`, `moltbook`, `moltbook-single`, `nano-banana-pro`, `gh-kanban`.

## 4. Use an installed app

Move into the app's topic and open it:

```
mcp__string__string({ topic: "app:weather", cmd: "/open" })
```

The response begins with an `[actions]` line listing what the app exposes (e.g. `[actions] now, forecast, search`). Then run an action:

```
mcp__string__string({ topic: "app:weather", cmd: "/act.now Seoul" })
```

Action flag forms: `/act.now --city Seoul`, `/act.now Seoul` (positional), `/act.now -c Seoul` (alias). For an action's schema: `/act.<name> --help`.

**Self-discovery loop.** Every list-returning action ends with a `next:` line showing what to chain. Follow those — that's how you navigate without prior knowledge of the app.

Example chain (moltbook):
```
mcp__string__string({ topic: "app:moltbook", cmd: "/act.feed" })
# → registers @post-1 .. @post-20, ends with: next: /act.read @post-N · ...
mcp__string__string({ topic: "app:moltbook", cmd: "/act.read @post-3" })
# → reads that post, ends with: next: /act.upvote @post · /act.comment @post "..."
```

## 5. Set credentials (no leak path)

Apps requiring API keys say so when opened:

```
[!] Missing required env: $OPENAI_API_KEY
    Set: /set $OPENAI_API_KEY = "..."
    Setup: /open ./requirements.md
```

**`/set` MUST run inside the `app:NAME` topic** — that's how the env is scoped to that app and kept out of your context for future calls:

```
mcp__string__string({ topic: "app:moltbook", cmd: "/set $MOLTBOOK_API_KEY = \"...\"" })
```

The key is persisted on disk under `~/.string/agents/default/apps/<name>/env.json`. The app itself uses it for its HTTP/CLI actions; your context never sees the value again.

## 6. Read a web page as clean markdown

```
mcp__string__string({ topic: "main", cmd: "/open https://www.string-os.org/" })
mcp__string__string({ topic: "main", cmd: "/open https://docs.string-os.org/runtime/mcp" })
```

Sites that support content negotiation (like the String docs) return raw markdown. Others fall back to HTML rendered as markdown. Either way you get clean text instead of a JavaScript-hydrated SPA shell.

## 7. Run a one-off shell command

```
mcp__string__string({ topic: "main", cmd: "/exec ls -la" })
```

The shell runs as the OS user that launched the daemon. The cwd is the String agent home (`~/.string/agents/default/`), **not** the OS repo cwd — see §10.

## 8. Discover what's possible

**Topic-local** — what's in front of you:

| Call | Purpose |
|---|---|
| `/info` | Where you are. App topic shows install state. |
| `/help` | Top-level command reference. |
| `/act --help` | List every action on the current document with its schema. |
| `/ls [path]` | List files in the String home. |

**Global** — what exists across the whole runtime, via the four **hub topics**.
One `/open` on a hub gives you an aggregated view + the management commands
for that kind. Use these when the user asks something open-ended like *"what
apps do I have?"* or *"is the daemon up?"* before guessing.

| Call | What you get |
|---|---|
| `mcp__string__string({ topic: "app",    cmd: "/open" })` | Installed apps + open app sessions + install/uninstall commands |
| `mcp__string__string({ topic: "tool",   cmd: "/open" })` | Installed tools + run/manage commands |
| `mcp__string__string({ topic: "bash",   cmd: "/open" })` | Active bash sessions + how to spawn one |
| `mcp__string__string({ topic: "system", cmd: "/open" })` | Home dir, daemon stats, env scope, session counts |

## 9. Common error codes and what to do

| Code | Meaning | Recovery |
|---|---|---|
| `NOT_FOUND` | Bad path, missing app, unknown shortcut, or `#fragment` not in file | Read the `Recovery:` line. Often `/ls` or `/install`. |
| `INVALID_PAYLOAD` | Missing `$VAR` or bad action args | Set the var with `/set` (in `app:` topic) or fix the args. |
| `INVALID_TARGET` | Bad topic format (dots in name, etc.) | Use `main` / `app:NAME` / `app:NAME:CONFIG`. |
| `COMMAND_UNSUPPORTED` | Command doesn't apply here, or plain text without `/` | Always start commands with `/`. |
| `BUSY` | Concurrent call on same topic | Retry once after a moment. |

## 10. Identity and sandbox

You're a String agent, not the OS user. Your home is `~/.string/agents/default/` . Relative paths like `./README.md` resolve from that home, **not** from the OS shell's cwd. To touch host files: prefer absolute paths or `/exec pwd` first to confirm where you are.

Sessions, history, installed apps, and `/set $X` env vars all live under this home. Other AI clients (Cursor, Codex with their own `--agent` values) have separate homes — no bleed.

## 11. Mental model in one paragraph

One tool, two args (`topic`, `cmd`). Topic = session, pick one for a piece of work and stay in it. Cmd starts with `/`. Two verbs do the heavy lifting: **`/open`** sees something (pure read), **`/act`** does something (side effects). Browser-style discovery: `/info` shows where you are, every list response shows what to chain via a `next:` line, every error shows how to recover via a `Recovery:` line. New capability = a new SFMD file, installed via `/install <github-url>`. The agent (you) learns the verbs once and uses them across every app, page, and shell.

For the full SFMD spec: https://docs.string-os.org
