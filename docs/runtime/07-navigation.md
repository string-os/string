# Navigation

Navigation is how AI moves through String — between documents,
within documents, across topics, and back through history. Two
commands handle everything: `/open` and `/nav`.

---

## /open

`/open` is the primary navigation command. It takes a single argument
and loads the result as Markdown.

### Open a document

```
/open index.md
/open ~/docs/report.md
/open /home/agent01/docs/report.md
```

All path forms work — relative, home-relative (`~`), or absolute.
Relative paths resolve from the current document's directory,
matching standard Markdown link behavior.

### Open a URL

```
/open https://docs.example.com
/open https://api.github.com/repos/user/repo
```

String fetches the page and converts it to Markdown. The AI reads
the same format regardless of what's behind the URL — a static site,
a web app, or an API endpoint.

### Open a shortcut

```
/open @home
/open @api
/open @getting-started
```

Shortcuts are named references defined in documents or navigation
menus. The AI doesn't need to know the actual path or URL — just
the shortcut name. String resolves it.

### Open a block (sub-resource)

```
/open report.md#summary
/open #pricing
```

Blocks are **sub-resources** — they belong to their parent document,
not standalone documents. Opening a block loads a specific section
instead of the whole document.

`#pricing` without a file path means a block in the current document.
The current document does not change — it's still the same page, just
a focused view. No history entry is pushed.

`report.md#summary` with a file path means: navigate to `report.md`
(this is a document change — pushes history), then view the `#summary`
block. The current document becomes `report.md`, not `report.md#summary`.

This distinction matters:
- **cwd** stays with the parent document
- **actions, shortcuts, variables** all belong to the parent document
- **history** only tracks document-level navigation

This is how String achieves token efficiency. A 500-line document
might have a 20-line block that the AI actually needs. `/open #block`
loads just that — without losing document context.

### Open an image (sub-resource)

```
/open @screenshot
/open ./images/diagram.png
```

Images are sub-resources, like blocks. Opening an image returns its
metadata (path, type, size) — the client library handles binary
conversion for the LLM API. The current document does not change.

### Open with combinations

These can be combined:

```
/open @docs#quickstart        → shortcut + block
/open ./guide/intro.md#setup  → relative path + block
```

---

## /nav

`/nav` shows available navigation. If `/open` is "go there",
`/nav` is "show me where I can go".

### Basic usage

```
/nav
```

If the total menu content is small, String expands everything
immediately — all menus with all entries, in a single response.
No extra turn needed.

```
Navigation:

main:
  [Home][@main.home]
  [Introduction][@main.intro]
  [Blocks Guide][@main.guide-blocks]

api:
  [Authentication][@api.auth]
  [Endpoints][@api.endpoints]
```

If menus are large, String shows menu names only and the AI
requests a specific menu with `/nav main`.

### Namespaced shortcuts

Menu entries are namespaced by menu name. The nav file is authored
with simple shortcut IDs:

```markdown
# nav/main.md (what the author writes)
[@home Home](../index.md)
[@intro Introduction](../intro.md)
```

But String presents them to the AI with the menu name prefix:

```
# What AI sees
[Home][@main.home]
[Introduction][@main.intro]
```

This prevents collisions when multiple menus exist:

```
@main.home   → index.md
@admin.home  → admin/index.md
```

The AI navigates with `/open @main.home`. The namespace is always
the menu name.

### /nav page

`page` is a reserved name that shows all shortcuts on the current
page — both named shortcuts and auto-generated ones from regular
Markdown links. Menu entries are excluded.

```
/nav page
```

```
Shortcuts (current page):
  [@docs Documentation]         → https://docs.example.com
  [@pricing Pricing]            → ./pricing.md
  [@getting-started Getting Started] → https://long-url.com/getting-started
  [@api-reference API Reference]    → https://long-url.com/api/v2/ref
```

