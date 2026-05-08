---
title: Tools
---

Tools are utilities AI invokes without leaving its current context.
Unlike apps — which you enter and explore — tools come to you.

```
/open app:gmail         → go there (context switch)
/tool:translate         → call here (context stays)
```

AI is editing a report and needs a translation? `/tool:translate`.
The result comes back, and the AI is still in the report. No tab
switch, no session change, no lost position.

---

## Tool vs App

Tools and apps are both SFMD documents. They share the same
frontmatter, the same definition syntax, and the same runtime.
The difference is in how they're used.

### App — a place you go

An app is a space with pages, navigation, and state. You enter it
with `/open` or a topic name, explore its content, and use its
actions. The Markdown content is the primary interface — it shows
the AI what's on screen.

```
string:app:gmail:work
  /open string.md       → inbox view (Markdown)
  /act.compose          → send an email
  /open thread.md       → read a thread (Markdown)
  /nav main             → navigate pages
```

Apps use `act.*` blocks — actions bound to the current page.

### Tool — something you call

A tool is a command. It runs in the caller's context, returns a
result, and that's it. There's no "inside" to explore. The Markdown
content of a tool document is documentation, not a UI.

```
/tool:translate --to "en"        → translate, get result
/tool:git status                 → check git, get result
/tool:kubectl get pods           → query k8s, get result
```

Tools use `act.*` blocks — same syntax, same runtime.

### Same format, different purpose

| | App | Tool |
|---|---|---|
| **Interaction** | Enter and explore | Call and return |
| **Access** | `/open` or `app:name` topic | `/tool:name` |
| **Content** | UI — what AI sees and navigates | Documentation |
| **Definition blocks** | `act.*` | `act.*` (same) |
| **State** | Session persists (history, vars) | Stateless per call |
| **Multi-page** | Yes (nav menus, multiple .md files) | No (single document) |
| **Multi-instance** | `app:name:config` | One tool, used everywhere |
| **Context** | Becomes current context | Runs in caller's context |

The analogy: apps are windows, tools are command-line utilities.
A window has its own screen. A utility runs and prints output.

---

## Tool document

A tool is a single SFMD file with optional frontmatter and one or
more `act.*` blocks.

### Minimal tool

````markdown
---
default: greet
---

```act.greet
CLI echo "hello"
```
````

That's a valid tool. String parses `act.greet`, frontmatter says
it's the default, `/tool:name` invokes it.

### Full tool

````markdown
---
name: translate
description: "Translate text or files"
default: translate
env:
  - DEEPL_KEY: "DeepL API key"
  - TARGET_LANG: "Topic language code"
    default: en
---

# Translate

Translate text using DeepL API.

`/tool:translate --text "안녕하세요" --target_lang "en"`
`/tool:translate.detect`

```act.translate
GET https://api.deepl.com/v2/translate -H "Authorization: DeepL-Auth-Key $DEEPL_KEY"
  text: string (required) "Text to translate"
  target_lang: string "Topic language code"
```

```act.translate.response
{translated} = {Response.body.translations[0].text}
**Translated:** {translated}
```

```act.detect
CLI gt --detect $CURRENT_FILE
```
````

The Markdown content (heading, usage hints) is documentation. AI
sees it only if it reads the tool file directly — not during normal
`/tool` invocation.

---

## act blocks — unified for apps and tools

Apps and tools use the same `act.*` block syntax. There is no
separate block type. One definition format covers everything.

| Context | Invoked with | Example |
|---------|-------------|---------|
| App page | `/act.name` | `/act.compose --to "user@example.com"` |
| Tool | `/tool:name` or `/tool:name.act` | `/tool:translate --text "hello"` |

Both support the same methods: `GET`, `POST`, `PUT`, `PATCH`,
`DELETE`, `CLI`. Both support `-H` headers, `$var` (persistent),
`{var}` (session), and response templates.

### default action

The `default` field in frontmatter declares which action runs
automatically:

```yaml
---
default: translate
---
```

**For tools:** `/tool:translate` runs `act.translate` (the default).
`/tool:translate.detect` runs `act.detect` (specific action).

```
/tool:translate          → runs act.translate (default)
/tool:translate.detect   → runs act.detect
```

If no `default` is declared and no sub-action is specified,
String returns an error listing available actions.

