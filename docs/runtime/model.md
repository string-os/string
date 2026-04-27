# The Model

String has two layers: a **context layer** and an **action layer**.

The context layer is what AI sees — Markdown. The action layer is what
AI does — a small set of commands. Everything in String flows through
these two layers.

---

## Context layer: text

String operates on text. Any text.

An AI agent running in String can open a plain `.txt` file, a CSV,
a log dump, or a configuration file. String does not reject content
based on format. If it is text, it is readable.

But String is optimized for a specific kind of text.

### The context hierarchy

```
text             — String can handle any text
  → Markdown     — String prefers Markdown
    → SFMD       — String is optimized for SFMD
```

**Text** is the universal baseline. String accepts it all.

**Markdown** is the preferred format. AI models have been trained on
more Markdown than any other structured format. They parse it
effortlessly, generate it naturally, and reason about it accurately.
Markdown is to AI what pixels are to human eyes — the native medium
of perception.

**SFMD** (String Flavored Markdown) is to String what GFM is to GitHub.
CommonMark with a small set of extensions that make documents
self-describing. When AI operates through String on SFMD documents,
the experience is fully optimized — navigation, block addressing,
actions, and shortcuts all work seamlessly.

### SFMD design principles

SFMD is governed by three rules:

**1. 100% CommonMark compliant.**
Every SFMD document is a valid CommonMark document. It renders correctly
in GitHub, VS Code, Obsidian, or any standard Markdown viewer. SFMD
adds meaning through constructs that CommonMark already allows — links,
comments, and list items. It never breaks the spec.

**2. Maximized usability with String.**
When an AI agent uses SFMD through String, it gets the full benefit:
block-level addressing for token efficiency, navigation menus for
spatial awareness, declared actions for self-describing capabilities,
and shortcuts for clean references. This is the optimized path.

**3. Fully usable without String.**
An AI that reads an SFMD document as plain Markdown — without any
String runtime — can still understand 100% of the content and act
on it. The navigation directives look like normal links. The action
declarations are readable text. The block markers are HTML comments.
Nothing is hidden. Efficiency and convenience are reduced, but no
context is lost.

This third principle is critical. It means SFMD is never a lock-in.
Any AI model, in any environment, can read an SFMD document and
understand what it says and what it offers. String makes it better.
It does not make it required.

### SFMD extensions

With these principles in place, SFMD adds four constructs to
CommonMark:

#### Blocks

Named regions within a document, addressable by ID.

```markdown
<!-- #pricing -->
Plans start at $10/month for individual use.
Enterprise pricing is available on request.
<!-- /pricing -->
```

An AI can request just `page.md#pricing` instead of loading the entire
document. This is how String achieves token efficiency — the AI reads
only what it needs.

#### Navigation

Menus that tell the AI where it can go.

```markdown
[!nav:main](./nav/main.md)
```

The referenced file contains a list of shortcuts:

```markdown
[@home Home](../index.md)
[@api API Reference](../api/index.md)
[@guide Getting Started](../guide/intro.md)
```

String presents these to the AI with the menu name as namespace:

```
[Home][@main.home]
[API Reference][@main.api]
[Getting Started][@main.guide]
```

When AI opens a document with a nav directive, it knows the full
topology of the system — what exists, what it's called, and how
to get there. The AI navigates with `/open @main.home`.

#### Actions

Declarations of what can be done, defined in fenced code blocks.

````markdown
`/act.search --q "{query}" --limit "{max results}"`

```act.search
GET https://api.example.com/search
  q: string (required)
  limit: number (optional, max:50)
```
````

The AI sees the invocation hint — one line showing how to call it.
The code block contains the full spec — type, endpoint, parameters.
String parses the code block; the AI doesn't need to read it.

#### Shortcuts

Named references that compress long URIs into short identifiers.

```markdown
[@docs Documentation](https://docs.example.com/v2/reference)
```

AI sees `[Documentation][@page.docs]` — short, readable, and stable.
Inline shortcuts use the `page` namespace (often omitted as `@docs`).
The full URI is resolved by the runtime, not consumed by the AI.

#### What this adds up to

A plain Markdown file becomes a self-describing interface:

````markdown
[!nav:main](./nav/main.md)

# Documentation

Welcome to the docs.

`/act.search --q "{query}"`

```act.search
GET /api/search
  q: string (required)
```

<!-- #quickstart -->
## Quick Start
Install with `npm install string-sdk` and follow the guide.
<!-- /quickstart -->
````

An AI reading this document immediately knows:
- There is a navigation menu called `main` with links to other pages
- There is a `search` action it can call with `/act.search --q "..."`
- There is a block called `quickstart` it can address directly
- All of this without any external schema, adapter, or configuration

---

## Action layer: commands

AI acts through commands. The full set is small by design.

### The two primitives

Almost everything an AI does in String reduces to two operations:

**`/open`** — see something.

```
/open index.md              → open a local document
/open https://docs.site.com → open a remote page
/open @main.api             → follow a navigation shortcut
/open report.md#summary     → open a specific block
```

`/open` is how AI navigates. It loads a document (or a block within
a document), resolves all SFMD directives, and returns the result as
Markdown. The AI reads, understands, and decides what to do next.