`@docs` and `@pricing` are named shortcuts the author defined.
`@getting-started` and `@api-reference` are auto-generated from
regular Markdown links — String slugifies the label so AI never
has to deal with raw URLs.

### /nav --resolve

Shows all accessible shortcuts from the current page — menus and
page shortcuts combined — with their resolved paths.

```
/nav --resolve
```

```
All shortcuts:
  @main.home          → ~/index.md
  @main.intro         → ~/intro.md
  @main.guide-blocks  → ~/guide/blocks.md
  @api.auth           → ~/api/auth.md
  @docs               → https://docs.example.com  (inline)
  @pricing            → ~/pricing.md              (inline)
  @getting-started    → https://long-url.com/...  (auto)
```

This is the complete map of everywhere the AI can go from the
current page. Useful for understanding structure and debugging.

### Why /nav exists separately

`/nav` could have been part of `/open`. It's separate because
navigation menus are metadata — they describe the structure around
the current document, not the document's own content.

Keeping `/nav` separate means:
- The document content stays clean (no menu data mixed in)
- AI can check available paths without leaving the current page
- Menus can be large — `/nav` loads them on demand, not by default

---

## Navigation menus

A navigation menu is a plain Markdown file containing a list of
shortcuts. Nothing more.

### Declaring a menu

In any SFMD document, a nav directive registers a menu:

```markdown
[!nav:main](./nav/main.md)
```

- `main` is the menu name
- `./nav/main.md` is the path to the menu file
- The directive line is metadata — String parses it but doesn't
  show it to the AI as content

### Menu file format

The menu file is a list of shortcuts:

```markdown
[@home Home](../index.md)
[@intro Introduction](../intro.md)
[@guide-blocks Blocks Guide](../guide/blocks.md)
[@guide-nav Navigation Guide](../guide/navigation.md)
[@guide-shortcuts Shortcuts Guide](../guide/shortcuts.md)
[@for-ai For AI Agents](../for-ai.md)
```

Each line follows the shortcut syntax: `[@id Label](path)`.

Paths in the menu file are relative to the menu file's location —
not the document that references it. This is consistent with how
Markdown links always work.

### Multiple menus

A document can declare multiple menus for different purposes:

```markdown
[!nav:main](./nav/main.md)
[!nav:api](./nav/api-reference.md)
[!nav:admin](./nav/admin.md)
```

AI can inspect each one independently with `/nav main`, `/nav api`,
`/nav admin`.

### Shared menus

Multiple documents can reference the same menu file:

```markdown
# index.md
[!nav:main](./nav/main.md)

# intro.md
[!nav:main](./nav/main.md)

# guide/blocks.md
[!nav:main](../nav/main.md)
```

One menu file, consistent navigation across the entire site.
Updating the menu file updates navigation everywhere.

---

## Shortcuts

Shortcuts are named references that give stable, short identifiers
to paths and URLs.

### In documents

```markdown
[@docs Documentation](https://docs.example.com/v2/reference)
[@pricing Pricing Page](./pricing.md)
```

When AI reads the document through String, it sees:

```markdown
[Documentation][@docs]
[Pricing Page][@pricing]
```

The full path is stripped. The AI navigates with `/open @docs` —
clean, short, and independent of the underlying URL. If the URL
changes tomorrow, the shortcut stays the same.

### In nav menus

Menu files are entirely made of shortcuts. The author writes:

```markdown
[@home Home](../index.md)
[@api API Reference](../api/index.md)
```

The AI sees them namespaced: `@main.home`, `@main.api`. It navigates
with `/open @main.home`.

### Auto-generated shortcuts

Regular Markdown links without explicit shortcut IDs get
auto-generated names. Only external URLs (`https://`, `http://`)
and very long relative paths (> 40 chars) are converted. Short
relative paths like `[Home](./index.md)` stay as-is.

String derives a slug from the link label when:

1. Label is **20 characters or fewer**
2. Label contains **only** letters, numbers, spaces, or hyphens
3. The slug is **not already taken** in this document

