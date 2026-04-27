# Shortcuts

Shortcuts are named references that give stable, short identifiers
to URIs. They follow CommonMark's reference link pattern with an
`@` prefix.

---

## Two forms

### Inline form (recommended)

Defines a shortcut in a single line:

```markdown
[@id Label](url)
```

- `@id` — the shortcut identifier
- `Label` — human-readable display text
- `url` — the topic URI

This is syntactic sugar. String decomposes it into a reference link
and a reference definition internally.

### Reference form

Separates the display from the definition, following CommonMark's
reference link syntax:

```markdown
[Label][@id]

[@id]: url
```

The reference definition (`[@id]: url`) MAY be placed anywhere in
the document — typically grouped at the bottom.

### Both forms are equivalent

```markdown
# Inline form
[@docs Documentation](https://docs.example.com)

# Reference form — same result
[Documentation][@docs]

[@docs]: https://docs.example.com
```

The inline form is recommended for convenience. The reference form
is useful when the same shortcut is referenced multiple times or
when URLs are long and would clutter the content.

---

## AI view

Regardless of which form the author uses, String always presents
shortcuts to the AI as reference links:

**Author writes (inline):**
```markdown
Visit the [@docs Documentation](https://docs.example.com) for details.
```

**Author writes (reference):**
```markdown
Visit the [Documentation][@docs] for details.

[@docs]: https://docs.example.com
```

**AI sees (both cases):**
```markdown
Visit the [Documentation][@docs] for details.
```

The URL never enters the AI's context. The AI navigates with
`/open @docs`. String resolves the actual URI.

In a standard CommonMark viewer, the inline form renders as a
normal link. The reference form renders as a standard reference
link (CommonMark-compatible).

---

## ID rules

Shortcut IDs MUST follow these rules:

| Rule | Valid | Invalid |
|------|-------|---------|
| Lowercase letters | `@docs` | `@Docs` |
| Numbers allowed | `@section2` | — |
| Hyphens allowed | `@getting-started` | — |
| Underscores allowed | `@api_ref` | — |
| Must start with a letter | `@api` | `@2api` |
| MUST NOT start with `link-` | `@links` | `@link-1` |

**Pattern:** `@[a-z][a-z0-9_-]*`

The `link-` prefix is reserved for auto-generated shortcuts.
Named shortcuts MUST NOT use IDs starting with `link-`.

---

## Where shortcuts can appear

### Inline in documents

```markdown
Visit the [@docs Documentation](https://docs.example.com) for
more details, or see the [@changelog Changelog](./changelog.md).
```

### In nav menu files

Menu files consist of shortcut lines:

```markdown
[@home Home](../index.md)
[@api API Reference](../api/index.md)
```

### As reference definitions

Grouped at the bottom of a document or section:

```markdown
[@docs]: https://docs.example.com
[@api]: https://api.example.com/v2
[@pricing]: ./pricing.md
```

---

## Namespacing

Shortcuts are namespaced by their source.

### Page namespace

Shortcuts defined in the document (inline or reference) belong to
the `page` namespace. The prefix is implicit:

```
@docs  =  @page.docs
```

Both forms are valid. The short form `@docs` is preferred.

### Menu namespace

Shortcuts from nav menus are prefixed with the menu name:

**Menu file** (`nav/main.md`, menu name `main`):
```markdown
[@home Home](../index.md)
[@api API Reference](../api/index.md)
```

**AI sees:**
```
[Home][@main.home]
[API Reference][@main.api]
```

| Source | Namespace | AI sees | Full form |
|--------|----------|---------|-----------|
| Document `[@docs ...]` | `page` | `[@docs]` | `[@page.docs]` |
| Menu `main` `[@home ...]` | `main` | `[@main.home]` | `[@main.home]` |
| Menu `api` `[@auth ...]` | `api` | `[@api.auth]` | `[@api.auth]` |

---

## Auto-generated shortcuts

Regular Markdown links without explicit shortcut IDs are
automatically assigned identifiers by the runtime.

### Which links are converted

Only links with long or external topics are converted:

| Link topic | Converted? | Example |
|-------------|-----------|---------|
| `https://` or `http://` URL | Yes | `[Docs](https://docs.example.com)` |
| Relative path > 40 chars | Yes | `[Guide](./very/deep/nested/path/to/doc.md)` |
| Short relative path | No | `[Home](./index.md)` |

Short relative paths are already readable — no shortcut needed.
Author-defined shortcuts (`[@id Label](url)`) are never converted;
they keep their explicit ID.

