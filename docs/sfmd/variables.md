---
title: Variables
---

Variables are named references that are substituted with values
at runtime. SFMD defines the syntax for referencing variables —
storage and resolution are handled by the runtime.

---

## Two variable types

| Syntax | Type | Purpose |
|--------|------|---------|
| `{name}` | Session variable | Runtime data flow between actions |
| `$NAME` | Persistent variable | Configuration, credentials, settings |

---

## Session variables: `{name}`

### Syntax

```
{variable_name}
```

Curly braces around an identifier.

### ID rules

| Rule | Valid | Invalid |
|------|-------|---------|
| Lowercase letters | `{city}` | — |
| Numbers allowed | `{temp2}` | — |
| Underscores allowed | `{current_temp}` | — |
| Must start with a letter | `{token}` | `{2token}` |

**Pattern:** `\{[a-z][a-z0-9_]*\}`

### Where they appear

Session variables can appear in:

- Response templates (assignment and output lines)
- Action definition URIs and headers
- Action invocation arguments (AI commands)

```
{city} = {Response.body.city}
## Weather in {city}
```

```
/act.search --city {city}
```

---

## Persistent variables: `$NAME`

### Syntax

```
$VARIABLE_NAME
```

Dollar sign followed by an identifier.

### ID rules

| Rule | Valid | Invalid |
|------|-------|---------|
| Uppercase letters | `$API_KEY` | — |
| Numbers allowed | `$KEY2` | — |
| Underscores allowed | `$DEFAULT_REGION` | — |
| Must start with a letter | `$TOKEN` | `$2TOKEN` |
| Lowercase allowed | `$api_key` | — |

**Pattern:** `\$[a-zA-Z][a-zA-Z0-9_]*`

Convention: uppercase for configuration (`$API_KEY`), but not
enforced.

### Where they appear

Persistent variables can ONLY appear in:

- Action definition blocks (`act.name` code blocks)

```
GET https://api.example.com/search?key=$API_KEY
```

Persistent variables MUST NOT appear in:

- AI command arguments (use `{var}` instead)
- Response template assignments

This keeps a clean separation: `$var` is wired into action
definitions by document developers; AI uses `{var}` in commands.

### Resolution order

When the runtime encounters `$NAME` in an action definition (URL,
headers, or body template), it resolves the value using this cascade:

1. **Per-call extra env** — context variables passed programmatically
   by the caller (tool context vars in tool blocks, etc.).
2. **SFMD env-store** — app/config persistent values set via
   `/set $NAME = "value"` from an `app:<name>` or
   `app:<name>:<config>` topic. Config scope wins over app scope.
3. **Unresolved** — if none of the above have a value, the action
   fails before execution with `INVALID_PAYLOAD`.

There is no global fallback and no daemon `process.env` fallback for
action `$VAR` substitution. That isolation keeps one installed app
from reading credentials intended for another.

---

## Assignment syntax

Variables are assigned in response templates:

```
{variable} = {expression}
```

### Rules

1. Assignment is a full line: `{id} = {expression}`.
2. Left side MUST be a session variable: `{name}`.
3. Right side is an expression that resolves to a value.
4. Assignment lines produce no output.
5. Only `{variables}` can be assigned. `$variables` cannot.

### Expression types

| Expression | Meaning |
|-----------|---------|
| `{Response.body.field}` | Value from action response |
| `{Response.body.nested.field}` | Nested response value |
| `{Response.status}` | HTTP status code |
| `"literal"` | Literal string value |
| `{other_variable}` | Value of another variable |

### Examples

```
{city} = {Response.body.city}
{temp} = {Response.body.temperature}
{status} = {Response.status}
{label} = "default"
```

---

## Reference in templates

Variables in output lines are substituted with their values:

```
## Weather in {city}
- Temperature: {temp}°C
```

If a variable has no value, the reference is left as-is or
replaced with an empty string (runtime-dependent).

---

## Scope

| Variable type | Scope |
|--------------|-------|
| `{variable}` | Topic session — each topic has its own set |
| `$VARIABLE` | App/config persistent — with cascade (config > app) |

Session variables in a topic override persistent variables of the
same name within that topic's scope.

---

## Rules summary

1. Session variables: `{name}` — `[a-z][a-z0-9_]*` in curly braces.
2. Persistent variables: `$NAME` — `[a-zA-Z][a-zA-Z0-9_]*` with `$` prefix.
3. `{var}` can appear in templates, invocations, and action definitions.
4. `$VAR` can ONLY appear in action definition blocks (URL, headers, body template).
5. `$VAR` resolution cascade: per-call extra env → config env → app env → unresolved error.
6. Assignment: `{var} = {expression}` — full line, no output.
7. Only `{var}` can be on the left side of assignment.
8. `{var}` is session-scoped. `$VAR` is persistent per app/config scope.
9. Topic `{var}` overrides `$VAR` of the same name in that scope.
10. Response paths accept three array-index forms, all equivalent:
    `body.items[0].name`, `body.items.0.name`, and `$.body.items[0].name`
    (leading `$.` is ignored for JSONPath compatibility).
