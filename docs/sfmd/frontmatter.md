# Frontmatter

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
| `default` | string | Action to run on open (`act.{value}`) |
| `category` | string | `app` or `tool` — for registry classification |
| `env` | list | Required environment variables |

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
default: translate
env:
  - DEEPL_KEY: "DeepL API key"
  - TARGET_LANG: "Topic language code"
    default: en
---
```

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