**For apps:** `/open` loads the document and runs the default action.
AI sees document content + action result combined (separated by
`---`). See [Actions — Default action](./05-actions.md) for details.

### Response templates

Assignment lines store variables, output lines render Markdown:

````markdown
```act.translate.response
{translated} = {Response.body.translations[0].text}
**Translated ({Response.body.detected_language} → {target_lang}):**
{translated}
```
````

Variables stored in response templates persist in the caller's
session — the session that invoked the tool.

---

## Invocation

```
/tool:name                      → default action (from frontmatter)
/tool:name.act                  → specific action
/tool:name --flag value         → flags passed to default action
/tool:name.act --flag value     → flags passed to specific action
```

POSIX CLI syntax, same as `/act`:

```
/tool:translate --text "안녕하세요" --target_lang "en"
/tool:git commit -m "fix bug"
/tool:kubectl get pods --namespace "production"
```

---

## Context variables

When a tool runs, String injects context about the caller's current
state. These are read-only variables available in `act` definitions:

| Variable | Value |
|----------|-------|
| `$CURRENT_FILE` | Current open file path |
| `$CWD` | Current working directory |
| `$CURRENT_URI` | Current document URI |
| `$CURRENT_TARGET` | Current topic (e.g. `main`) |
| `$CURRENT_BLOCK` | Currently viewed block ID, if any |
| `$ARGS` | Everything after the tool name (for pass-through) |

These are String built-ins — separate from developer-defined `$var`
(persistent config like `$GITHUB_TOKEN`).

```markdown
```act.count
CLI wc -l $CURRENT_FILE
```
```

```
/tool:linecount
→ runs: wc -l /home/agent/docs/report.md
```

The tool doesn't need to know which file is open. String tells it.

---

## Tool resolution

When AI invokes `/tool:translate`, String resolves the tool name
in this order:

```
1. ./tools/translate.md             ← workspace local
2. ~/.string/tools/translate.md     ← global install
3. registry (remote)                ← future
```

Matching is by the `name` field in frontmatter. If frontmatter has
no `name`, the filename (without extension) is used as fallback.

```
./tools/my-translator.md
  frontmatter: name: translate    → matches /tool:translate
```

No configuration file. No manifest. Drop a `.md` file in `./tools/`
and it's available.

---

## Two patterns

### Pattern A: Pass-through

For CLI tools AI already knows well — git, npm, docker, kubectl.
The tool wraps the CLI and passes arguments through safely:

````markdown
---
name: git
default: git
---

```act.git
CLI git $ARGS
```
````

```
/tool:git status                    → git status
/tool:git commit -m "fix bug"      → git commit -m "fix bug"
/tool:git push origin main         → git push origin main
```

`$ARGS` is parsed by String before injection — shell metacharacters
are neutralized. This is the security gain:

```
/exec git push; rm -rf /           ← shell injection possible
/tool:git push origin main         ← only git runs, no chaining
```

Same pattern works for any CLI:

````markdown
```act.npm              ```act.docker           ```act.kubectl
CLI npm $ARGS           CLI docker $ARGS        CLI kubectl $ARGS
```                     ```                     ```
````

### Pattern B: Structured

For REST APIs or commands with explicit parameters:

````markdown
```act.translate
GET https://api.deepl.com/v2/translate -H "Authorization: DeepL-Auth-Key $DEEPL_KEY"
  text: string (required) "Text to translate"
  target_lang: string "Topic language code"
```

```act.detect
CLI gt --detect $CURRENT_FILE
```
````

A single tool can mix REST and CLI actions. Each `act` block
independently chooses its method.

---

## Frontmatter

Tools and apps share the same frontmatter standard. Everything
is optional — a tool works without any frontmatter.

```yaml
---
name: translate               # Display name (fallback: filename)
description: "Translate text" # For help and registry
version: 1.0.0                # Semantic version
author: "@username"           # Author

env:                          # Required environment variables
  - DEEPL_KEY: "DeepL API key"
  - TARGET_LANG: "Topic language code"
    default: en               # Optional default value

type: tool                    # tool | app — used by /install for registry placement
namespace: cookbook           # publisher identifier (combined with name = canonical identity)
tags: [translation, i18n]     # Search tags for registry
---
```