**`/act`** — do something.

```
/act.search --q "authentication"
/action.search --q "authentication"
/act search --q "authentication"
/action search --q "authentication"
```

`/act` executes a declared action. `/act` and `/action` are
interchangeable, as are dot-notation and space-separated forms —
all four combinations are equivalent. The AI provides the action ID
and arguments using POSIX CLI syntax — flags and values, not JSON.
The runtime validates required fields, sends the request, and returns
the response — as Markdown. The AI can then navigate that response
like any other document.

### Supporting commands

A small set of additional commands covers navigation and file operations:

| Command | Purpose |
|---------|---------|
| `/nav [name]` | List navigation menus or show a specific menu |
| `/nav page` | Show all shortcuts on current page |
| `/nav --resolve` | Show all shortcuts with resolved paths |
| `/back` | Return to previous document |
| `/edit topic` | Open a document in edit mode (same as `/open --edit`) |
| `/ls [path]` | List files in workspace |
| `/write path[#block]` | Create or overwrite a file (or block) |
| `/append path` | Append content to an existing file |
| `/replace path#block` | Replace a block's content |
| `/replace path:L5[-L10]` | Replace a line or line range |
| `/undo` | Revert the last edit (one time) |
| `/commit path --message "..."` | Create a version snapshot |
| `/log path` | Show version history |
| `/set` | Set variables in current topic |
| `/exec command` | Run a shell command (stateless, from topic's base path) |
| `/topics [type]` | List active topics, optionally filter by type |
| `/close [topic]` | Close current or specified topic |
| `/info` | Show topic state — URI, type, variables, history depth |
| `/refresh` | Reload current document |

Note the distinction: `/edit` opens a document for editing (a view
command). Actual content changes go through `/write`, `/append`, and
`/replace` (modification commands).

### Why so few

Traditional systems give AI hundreds of API endpoints, each with its
own schema, authentication, and error semantics. Every new system
means a new set of endpoints to learn.

String inverts this. The command set is fixed and tiny — it never
grows. New capabilities come from new documents, not new commands.
A search system, a deployment pipeline, and an email service all
use the same `/open` and `/act`. The difference is in the documents,
not the interface.

This is what an OS does. The system calls don't change when you
install a new application.

---

## The recursive property

There is one more property that ties the two layers together.

Every response in String is itself a Markdown document.

When AI calls `/act.search --q "auth"`, the response is not raw
JSON or a status code. It is a Markdown document — potentially with
its own blocks, navigation, and actions.

```
/act.search --q "auth"
```

Response:

```markdown
# Search Results: "auth"

<!-- #results -->
3 results found.

1. [Authentication Guide][@main.auth] — How to set up OAuth2
2. [API Keys][@main.keys] — Managing API credentials
3. [Security Policy][@main.security] — Access control overview
<!-- /results -->

`/act.search --q "{query}" --limit "{max results}"`

```act.search
GET https://api.example.com/search
  q: string (required)
  limit: number (optional)
```
```

The AI can now follow any of these links, refine the search, or
navigate somewhere else entirely. The result of an action is not a
dead end — it is a new starting point.

This is what makes String recursive:

```
open document → discover capabilities → act → receive document → repeat
```

The AI is never stuck. Every response opens new paths. This loop is
the fundamental interaction model of String, and it runs without
any human intervention or pre-programming.

---

## The full picture

```
┌──────────────────────────────────────────────┐
│                 AI Agent                     │
│                                              │
│  reads: Markdown                             │
│  acts:  /open  /act  /nav  /write  /edit     │
└─────────────────┬────────────────────────────┘
                  │
┌─────────────────▼────────────────────────────┐
│              String Runtime                  │
│                                              │
│  session    workspace    history              │
│  resolve    validate     route                │
└─────────────────┬────────────────────────────┘
                  │
┌─────────────────▼────────────────────────────┐
│            SFMD Documents                    │
│                                              │
│  blocks    nav    actions    shortcuts        │
│                                              │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐     │
│  │ file │  │ web  │  │ app  │  │ API  │     │
│  └──────┘  └──────┘  └──────┘  └──────┘     │
└──────────────────────────────────────────────┘
```

The AI sees only the top: Markdown and commands.

The runtime handles the middle: sessions, workspaces, resolution.

The documents sit at the bottom: self-describing interfaces to
files, web pages, applications, and APIs.

The AI doesn't know or care what's behind a document. It could be
a local file, a remote website, or a complex application with a
database backend. The interface is always the same — Markdown in,
commands out, Markdown back.

---

## Summary

| Layer | What | How |
|-------|------|-----|
| **Context** | What AI sees | Markdown (CommonMark + SFMD extensions) |
| **Action** | What AI does | `/open` and `/act` (+ supporting commands) |
| **Runtime** | What manages state | Sessions, workspace, history, resolution |
| **Documents** | What describes systems | Self-describing SFMD with blocks, nav, actions |

Two design principles hold it together:

1. **Use what AI already knows** — Markdown and natural-language commands
2. **Minimize the interface** — new capabilities come from new documents,
   not new commands

This is the model. The next section shows how it feels in practice —
the loop an AI agent runs through when it uses String.
