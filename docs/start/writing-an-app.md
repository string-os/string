---
title: Writing your first app
---

A String app is one Markdown file. The file declares actions; the runtime turns those actions into `/act.*` commands the agent can call. No build step, no scaffolding.

## Minimal skeleton

```markdown
---
name: hello
type: app
default: greet
---

# Hello

A two-action demo.

\`\`\`act.greet
CLI echo "Hello, {name}!"
  name: string (required) "Person to greet"
\`\`\`
```

Three pieces:

- **Frontmatter** — `name` is the registry id, `type` is `app` or `tool`, `default` is the action that runs on `/open` with no args.
- **Body** — what the agent reads when it `/open`s the app. Keep it short — every line costs tokens on every call.
- **Action block** — one fenced `act.<id>` block per action. First line is the recipe (`CLI …` for shell, `GET|POST|…` for HTTP). Indented lines below declare typed fields.

## Action types

**CLI** — runs a shell command. `{field}` placeholders get the user's argument values shell-escaped:

```markdown
\`\`\`act.search
CLI grep -rn {pattern} {path}
  pattern: string (required) "What to find"
  path: string (required) "Where to look"
\`\`\`
```

**HTTP** — calls an API. Add `-H "Header: Value"` flags on the same line; declare a body with `-d '{...}'` if needed. `$VAR` references resolve from the env store (set with `/set $VAR = "..."`):

```markdown
\`\`\`act.now
GET https://wttr.in/{city}?format=j1 -H "User-Agent: curl/8"
  city: string (required) "City name"
\`\`\`
```

For HTTP, optionally add a sibling `act.<id>.response` block to template the response into agent-friendly text instead of raw JSON.

## Install and try

```bash
string file:setup '/install --app ./hello.md'
string app:hello '/act.greet --name World'
# → Hello, World!
```

The runtime copies the file into its package directory and registers `hello` under the apps registry. From now on, `app:hello` is addressable from any session.

## App vs Tool

|  | App (`type: app`) | Tool (`type: tool`) |
|---|---|---|
| Invocation | `/open app:name` then `/act.x` | `/tool:name args` |
| Scope | Multi-page, persistent session | Single call, no session state |
| Use when | The agent will work in this context for a while | One-shot helper |

Both use the same action syntax. App is the default — pick tool only when there's no per-session state worth keeping.

## What's next

- **[Cookbook](https://github.com/string-os/cookbook)** — real apps with real APIs (weather, image generation, a multi-file social demo). Clone and read along.
- **[Authoring guide](../runtime/authoring.md)** — deeper SFMD authoring: blocks, navigation, includes, response templates.
- **[SFMD spec](../sfmd/overview.md)** — every directive and field, formally.
- **[Actions reference](../sfmd/actions.md)** — full action block grammar.

Setup that the app needs (API keys, CLI tools, account creation) goes in a sibling `requirements.md`. The runtime auto-detects it and surfaces a hint when an env var is missing or an action fails. See the [anatomy chapter](https://github.com/string-os/cookbook/blob/main/01-anatomy.md) in the cookbook for an end-to-end walkthrough.
