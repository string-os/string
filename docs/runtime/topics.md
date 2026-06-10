---
title: Topics
---

A topic is a session. Every command an AI sends through String is
directed at a specific topic — a free-form tab, an installed app, a
shell session, or a hub aggregator. Each topic maintains its own
state independently.

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
<𝒞=string:main>
/open ~/report.md#summary
</𝒞>

<𝒞=string:docs>
/open https://docs.example.com/getting-started
</𝒞>

<𝒞=string:app:gmail:work>
/act.compose --to "team@company.com"
</𝒞>
```

Three topics, three independent sessions. The AI can switch between
them freely. Each one remembers where it is.

A topic is a **sequential session** — its state (current document,
history, variables) is mutated by each command in order. Issuing two
commands against the *same* topic in parallel is a race: whichever
finishes last wins, and any relative-path resolution that depended on
the first command's "current document" can land on the wrong base.

For parallel reads, use distinct topics:

```
<𝒞=string:doc1>/open https://a/page1.md</𝒞>
<𝒞=string:doc2>/open https://a/page2.md</𝒞>
```

Sequential commands within the same topic are always safe.

---

## Topic syntax

There are four shapes:

| Shape | Form | Example |
|---|---|---|
| Tab (free-form) | bare name | `main`, `notes`, `research` |
| App (canonical) | `app:name` | `app:gmail`, `app:weather:korea` |
| Bash (canonical) | `bash:name` | `bash:dev`, `bash:deploy` |
| Hub (reserved bare names) | `app`, `bash`, `tool`, `event`, `system` | `app`, `event` |

Names match `[a-zA-Z0-9_-]+` — letters, numbers, hyphens, underscores
only. No dots, no paths, no spaces. Session names are short
identifiers, not file paths or URLs.

An empty or absent topic defaults to the tab `main`.

In ChanFlow: `string:<topic>`. In HTTP: body `{"topic": "<topic>"}`.

---

## Topic types

### Tab

A tab is a free-form session. Bare name, no prefix. The default kind.

```
string:main
string:docs
string:notes
string:research
```

A tab can hold any document — local file, remote URL, or nothing yet.
The session name is a workspace label, not a file path.

```
<𝒞=string:main>
/open ~/report.md
</𝒞>

<𝒞=string:main>
/open ~/docs/guide.md#setup
</𝒞>
```

Both commands target the same tab. History, current location, and
variables persist across navigations within that tab.

Multiple tabs let the AI organize work by context — a tab for
documentation, a tab for editing, a tab for browsing the web:

```
<𝒞=string:reading>
/open https://docs.example.com/api
</𝒞>

<𝒞=string:editing>
/open ~/src/handler.md
</𝒞>
```

Each tab maintains its own navigation history independently.

Relative paths in `/open` resolve from the current document's
directory. `[Next](./chapter2.md)` inside `~/docs/chapter1.md`
points to `~/docs/chapter2.md` — exactly as in any Markdown viewer.

### App

An app instance is a topic. Always carries the `app:` prefix.

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

App topics are *canonical*: opening an app target from any other
session redirects to the app's own topic, so app sessions stay clean
of unrelated content.

### Bash

A shell session is a topic. Always carries the `bash:` prefix.

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

#### Bash topics and commands

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

### Hub

Five bare names are reserved as **hub aggregators** — they route to
managed views over their kind rather than free-form tabs:

| Hub | What it manages |
|---|---|
| `app` | Installed apps + currently open app sessions |
| `bash` | Active bash sessions (list, spawn, kill) |
| `tool` | Installed tools |
| `event` | Pending and acknowledged local webhook events |
| `system` | Daemon status, env store, runtime controls |

```
string:app          # the app hub
string:bash         # the bash hub
string:event        # the event inbox hub
```

Because they're reserved, you cannot name a free-form tab `app`,
`bash`, `tool`, `event`, or `system`. `string app` always opens the
app hub, not a tab called `app`.

Open a hub to inspect its current state:

```
/open app
/open tool
/open bash
/open event
/open system
```

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
| Authentication / cookies | Per topic |
| Working directory | Per topic |

This enables workflows that require parallel context:

```
<𝒞=string:api_docs>
/open https://docs.example.com/api/auth
</𝒞>

<𝒞=string:code>
/open ~/src/auth.md#oauth_flow
</𝒞>
```

The AI reads API documentation in one tab and edits code in another.
Both stay open. Both maintain their own position. The AI switches
between them as needed — no reloading, no lost state.

### Inspecting a topic

`/info` shows the current topic's state:

```
<𝒞=string:docs>
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

For tabs holding a local file, `/info` shows workspace-relative paths:

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
<𝒞=string:main>
/topics
</𝒞>
```

```
Active topics:

  main                 tab     current: ~/report.md#summary
  docs                 tab     current: https://docs.example.com/api/auth
  app:gmail:work       app     current: inbox
  bash:dev             bash    cwd: ~/projects/myapp

4 topics open.
```

Filter by type:

```
/topics tab
```

```
  main                 current: ~/report.md#summary
  docs                 current: https://docs.example.com/api/auth

2 tab topics open.
```

Available type filters: `tab`, `app`, `bash`, `hub`. Filtering by
an unknown type is rejected with a clear message rather than
silently returning an empty list.

`/sessions` is a plural-form alias of `/topics` (same output, same
type filter).

### Closing topics

`/close` without arguments closes the **document** in the current
topic — the topic itself remains open as a doc-less shell that
`/open` can re-occupy without recreating session state:

```
<𝒞=string:docs>
/close
</𝒞>
```

To remove a topic entirely (drop its history, vars, bash session,
and unlist it from `/topics`), use `/session close <name>`:

```
<𝒞=string:main>
/session close bash:dev
/session close research
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
<𝒞=string:main>
/exec npm test
</𝒞>
```

The command runs from the topic's base path. For tabs holding a local
file, that's the current document's directory (or home if none is
open). For app sessions, it's the app's workspace. Without a current
document, it runs from the AI's home directory:

```
<𝒞=string:main>
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

## Summary

| Concept | Rule |
|---------|------|
| **Topic** | A named session — bare name (tab), `app:name`, `bash:name`, or reserved hub bare name |
| **Syntax** | `[a-zA-Z0-9_-]+` segments only — no dots, no paths |
| **Default** | Empty/missing → `main` (tab) |
| **Tab** | Bare name — free-form session, holds any document |
| **App topic** | `app:name[:config]` — canonical app instance |
| **Bash topic** | `bash:name` — stateful shell session, like a real terminal |
| **Hub** | `app`, `bash`, `tool`, `system` — reserved aggregator views |
| **Home** | `~` or bare path → agent's home directory (for commands, not topics) |
| **Document paths** | Relative to the document's own location |
| **State** | History, location, auth — all per topic |
| **`/exec`** | Stateless one-shot shell command from topic's base path |
| **`/topics [type]`** | List active topics, optionally filter by type. `/sessions` is an alias. |
| **`/close`** | Close the document in the current topic (topic itself remains) |
| **`/session close <name>`** | Remove a topic entirely from the topic list |