The slug is: lowercase → remove special chars → trim → spaces
become hyphens. `MDN Web Docs` → `@mdn-web-docs`.

When the same slug appears more than once, a numeric suffix is
appended: `@docs`, `@docs-2`, `@docs-3`. Each slug maintains its
own counter.

When the label can't produce a slug at all (too long, special chars),
String falls back to `@link-N` (N increments from 1, independent
from slug counters).

```markdown
# Source
Visit [GitHub](https://github.com) for code.
Read [Docs](https://docs.first.com) here.
Also [Docs](https://docs.second.com) here.
And [Docs](https://docs.third.com) too.
Check [A Very Long Documentation Title](https://example.com/x).
Stay on [Home](./index.md).

# AI sees
Visit [GitHub][@github] for code.
Read [Docs][@docs] here.
Also [Docs][@docs-2] here.
And [Docs][@docs-3] too.
Check [A Very Long Documentation Title][@link-1].
Stay on [Home](./index.md).
```

- `@github`, `@docs` — label-derived slugs
- `@docs-2`, `@docs-3` — duplicate slug with suffix
- `@link-1` — non-sluggable fallback (label exceeds 20 chars)
- `./index.md` — short relative path, not converted

Same document content always produces the same auto-shortcuts —
deterministic, top-to-bottom order. AI can rely on them being
stable across sessions.

The raw URL never enters the AI's context. Auto-generated shortcuts
are visible through `/nav page`.

The `link-` prefix is reserved for auto-generated shortcuts.
Named shortcuts MUST NOT use IDs starting with `link-`.

### Shortcut resolution

When AI issues `/open @shortcut`, String resolves it in this order:

1. **Current document shortcuts** — named inline shortcuts (`@docs`)
2. **Auto-generated shortcuts** — slugs (`@github`), duplicates (`@docs-2`), fallbacks (`@link-1`)
3. **Menu shortcuts** — namespaced entries (`@main.home`)
4. **Not found** — error if no match

Document shortcuts take priority over menu shortcuts of the same
name, allowing local overrides. Namespaced menu shortcuts
(`@main.home`) are always unambiguous.

Note: page shortcuts belong to the `page` namespace. `@docs` is
shorthand for `@page.docs` — the `page.` prefix is implicit.
Both `@docs` and `@page.docs` resolve to the same topic.
The short form is preferred.

---

## History and /back

Every topic maintains its own navigation history — a stack of
previously visited **documents** (not sub-resources).

```
/open index.md          → history: [index.md]
/open @guide            → history: [index.md, guide/intro.md]
/open #advanced         → still guide/intro.md — no history push
/open other.md#setup    → history: [index.md, guide/intro.md, other.md]
                          (document changed to other.md, viewing #setup block)
/back                   → returns to guide/intro.md
/back                   → returns to index.md
```

Notice: `/open #advanced` doesn't push history because blocks are
sub-resources of the current document. The current document is still
`guide/intro.md` — the AI is just viewing a section of it. `/back`
from this state would go to `index.md`, not "back to the full page".

`/open other.md#setup` does push because the document changes from
`guide/intro.md` to `other.md`. The `#setup` part is just the initial
view within `other.md`.

### Sub-resources don't change context

When viewing a block or image, everything stays with the parent document:

| Property | Stays with... |
|----------|---------------|
| cwd | Parent document's directory |
| Shortcuts | Parent document's shortcuts |
| Actions | Parent document's actions |
| Variables | Parent document's variables |
| History position | Parent document |

The block is a **view** of the document, not a separate location.

### Per-topic history

History is scoped to the topic. Navigating in one topic doesn't
affect another:

```
<𝒞=string:web:docs>
/open @api              → docs tab history grows
</𝒞>

<𝒞=string:web:research>
/back                   → research tab history, unaffected by docs
</𝒞>
```

### What enters history

