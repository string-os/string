# Blocks

Blocks are named regions within a document. They make sections
independently addressable — a block can be read or replaced
without loading the full document.

---

## Syntax

```markdown
<!-- #block_id -->
Content of the block.
Multiple lines allowed.
<!-- /block_id -->
```

- **Opening marker:** `<!-- #id -->`
- **Closing marker:** `<!-- /id -->`
- The ID in the opening and closing markers MUST match.
- Markers MUST each be on their own line.

---

## ID rules

Block IDs MUST follow these rules:

| Rule | Valid | Invalid |
|------|-------|---------|
| Lowercase letters | `summary` | `Summary` |
| Numbers allowed | `section2` | — |
| Hyphens allowed | `quick-start` | `quick_start` |
| Must start with a letter | `intro` | `2section` |
| No spaces | `action-items` | `action items` |

**Pattern:** `[a-z][a-z0-9-]*`

---

## Uniqueness

Block IDs MUST be unique within a document. Duplicate IDs are
an error.

```markdown
<!-- #intro -->
First intro.
<!-- /intro -->

<!-- #intro -->        ← ERROR: duplicate ID
Second intro.
<!-- /intro -->
```

---

## Nesting

Blocks MAY be nested. Each block MUST have a unique ID regardless
of nesting depth.

```markdown
<!-- #report -->
# Quarterly Report

<!-- #summary -->
Revenue grew 15%.
<!-- /summary -->

<!-- #details -->
Detailed breakdown follows.
<!-- /details -->

<!-- /report -->
```

Valid references: `#report`, `#summary`, `#details`.

Nested blocks are independently addressable — requesting `#summary`
returns only the summary content, not the full report.

---

## Empty blocks

A block with no content between markers is valid.

```markdown
<!-- #placeholder -->
<!-- /placeholder -->
```

---

## Block markers in CommonMark

Block markers are standard HTML comments. In any CommonMark viewer:

- They are invisible (HTML comments are not rendered)
- They do not affect the surrounding content
- The document reads as normal Markdown

This is how SFMD achieves block addressing without breaking
CommonMark compatibility.

---

## Addressing

Blocks are addressed using the fragment syntax:

```
document.md#block_id
```

When a block is requested:
- Only the content between the opening and closing markers is returned
- The markers themselves are not included in the extracted content
- Content outside the block is not included

---

## Rules summary

1. Opening marker: `<!-- #id -->` on its own line.
2. Closing marker: `<!-- /id -->` on its own line, matching ID.
3. IDs: `[a-z][a-z0-9-]*` — lowercase, no spaces, no underscores.
4. IDs MUST be unique within a document.
5. Nesting is allowed; each nested block is independently addressable.
6. Empty blocks are valid.
7. Unclosed blocks are an error.
8. A block without a matching closing marker is an error.