### Slug assignment

The runtime attempts to derive a readable slug from the link label.
A slug is used when the label meets **all** of these conditions:

1. **20 characters or fewer**
2. **Contains only** letters, numbers, spaces, or hyphens
3. **Not a duplicate** of an already-assigned slug in the same document

The slug is produced by: lowercase → remove non-word characters
(except spaces and hyphens) → trim → replace spaces with hyphens.

```
GitHub           → github
MDN Web Docs     → mdn-web-docs
Example API      → example-api
```

### Duplicate slugs

When the same slug appears more than once, a numeric suffix is
appended starting from 2:

```
@docs       ← first occurrence
@docs-2     ← second
@docs-3     ← third
```

The suffix is per-slug — duplicates of `@docs` and duplicates of
`@github` maintain independent counters.

### Non-sluggable fallback (`@link-N`)

When the label does not qualify for a slug (too long, special
characters, or empty after sanitizing), the runtime assigns
`@link-N` where N increments from 1 per document:

| Condition | Label | Result |
|-----------|-------|--------|
| Exceeds 20 chars | `A Very Long Label That Exceeds Limit` | `@link-1` |
| Special characters | `C++ Reference (2024)` | `@link-2` |
| Empty slug | Label produces empty string after sanitizing | `@link-3` |

The `link-N` counter is independent from slug duplicate counters.

### Examples

**Source:**
```markdown
Visit [GitHub](https://github.com) for code.
Read the [MDN Web Docs](https://developer.mozilla.org) reference.
See [Docs](https://docs.first.com) and [Docs](https://docs.second.com).
And [Docs](https://docs.third.com) too.
Check [A Very Long Documentation Title Here](https://example.com/long).
Stay on [Home](./index.md).
```

**AI view:**
```markdown
Visit [GitHub][@github] for code.
Read the [MDN Web Docs][@mdn-web-docs] reference.
See [Docs][@docs] and [Docs][@docs-2].
And [Docs][@docs-3] too.
Check [A Very Long Documentation Title Here][@link-1].
Stay on [Home](./index.md).
```

- `@github`, `@mdn-web-docs`, `@docs` — label-derived slugs
- `@docs-2`, `@docs-3` — duplicate slug with suffix
- `@link-1` — non-sluggable fallback (label exceeds 20 chars)
- `[Home](./index.md)` — short relative path, not converted

### Rules

- Slugs and `@link-N` IDs belong to the `page` namespace.
- The `link-` prefix is reserved — named shortcuts MUST NOT use it.
- Auto-shortcuts are scoped to the current document. When the
  document changes, previous auto-shortcuts are invalidated.
- Same document content always produces the same auto-shortcuts
  (deterministic, top-to-bottom order).

---

## Uniqueness

- Inline shortcut IDs MUST be unique within a document.
- Menu shortcut IDs MUST be unique within a menu file.
- Same IDs in different menus are allowed (namespacing prevents
  collision: `@main.home` vs `@admin.home`).
- An inline shortcut MAY have the same ID as a menu shortcut.
  The inline shortcut takes priority during resolution.

---

## Resolution priority

When a shortcut reference like `[@id]` is resolved:

1. **Inline shortcuts** — defined in the current document
2. **Auto-generated shortcuts** — slugs, `@slug-N` duplicates, and `@link-N` fallbacks
3. **Menu shortcuts** — namespaced entries from nav menus

If a reference includes a namespace (`@main.home`), it resolves
directly to that menu. No priority lookup is needed.

---

## Rules summary

1. Inline form: `[@id Label](url)` — defines and displays in one line.
2. Reference form: `[Label][@id]` + `[@id]: url` — separated.
3. AI always sees: `[Label][@id]` — URL never in AI context.
4. IDs: `[a-z][a-z0-9_-]*` — MUST NOT start with `link-`.
5. Inline IDs MUST be unique within a document.
6. Menu IDs MUST be unique within a menu file.
7. Menu shortcuts are namespaced: `@menu_name.id`.
8. Inline shortcuts use implicit `page` namespace.
9. Auto-generated: external URLs and long paths only (short relative paths excluded).
10. Slug from label if ≤ 20 chars, alphanumeric/space/hyphen only, and non-empty.
11. Duplicate slugs: `@slug-2`, `@slug-3` (per-slug counter).
12. Non-sluggable fallback: `@link-N` (reserved prefix, global counter).
13. Resolution order: inline > auto > menu.
14. In CommonMark viewers, both forms render as standard links.
