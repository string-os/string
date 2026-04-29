---
title: Directives
---

# Directives

Directives are metadata declarations that use Markdown link syntax.
They tell the runtime about document structure but are not rendered
as content.

---

## Nav directive

Registers a navigation menu.

### Syntax

```markdown
[!nav:name](path)
```

- `name` — the menu identifier (used in `/nav name`)
- `path` — relative path to the menu file

### Example

```markdown
[!nav:main](./nav/main.md)
[!nav:api](./nav/api.md)
```

### Rules

1. The directive MUST be on its own line.
2. `name` MUST match `[a-z][a-z0-9-]*`.
3. `path` MUST be a relative path to a valid Markdown file.
4. Menu names MUST be unique within a document.
5. `page` is a reserved name — it MUST NOT be used as a menu name.
6. In a CommonMark viewer, the directive renders as a regular link.

### Menu file format

The file referenced by a nav directive contains shortcut lines:

```markdown
[@home Home](../index.md)
[@intro Introduction](../intro.md)
[@guide Blocks Guide](../guide/blocks.md)
```

Each line is a shortcut (see [05-shortcuts.md](./05-shortcuts.md)).
Paths are relative to the menu file's own location.

A menu file SHOULD contain only shortcut lines. Other content is
allowed but ignored by the runtime.

---

## Include directive

Includes content from another file inline.

### Syntax

```markdown
[!include:id](path)
[!include:id]()
```

- `id` — an identifier for the included content
- `path` — relative path to the source file (optional)

### Path resolution

When `path` is omitted (empty parentheses), the runtime resolves
it automatically:

```
[!include:id]()  →  filename.source/id.md
```

Where `filename` is the current document's name without extension.

For example, in `dashboard.md`:

```markdown
[!include:header]()     → dashboard.source/header.md
[!include:sidebar]()    → dashboard.source/sidebar.md
```

This convention keeps includes organized in a predictable location
without requiring the author to spell out paths. AI agents using
String access included content via `document.md#id` — they don't
need to know the underlying file structure.

### Example

```markdown
# With explicit path
[!include:footer](./partials/footer.md)
[!include:terms](./legal/terms.md)

# With auto-resolved path (recommended)
[!include:header]()
[!include:sidebar]()
```

### Rules

1. The directive MUST be on its own line.
2. `id` MUST match `[a-z][a-z0-9-]*`.
3. If `path` is provided, it MUST be a relative path to a valid
   Markdown file.
4. If `path` is omitted (empty `()`), the runtime resolves to
   `{filename}.source/{id}.md` relative to the current document.
5. Include IDs MUST be unique within a document.
6. Circular includes (A includes B includes A) are an error.
7. In a CommonMark viewer, the directive renders as a regular link.

### Block targeting

An include with explicit path MAY topic a specific block:

```markdown
[!include:pricing](products.md#pricing)
```

Only the content of the `#pricing` block from `products.md` is
included.

---

## Requirements directive

Points at a setup/install document for this app or tool. Recommended
(not required) — the convention is that any prerequisite work an agent
or operator needs to do once at install time (API keys, registration,
external accounts, runtime deps) lives in `requirements.md`, separate
from the always-loaded `string.md`. Keeps per-turn context small.

### Syntax

```markdown
[!requirements](path)
```

- No identifier — a document declares at most one requirements doc.
- `path` — relative path to the setup document.

### Auto-detection (local files only)

For documents loaded from `file://`, if a sibling file named
`requirements.md` exists next to the document, the runtime registers
it as the requirements doc automatically — no directive needed.

```
my-app/
├── string.md          ← agent-facing, loaded every turn
└── requirements.md    ← auto-detected, loaded only on /open
```

Web documents (loaded from `https://`) MUST declare the directive
explicitly; the runtime cannot probe sibling URLs over HTTP.

An explicit directive always overrides auto-detection — useful when
the setup doc lives elsewhere or has a different name.

### Runtime behavior

When a requirements doc is registered, `/open` of the parent document
prepends a one-line hint:

```
[setup] /open requirements.md
```

This tells the agent where to read setup info if an action fails on
missing credentials or unmet dependencies.

### Example

```markdown
# Moltbook 🦞

The social network for AI agents.

[!requirements](docs/install.md)
```

Or rely on auto-detection:

```
moltbook/
├── string.md
└── requirements.md    ← auto-registered
```

### Rules

1. The directive MUST be on its own line.
2. `path` MUST be a relative path or absolute URI to a valid Markdown file.
3. A document MUST declare at most one `[!requirements]` directive — later occurrences are ignored.
4. Auto-detection applies only to `file://` documents, only for the conventional name `requirements.md`.
5. An explicit directive overrides auto-detection.
6. In a CommonMark viewer, the directive renders as a regular link.

---

## Path notation

Directive and link paths SHOULD use bare relative form, not `./`:

```markdown
[!nav:main](nav/main.md)            ← preferred
[!nav:main](./nav/main.md)          ← discouraged
[!include:footer](partials/foot.md) ← preferred
[Setup](requirements.md)            ← preferred
```

The leading `./` is shell-shaped baggage; in Markdown contexts, bare
relative paths are unambiguous (`.md` extension distinguishes a file
from a registry name like `app:weather`). Both forms resolve identically,
but the bare form is the documented convention.

| Path | Meaning |
|------|---------|
| `foo.md` | Relative to current document |
| `dir/foo.md` | Relative subdirectory |
| `/abs/foo.md` | Absolute filesystem path |
| `https://...` | External URL |
| `app:name` | Installed app (registry lookup) |
| `tool:name` | Installed tool (registry lookup) |
| `@shortcut` | Resolved via document's shortcuts |

---

## Directive lines

Directives are identified by the `[!` prefix in link syntax.
Any line matching `[!type:name](path)` is a directive line.

Directive lines:
- Are parsed as metadata
- Are not shown as content to AI (in String runtime)
- Render as normal links in standard Markdown viewers

Currently defined directive types:

| Type | Purpose |
|------|---------|
| `nav` | Register a navigation menu |
| `include` | Include content from another file |
| `requirements` | Point at this app/tool's setup doc |

Unknown directive types SHOULD be ignored by parsers.
