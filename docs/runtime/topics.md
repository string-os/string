---
title: Topics
---

# Topics

A topic is a session. Every command an AI sends through String is
directed at a specific topic — a file, a web tab, or an app instance.
Each topic maintains its own state independently.

---

## What a topic is

When AI works through String, it doesn't operate in a single global
context. It works with topics — isolated units that each hold their
own history, current location, and state.

Think of it like a desktop. A human has multiple windows open — a text
editor, a browser with several tabs, an email client. Each window is
independent. Scrolling in one doesn't affect another. The back button
in one browser tab doesn't navigate a different tab.

Topics give AI the same capability.

```
<𝒞=string:file:main>
/open ~/report.md#summary
</𝒞>

<𝒞=string:web:docs>
/open @getting-started
</𝒞>

<𝒞=string:app:gmail:work>
/act.compose --to "team@company.com"
</𝒞>
```

Three topics, three independent sessions. The AI can switch between
them freely. Each one remembers where it is.

---

## Topic syntax

All topics follow a typed format:

```
type:name
```

- **type**: `file`, `web`, `app`, or `bash`
- **name**: `[a-zA-Z0-9_-]+` — letters, numbers, hyphens, underscores only

No dots. No paths. No spaces. Session names are short identifiers,
not file paths or URLs.

A bare name (no type prefix) defaults to `file:`:

```
main         → file:main
docs         → file:docs
```

An empty or absent topic defaults to `file:main`.

In ChanFlow: `string:<type:name>`. In HTTP: body `{"topic": "type:name"}`.

---

## Topic types

### File

A file session is a named workspace for local file operations.

```
string:file:main
string:file:docs
string:file:notes
```

The session name identifies the workspace — not a specific file.
Within a session, the AI navigates files freely with `/open`:

```
<𝒞=string:file:main>
/open ~/report.md
</𝒞>

<𝒞=string:file:main>
/open ~/docs/guide.md#setup
</𝒞>
```

Both commands topic the same session. History, current location,
and variables persist across navigations within that session.

Multiple file sessions let the AI organize work by context:

```
<𝒞=string:file:docs>
/open ~/docs/api-reference.md
</𝒞>

<𝒞=string:file:notes>
/open ~/notes/meeting.md
</𝒞>
```

Each session maintains its own navigation history independently.

Relative paths in `/open` resolve from the current document's
directory. `[Next](./chapter2.md)` inside `~/docs/chapter1.md`
points to `~/docs/chapter2.md` — exactly as in any Markdown viewer.

### Web

A browser tab is a topic. Pages change within the tab, but the topic
stays the same.

```
string:web:tab_1
string:web:docs
string:web:competitor_research
```

When AI opens a URL inside a web topic, it navigates within that tab.
The URL changes, but the session — history, cookies, authentication —
persists. `/back` returns to the previous page in that tab, not a
different tab.

Named tabs (`web:docs`, `web:research`) let the AI organize its
browsing by purpose, just like a human labels browser tab groups.

Opening a URL without a topic automatically creates a new tab:

```
<𝒞=string>
/open https://docs.example.com/api
</𝒞>
```

String assigns `web:tab_1`, `web:tab_2`, ... incrementally. To
name the tab explicitly, use `--tab`:

```
<𝒞=string>
/open --tab docs https://docs.example.com/api
</𝒞>
```

This creates `web:docs` instead of `web:tab_N`.

### App

An app instance is a topic. Same as web — pages change within the
app, but the session persists.

```
string:app:gmail
string:app:slack
string:app:gmail:work
string:app:gmail:personal
```

Apps can define multiple sessions using the `app:name:config` form.
This is how the same app serves different contexts — a work email
account and a personal one, each with its own state, each as a
separate topic.

Web and app topics follow the same grammar. The distinction is
semantic: web topics are general browsing sessions, app topics
are specific application instances with defined capabilities.

### Bash

A shell session is a topic. It works like a real terminal —
working directory, environment variables, and process state
persist across commands.

```
string:bash:dev
string:bash:deploy
string:bash:debug
```

Each named bash session is independent. `cd` in `bash:dev` doesn't
affect `bash:deploy`. Environment variables set in one don't leak
to another.

```
<𝒞=string:bash:dev>
cd ~/projects/myapp
export NODE_ENV=development
npm install
</𝒞>
```

