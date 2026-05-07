---
title: Frontmatter
---

SFMD documents MAY begin with a YAML frontmatter block.

---

## Syntax

```
---
key: value
---
```

- Starts with a line containing exactly `---`
- Ends with a line containing exactly `---`
- MUST appear at the very beginning of the file (line 1)
- Content between delimiters is parsed as YAML

---

## Standard fields

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Document title |
| `description` | string | Brief summary of the document |
| `author` | string | Author name or identifier |
| `tags` | list | Categorization tags |
| `version` | string | Document version |

All fields are optional. Additional fields MAY be included.

---

## Runtime fields

These fields are defined by the String runtime. They are valid
SFMD frontmatter but have no effect in a plain CommonMark viewer.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | App or tool name (fallback: filename) |
| `namespace` | string | Publisher identifier (e.g. `cookbook`, `stringhub`). Combined with `name`, forms the package's canonical identity for collision detection at install time. |
| `type` | string | `app` or `tool` — for registry classification |
| `default` | string | Action to run on open (`act.{value}`) |
| `env` | list | Required environment variables |

### namespace + name as identity

When two publishers ship apps that share the same `name` (e.g.
`cookbook/weather` and `stringhub/weather`), the `(namespace, name)`
pair is what tells them apart. The runtime uses this pair on `/install`
to decide whether an existing local entry is a re-install of the same
package (allowed, in-place upgrade) or a different package colliding
on the same local name (rejected, with a hint to use `--as`).

`namespace` is optional. Apps without a namespace can still install,
but two such apps that share `name` will collide rather than coexist.

### type field

Replaces the older `category` field. Accepts `app` or `tool`. Used by
`/install` to decide registry placement (`apps[]` vs `tools[]` in
`config.json`) and by `/open app:<name>` / `/tool:<name>` to look the
package up. If frontmatter `type` is missing, the agent must pass
`--app` or `--tool` explicitly at install time.

### env field

Declares environment variables the document requires at runtime.
Each entry has a name, description, and optional default:

```yaml
env:
  - API_KEY: "Service API key"
  - LANG: "Output language"
    default: en
```

Variables without `default` are required. The runtime validates
them before executing actions and provides the description as a
hint on error.

---

## Examples

### Basic document

```markdown
---
title: Weather Dashboard
description: Real-time weather for configured cities
tags: [weather, dashboard]
---

# Weather Dashboard

Content starts here.
```

### App with default action

```markdown
---
name: weather
namespace: cookbook
type: app
description: Real-time weather dashboard
default: get_weather
---

# Weather Dashboard

`/act.get_weather --city "{city}"`
```

### Tool with env

```markdown
---
name: translate
type: tool
default: translate
env:
  - DEEPL_KEY: "DeepL API key"
  - TARGET_LANG: "Topic language code"
    default: en
---
```

---

## Convention: package root file

When packaging an app or tool for distribution (publishing or local
`/install`), the entry-point document MUST be named `string.md`. The
runtime locates a package by reading
`{home}/packages/{name}/string.md` and uses that file's frontmatter
to resolve the package's identity, type, default action, and env
declarations. Sibling `.md` files in the same directory are treated
as additional pages of a multi-file package and copied alongside
during install.

`/open app:<name>` and `/open tool:<name>` always resolve to the
registered package's `string.md`; navigation to other pages is
relative to that file.

---

## Rules

1. If present, frontmatter MUST be the first thing in the file.
   No blank lines or content before the opening `---`.
2. YAML content MUST be valid YAML.
3. Frontmatter is metadata — it is not rendered as document content.
4. A document without frontmatter is valid SFMD.
5. The closing `---` MUST be on its own line.
6. All standard and runtime fields are optional.
7. Unknown fields are preserved but ignored by the runtime.
