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
[!include:pricing](./products.md#pricing)
```

Only the content of the `#pricing` block from `products.md` is
included.

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

Unknown directive types SHOULD be ignored by parsers.