The next command to `bash:dev` starts in `~/projects/myapp` with
`NODE_ENV=development` still set — exactly like a real terminal.

Bash topics don't have navigation history (`/back` doesn't apply).
They have command history and shell state instead.

### Bash topics and commands

Unlike other topic types, bash topics accept plain text as shell
input. The command-only requirement does not apply:

```
<𝒞=string:bash:dev>
echo "this is shell input, not a String command"
</𝒞>
```

This text goes to the shell's stdin. No `/` prefix needed.

To send String commands to a bash topic, use the `//` escape:

```
<𝒞=string:bash:dev>
//info
</𝒞>
```

The `//` prefix strips one slash, sending `/info` as a String command
instead of executing `//info` in the shell. This lets you run `/info`,
`/close`, and other String commands on bash topics while preserving
normal shell input for everything else.

---

## Home

Every AI agent in String has a home directory — a personal workspace
rooted at a known path.

Home is not part of the topic identifier — topics are session names,
not paths. Home is the root from which file paths in commands resolve:

```
/open report.md          → ~/report.md
/open ~/report.md        → ~/report.md
/open docs/report.md     → ~/docs/report.md
```

This is the Unix convention. AI models already understand `~` as home.
No new concept to learn.

---

## Path resolution

Topic identifiers are session names — no paths to resolve. Paths
appear inside commands and documents.

**In commands** — bare paths resolve from home (workspace root).

```
/open report.md                  → ~/report.md
/open docs/guide.md              → ~/docs/guide.md
```

Explicit relative paths (`./`, `../`) resolve from the current
document's directory when a document is open.

**Inside a document** — relative to the document's own location.

```markdown
# ~/docs/report.md

See the [appendix](./appendix.md)       ← ~/docs/appendix.md
Check the [config](../config.md)        ← ~/config.md
```

This matches every Markdown viewer — GitHub, Obsidian, VS Code.
Documents are portable.

---

## Multi-topic operation

AI can hold multiple topics open at once. Each topic is independent:

| Concern | Scope |
|---------|-------|
| History (`/back`) | Per topic |
| Current location | Per topic |
| Authentication | Per topic (web/app) |
| Working directory | Per topic (file) |

This enables workflows that require parallel context:

```
<𝒞=string:web:api_docs>
/open @authentication
</𝒞>

<𝒞=string:file:code>
/open ~/src/auth.md#oauth_flow
</𝒞>
```

The AI reads API documentation in one topic and edits code in another.
Both stay open. Both maintain their own position. The AI switches
between them as needed — no reloading, no lost state.

### Inspecting a topic

`/info` shows the current topic's state:

```
<𝒞=string:web:docs>
/info
</𝒞>
```

```
Session info
---
uri:       https://docs.example.com/api/auth
menus:     main
actions:   search(GET), get_token(POST)
history:   3 entries
vars:      {lang}="en", {version}="v2"
```

This tells the AI where it is (full URI), what state exists,
and what's available — without reading the whole document again.

For file topics, `/info` shows workspace-relative paths:

```
Session info
---
file:      docs/report.md
cwd:       ~/docs/
title:     Quarterly Report
history:   2 entries
```

### Listing topics

`/topics` shows all active topics. It works from any topic:

```
<𝒞=string:file:main>
/topics
</𝒞>
```

```
Active topics:

  file:main            file    current: #summary
  web:docs             web     current: /api/auth
  app:gmail:work       app     current: inbox
  bash:dev             bash    cwd: ~/projects/myapp

4 topics open.
```

Filter by type:

```
/topics web
```

```
  web:docs             current: /api/auth
  web:research         current: /pricing

2 web topics open.
```

Available type filters: `file`, `web`, `app`, `bash`. Filtering by
an unknown type is rejected with a clear message rather than
silently returning an empty list.

`/sessions` is a plural-form alias of `/topics` (same output, same
type filter). `/session list` is a legacy alias kept for older
agents — new code should prefer `/topics`.

### Closing topics

`/close` without arguments closes the **document** in the current
topic — the topic itself remains open as a doc-less shell that
`/open` can re-occupy without recreating session state:

```
<𝒞=string:web:docs>
/close
</𝒞>
```

