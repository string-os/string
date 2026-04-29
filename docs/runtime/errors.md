---
title: Errors
---

# Errors

When something goes wrong, String tells the AI what happened and
what it can do about it. Errors are plain text — readable, actionable,
and consistent across all commands.

---

## Error format

Every error follows the same structure:

```
✗ ERROR_CODE: message
  context
```

- **`✗`** — error indicator (vs `✓` for success)
- **Error code** — machine-readable identifier
- **Message** — human-readable description
- **Context** — actionable details (available options, suggestions)

---

## Error codes

### Navigation errors

**NOT_FOUND** — the topic does not exist.

```
/open ~/docs/missing.md
```

```
✗ NOT_FOUND: file not found
  path: ~/docs/missing.md
```

```
/open @nonexistent
```

```
✗ NOT_FOUND: shortcut not found
  @nonexistent is not defined in this document
  available: @docs, @pricing, @main.home, @main.api
```

**BLOCK_NOT_FOUND** — the file exists but the block doesn't.

```
/open ~/docs/report.md#missing
```

```
✗ BLOCK_NOT_FOUND: block #missing not found in ~/docs/report.md
  available blocks: #summary, #details, #appendix
```

---

### Editing errors

**INVALID_PATH** — the path is malformed or outside workspace.

```
/write /etc/passwd
```

```
✗ INVALID_PATH: path is outside workspace boundary
  workspace: ~/
  requested: /etc/passwd
```

```
/write ../../../etc/shadow
```

```
✗ INVALID_PATH: path traversal not allowed
  resolved: /etc/shadow (outside workspace)
```

**LINE_OUT_OF_RANGE** — line number doesn't exist.

```
/replace ~/docs/report.md:L500
new content
```

```
✗ LINE_OUT_OF_RANGE: line 500 does not exist
  ~/docs/report.md has 42 lines
```

**CONFLICT** — the file was modified externally since last read.

```
/replace ~/docs/report.md#summary
new summary
```

```
✗ CONFLICT: file has been modified since last read
  expected: hash abc123
  current:  hash def456
  use /refresh to reload, then retry
```

---

### Action errors

**ACTION_NOT_FOUND** — the action is not defined in the current
document.

```
/act.nonexistent --flag value
```

```
✗ ACTION_NOT_FOUND: action nonexistent is not defined
  available actions: search_city, create_alert
```

**INVALID_PARAMS** — required parameters missing or invalid.

```
/act.search_city
```

```
✗ INVALID_PARAMS: missing required parameter
  name: string (required) — not provided
  usage: /act.search_city --name "{City Name}"
```

```
/act.create_alert --condition "earthquake"
```

```
✗ INVALID_PARAMS: invalid value for condition
  expected: rain|snow|temp
  received: earthquake
```

**ACTION_FAILED** — the action executed but the backend returned
an error.

```
/act.search_city --name "Atlantis"
```

```
✗ ACTION_FAILED: upstream error (404)
  GET https://api.weather.com/search?name=Atlantis
  response: city not found
```

---

### Variable errors

**INVALID_VARIABLE** — `$` variable used in AI command.

```
/act.search --key $API_KEY
```

```
✗ INVALID_VARIABLE: runtime variable $API_KEY cannot be used in commands
  $variables are only allowed in document action definitions
```

**UNDEFINED_VARIABLE** — referenced variable has no value.

```
/act.get_repos --token {token}
```

```
✗ UNDEFINED_VARIABLE: {token} is not defined in current session
  use /set or an action response template to define it
```

---

### Command errors

**COMMAND_UNSUPPORTED** — input does not start with `/`.

```
<𝒞=string:file:main>
hello world
</𝒞>
```

```
✗ COMMAND_UNSUPPORTED: Commands must start with /. Use /help for details.
```

All input must be a command. Plain text is not accepted.

---

### Session errors

**INVALID_TARGET** — the topic identifier is malformed.

```
<𝒞=string:intro.md>
/open index.md
</𝒞>
```

```
✗ INVALID_TARGET: invalid topic "intro.md"
  format: type:name (e.g. file:main, web:docs, app:weather)
  names: [a-zA-Z0-9_-]+ only — no dots, no paths
```

**NO_HISTORY** — `/back` with nothing to go back to.

```
/back
```

```
✗ NO_HISTORY: no previous location in this topic
```

---

### Version errors

**NO_COMMITS** — `/log` on a file with no commits.

```
/log ~/docs/new-file.md
```

```
✗ NO_COMMITS: ~/docs/new-file.md has no commit history
  use /commit to create the first snapshot
```

**VERSION_NOT_FOUND** — requested version doesn't exist.

```
/open ~/docs/report.md@c99
```

```
✗ VERSION_NOT_FOUND: version c99 not found
  latest: c3
  use /log ~/docs/report.md to see available versions
```

---

## Error code reference

| Code | When |
|------|------|
| `NOT_FOUND` | File, URL, or shortcut doesn't exist |
| `BLOCK_NOT_FOUND` | Block ID not in document |
| `INVALID_PATH` | Path outside workspace or malformed |
| `LINE_OUT_OF_RANGE` | Line number exceeds file length |
| `CONFLICT` | File modified externally since last read |
| `COMMAND_UNSUPPORTED` | Input doesn't start with `/` (plain text rejected) |
| `ACTION_NOT_FOUND` | Action not defined in document |
| `INVALID_PARAMS` | Missing or invalid action parameters |
| `ACTION_FAILED` | Backend returned an error |
| `INVALID_VARIABLE` | `$var` used in AI command |
| `UNDEFINED_VARIABLE` | `{var}` has no value in session |
| `INVALID_TARGET` | Topic identifier malformed (dots, paths, unknown type) |
| `NO_HISTORY` | No previous location for `/back` |
| `NO_COMMITS` | No version history for file |
| `VERSION_NOT_FOUND` | Requested version doesn't exist |
| `LOAD_ERROR` | Network or I/O failure loading content |
| `AUTH_REQUIRED` | Topic requires authentication |

---

## How AI should handle errors

### Read and retry

Most errors include enough context to fix the issue:

```
✗ BLOCK_NOT_FOUND: block #sumary not found
  available blocks: #summary, #details

→ AI sees the typo, retries with #summary
```

### Fall back

When an action fails, try an alternative path:

```
✗ ACTION_FAILED: upstream error (503)

→ /back and try a different approach
→ or /refresh and retry later
```

### Ask for help

When the error is about permissions or missing configuration:

```
✗ AUTH_REQUIRED: https://api.example.com requires authentication

→ AI reports to user that authentication is needed
```

---

## Design principles

**Errors are text.** Not JSON error objects, not HTTP status codes
wrapped in XML. Plain text that any AI can read without a parser.

**Errors are actionable.** Every error includes context that helps
the AI fix the problem — available blocks, correct syntax, valid
options. The AI shouldn't need an extra round trip to figure out
what went wrong.

**Errors are consistent.** Same format across all commands. The AI
learns one error pattern and it works everywhere.

---

## Summary

| Principle | How |
|-----------|-----|
| **Format** | `✗ CODE: message` + context |
| **Context** | Available options, correct syntax, suggestions |
| **Actionable** | AI can fix and retry without extra round trip |
| **Consistent** | Same structure for all commands |
| **Plain text** | No special parsing needed |