### env validation

If `env` is declared, String checks that required variables are
set before executing the tool. Missing variables produce an error
with the description as a hint:

```
ERROR(ENV_REQUIRED): tool:translate requires $DEEPL_KEY — "DeepL API key"
```

Variables with `default` are used if the environment doesn't
provide a value.

### Shared with apps

The same frontmatter fields work in app documents:

```yaml
---
name: gmail
namespace: cookbook
type: app
description: "Email client"
env:
  - GMAIL_TOKEN: "OAuth access token"
---
```

The `type` field decides where `/install` registers the package
(`apps[]` vs `tools[]` in `config.json`). At call time, the dispatch
verb (`/tool:name` vs. `/open app:name`) determines which registry
String looks the package up in. A package can technically be reached
either way once registered, but the convention is to match: tools use
`type: tool` and are invoked via `/tool:`, apps use `type: app` and
are opened via `/open app:`.

---

## App document structure for comparison

An app is multiple pages with navigation and `act.*` blocks:

```
gmail/
├── string.md           # inbox — act.inbox, act.search
├── compose.md          # compose — act.compose
├── thread.md           # thread view — act.reply, act.archive
└── nav/
    └── main.md         # [@inbox Inbox](../string.md) ...
```

Each page has its own actions relevant to that page's function.
The AI navigates between pages with `/open`, discovering actions
as it goes.

A tool is a single file with `act.*` blocks:

```
tools/
└── translate.md        # act.translate (default), act.detect
```

No navigation, no multi-page structure. Just actions.

### When an app needs a tool (or vice versa)

An app can reference a tool — AI invokes `/tool:translate` while
inside `app:gmail` to translate an email. The tool runs in the
caller's context and returns.

A tool cannot open an app. Tools are leaf operations — they don't
navigate.

---

## Security

The long-term direction: `/tool` replaces `/exec` as the default
way AI runs external operations.

### Why

```
/exec   → AI constructs arbitrary shell commands (max freedom, max risk)
/tool   → Document declares scope, AI operates within it (controlled)
```

`/exec` is powerful but unauditable. You can't know what an AI will
run until it runs it. `/tool` inverts this — the tool document
declares exactly what can be executed.

### Evolution path

```
Phase 0:  /exec and bash: freely used (current)
Phase 1:  Common tasks move to tools (search, build, test)
Phase 2:  /exec permission model (default disabled, explicit allow)
Phase 3:  Most workflows via /act + /tool, /exec is opt-in
```

`/exec` doesn't disappear. Power users and development environments
keep it. But the default shifts — AI starts with declared tools only,
shell access requires explicit permission.

This is the enterprise adoption condition. Arbitrary shell execution
can't go to production. Declared, auditable tool execution can.

### Command hierarchy

```
/open    → go there (documents, apps, web)
/act     → use what's here (current document's actions)
/tool    → call external utility (stays in current context)
/exec    → raw shell (restricted, audited)
```

Each level trades freedom for safety. `/open` is read-only navigation.
`/act` is scoped to declared actions. `/tool` is scoped to declared
actions. `/exec` is unrestricted.

---

## Summary

| Concept | Rule |
|---------|------|
| **Tool** | Single SFMD file with `act.*` blocks |
| **Invocation** | `/tool:name` (default action) or `/tool:name.act` (specific) |
| **Syntax** | POSIX CLI — `/tool:name --flag value` |
| **Context** | Runs in caller's context, returns result |
| **Resolution** | `./tools/` → `~/.string/tools/` → registry |
| **Matching** | `name` frontmatter field (fallback: filename) |
| **Context vars** | `$CURRENT_FILE`, `$CWD`, `$CURRENT_URI`, `$CURRENT_TARGET`, `$CURRENT_BLOCK`, `$ARGS` |
| **Frontmatter** | Optional, shared with apps (`name`, `env`, `description`, ...) |
| **env** | Declared vars validated before execution |
| **Pass-through** | `CLI command $ARGS` — safe argument forwarding |
| **Structured** | Explicit parameters (REST or CLI) |
| **Default action** | `default: name` in frontmatter |
| **Response** | `act.*.response` |
| **vs App** | Tool = call and return; App = enter and explore |
| **vs /exec** | Tool = declared scope; /exec = arbitrary shell |