- `/open document` pushes to history (document-level navigation)
- `/open #block` does NOT push (sub-resource view)
- `/open image` does NOT push (sub-resource view)
- `/back` pops from history (go back one document)
- `/refresh` does not push (reloads in place)
- `/nav` does not push (it's a query, not a navigation)

---

## Path resolution rules

Paths resolve based on context. Two rules cover everything:

### Rule 1: Document links — relative to the document

Inside a Markdown document, all relative paths resolve from that
document's own directory:

```markdown
# Located at ~/docs/guide/intro.md

[Next chapter](./advanced.md)        → ~/docs/guide/advanced.md
[Back to docs](../index.md)          → ~/docs/index.md
[Home](../../index.md)               → ~/index.md
```

This matches every Markdown viewer — GitHub, Obsidian, VS Code.
Documents are portable.

### Rule 2: AI commands — relative to current location

When AI issues a command, relative paths resolve from the current
document's directory (same as Rule 1):

```
# Currently viewing ~/docs/guide/intro.md

/open ./advanced.md                  → ~/docs/guide/advanced.md
/open ../index.md                    → ~/docs/index.md
```

Absolute and home paths always resolve the same way:

```
/open ~/config.md                    → ~/config.md
/open /home/agent01/config.md        → /home/agent01/config.md
```

---

## Putting it together

A typical navigation flow:

```
/open index.md
  → AI reads the document content
  → menus are small, so nav is auto-expanded:
    [Home][@main.home]
    [Introduction][@main.intro]
    [Blocks Guide][@main.guide-blocks]

/open @main.guide-blocks
  → AI reads the blocks guide, sees <!-- #examples --> block
  → current document: guide/blocks.md
  → history: [index.md, guide/blocks.md]

/open #examples
  → AI loads just the examples section (token efficient)
  → current document is still guide/blocks.md (block = sub-resource)
  → history unchanged: [index.md, guide/blocks.md]

/nav page
  → AI sees all shortcuts on this page (guide/blocks.md's shortcuts):
    @commonmark → https://commonmark.org/...
    @advanced-blocks → ./advanced-blocks.md

/open @advanced-blocks
  → navigates to advanced-blocks.md (document change)
  → history: [index.md, guide/blocks.md, guide/advanced-blocks.md]

/back
  → returns to guide/blocks.md

/back
  → returns to index.md
```

The AI always knows three things:
1. **Where it is** — the current document (blocks/images don't change this)
2. **Where it can go** — `/nav` shows menus, `/nav page` shows page links
3. **Where it's been** — `/back` retraces document-level steps

---

## Summary

| Command | What it does |
|---------|-------------|
| `/open path` | Navigate to a document (pushes history) |
| `/open @shortcut` | Navigate via named reference |
| `/open path#block` | Navigate to document, view block |
| `/open #block` | View block in current document (no history push) |
| `/open image` | View image metadata (sub-resource, no history push) |
| `/nav` | List menus (auto-expands if small) |
| `/nav name` | Show entries in a specific menu |
| `/nav page` | Show all shortcuts on current page |
| `/nav --resolve` | Show all shortcuts with resolved paths |
| `/back` | Return to previous document |
| `/refresh` | Reload current document |

| Concept | Rule |
|---------|------|
| **Nav directive** | `[!nav:name](path)` — declares a menu |
| **Menu file** | Plain `.md` with shortcut lines |
| **Namespacing** | Menu entries shown as `@menu.id` |
| **Shortcut** | `[@id Label](path)` — named reference |
| **Auto-shortcut** | Regular links → slug, `@slug-2`, or `@link-1` |
| **Sub-resource** | Blocks and images — belong to parent document |
| **Path resolution** | Relative to the document's own location |
| **History** | Per topic, document-level only, push on `/open`, pop on `/back` |
| **Shortcut priority** | Document > auto > menu (namespaced) |
| **Reserved name** | `page` — cannot be used as menu name |
