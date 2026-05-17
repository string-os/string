---
title: String — Install Skill for AI Agents
---

# Install String (skill for AI agents)

You are reading this to learn how to install String and call SFMD apps from any shell tool. Follow these steps in order.

## 1. Install

```bash
npm install -g @string-os/string
```

Requires Node.js 20+. The daemon (`stringd`) auto-starts on first call — no manual `--daemon start` needed. Verify:

```bash
string --help
```

## 2. The output frame

Every `string` call wraps stdout in:

```
<𝒞=string:<topic>>
...payload...
</𝒞>
```

Read the payload between the markers. The opener tells you which topic the call ran in.

## 3. Call shape

```bash
string <topic> '<command>'
```

A **topic** is the session label and scopes session state (current document, history, env vars).

| Form | Use |
|---|---|
| `<name>` | Free-form session — bare label you pick (e.g. `main`, `notes`, `setup`). Default when no topic is given is `main`. |
| `app:<name>` | Running an installed app |
| `app:<name>:<config>` | Same app with a config-scoped env (e.g. `app:weather:seoul` for region-specific API key) |
| `bash:<name>` | Persistent shell session |
| `app`, `bash`, `tool`, `system` | Reserved hub topics — placeholder pages in 0.1; listings and management actions arrive in 0.2 |

Same topic = same state. Reserved hub names cannot be used as free-form labels.

## 4. Open an app and discover its actions

```bash
string app:weather '/open app:weather'
```

Response starts with the action menu:

```
[actions] now, forecast, search  ·  /act --help (all)  ·  /act.<name> --help
```

That line is your discovery output — every action the app exposes. For a single action's field schema, run `/act.<name> --help`; for every action on the doc at once, `/act --help`. Inside an `app:` topic, `/open` with no argument re-opens the app's home.

## 5. Run an action

```bash
string app:weather '/act.now --city Seoul'
# Positional (declaration order):
string app:weather '/act.now Seoul'
# Short alias if defined:
string app:weather '/act.now -c Seoul'
# Multi-word values — quote or use +:
string app:weather '/act.now "New York"'
string app:weather '/act.now New+York'
# Field schema:
string app:weather '/act.now --help'
```

Successful output:

```
<𝒞=string:app:weather>
seoul: Sunny +20°C ↘6km/h
</𝒞>
```

## 6. Install a new app

From the cookbook (canonical example collection):

```bash
git clone https://github.com/string-os/cookbook.git
cd cookbook
string setup '/install --app ./apps/weather/string.md'
```

From any URL:

```bash
string setup '/install --app https://example.com/my-app/string.md'
```

The runtime copies the file into `~/.string/users/default/packages/<name>/` and registers it. From this point on, `app:<name>` resolves from any session.

Available apps in the cookbook:

| App | What it does | Needs |
|---|---|---|
| `weather` | wttr.in wrapper: `now`, `forecast`, `search` | nothing |
| `moltbook` | Multi-file social network demo (feed, posts, comments, profile) | API key |
| `moltbook-single` | Same demo, single-file variant — for layout comparison | API key |
| `nano-banana-pro` | Image generation via Gemini Nano Banana Pro | API key |

## 7. Set credentials

Apps that need API keys declare `requires: [VAR_NAME]` in frontmatter. When you `/open` an app without the var set, the response begins with:

```
[!] Missing required env: $MOLTBOOK_API_KEY
    Set: /set $MOLTBOOK_API_KEY = "..."
    Setup: /open requirements.md
```

Set the var with `/set` (persists to disk in the current topic's scope):

```bash
string app:moltbook '/set $MOLTBOOK_API_KEY = "moltbook_xxx"'
```

| Topic when running `/set` | Where it persists |
|---|---|
| free-form (`main`, `notes`, ...) | Global (`config.json`) |
| `app:<name>` | App scope (`apps/<name>/env.json`) |
| `app:<name>:<config>` | Config scope (`apps/<name>/<config>/env.json`) |

Resolution cascades: config → app → global. A var set globally is visible to every app unless overridden at a more specific scope.

Shell-exported `export VAR=...` also works as a fallback (the daemon reads `process.env`), but `/set` is preferred — survives daemon restarts and keeps secrets out of shell history.

## 8. Handle action errors

When an action fails and the app has a `requirements.md`, the error gets a trailing hint:

```
ERROR(EXIT_127): kubectl: command not found

Setup info: /open requirements.md
```

When you see that, run `string app:<name> '/open requirements.md'` to see what to install or configure. Then retry the action.

## Reference

| Command | What it does |
|---|---|
| `/open <path \| app:name \| URL>` | Open document or app |
| `/open` | Re-open current app's home (in `app:` topic) |
| `/back` | Previous page |
| `/close` | Close current document |
| `/refresh` | Reload current document |
| `/info` | Session state (current app, version, action list, history depth) |
| `/ls [path]` | List files in a directory |
| `/help` | All commands + current page actions |
| `/act.<name> [flags]` | Run action — positional or `--flag value` |
| `/act.<name> --help` | Field schema for that action |
| `/tool:<name> [args]` | Run an installed tool (default action) — POSIX CLI shape |
| `/tool:<name>.<act> [args]` | Run a named action on a tool |
| `/install --app \| --tool <source>` | Install from local path or URL |
| `/uninstall <name>` | Remove installed package |
| `/set $VAR = "value"` | Persistent env var, scoped to current topic |
| `/set` | List session vars + persistent vars in scope |

## More

- [Documentation](https://docs.string-os.org)
- [Cookbook (example apps + walkthroughs)](https://github.com/string-os/cookbook)
- [Source](https://github.com/string-os/string)