To remove a topic entirely (drop its history, vars, bash session,
and unlist it from `/topics`), use `/session close <name>`:

```
<𝒞=string:file:main>
/session close bash:dev
/session close web:research
</𝒞>
```

The last remaining topic cannot be closed this way — there must
always be at least one. As a side effect, `/uninstall <pkg>`
automatically removes any topic whose current document points at
the package being deleted, so users don't have to clean up
zombie topics manually.

Closing discards the topic's state — history, variables, and
(for bash) the shell process. The topic can be reopened, but
it starts fresh.

---

## Shell execution

### /exec — stateless one-shot

`/exec` runs a shell command and returns the output. It is
stateless — each invocation starts clean with only base
environment variables.

```
<𝒞=string:file:main>
/exec npm test
</𝒞>
```

The command runs from the topic's base path. For file topics,
that's the current document's directory (or home if none is open).
For app/web topics, it's the app's workspace. Without a topic,
it runs from the AI's home directory:

```
<𝒞=string>
/exec ls ~/projects
</𝒞>
```

`/exec` doesn't remember previous runs. `cd` has no lasting
effect. Environment variables don't carry over. This makes it
safe and predictable — no hidden state, no side effects between
invocations.

### bash:name — stateful terminal

When the AI needs a real shell session, it opens a bash topic:

```
<𝒞=string:bash:build>
cd ~/project && npm run build
</𝒞>

<𝒞=string:bash:build>
npm run deploy
</𝒞>
```

The second command runs in `~/project` because the `cd` persisted.
This is a full shell session — working directory, environment
variables, shell history all maintained.

### When to use which

| | `/exec` | `bash:name` |
|---|---|---|
| State | None — clean each time | Full shell state |
| Base path | Topic's directory or `~` | Persisted `cwd` |
| Env vars | Base only | Accumulated |
| Use case | Quick checks, scripts | Development, builds, debugging |
| Risk | Low — isolated | Needs runtime boundary |

---

## Opening a new tab

Sometimes the AI needs to open a link in a new tab — keeping the
current session where it is, but starting a new one that inherits
the current state. Internally this forks the session — deep-copying
state into a new independent topic.

```
<𝒞=string:web:docs>
/open --tab research @api-reference
</𝒞>
```

This creates a new topic `web:research` by deep-copying the
current session's state:

| What gets copied | What doesn't |
|------------------|--------------|
| Variables | History |
| Authentication / cookies | Current location |
| Runtime configuration | |

The shortcut resolves in the current session's context, and the
new session starts at that destination with a clean history.
From this point, the two sessions are fully independent — changing
a variable in `web:research` does not affect `web:docs`.

This is the browser's "open in new tab" model. The new tab
inherits cookies and login state but lives on its own.

### When to fork

- Exploring a side link without losing your place
- Comparing two pages from the same authenticated site
- Branching a workflow into parallel tracks

### Works on any topic type

Though most common for web topics, it works on app topics too:

```
<𝒞=string:app:gmail:work>
/open --tab gmail-search @search
</𝒞>
```

Creates `app:gmail-search` with the same auth and variables as
`app:gmail:work`. File topics don't need fork — opening a
different file path already creates an independent topic.

---

## Summary

| Concept | Rule |
|---------|------|
| **Topic** | A named session — `type:name` format |
| **Syntax** | `[a-zA-Z0-9_-]+` names only — no dots, no paths |
| **Default** | Empty/bare → `file:main` |
| **File topic** | `file:name` — named workspace, navigate files within |
| **Web topic** | `web:name` — pages change, session persists |
| **App topic** | `app:name[:config]` — same as web, with multi-session support |
| **Bash topic** | `bash:name` — stateful shell session, like a real terminal |
| **Home** | `~` or bare path → agent's home directory (for commands, not topics) |
| **Document paths** | Relative to the document's own location |
| **State** | History, location, auth — all per topic |
| **`/exec`** | Stateless one-shot shell command from topic's base path |
| **`/topics [type]`** | List active topics, optionally filter by type. `/sessions` and `/session list` are aliases. |
| **`/close`** | Close the document in the current topic (topic itself remains) |
| **`/session close <name>`** | Remove a topic entirely from the topic list |
| **New tab** | `/open --tab name url` — deep-copy state into new topic |
