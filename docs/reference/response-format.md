---
title: Response Format
---

Every String command response is composed of two parts: a **system
message** (meta information) and optional **content** (actual data).

- Commands that return content: `system message\n---\ncontent`
- Commands that return only a confirmation: system message alone (no `---`)
- The daemon prepends `re: [request_id] /cmd` before the body

Final form example:

```
re: [003qm] /open hello.md
Opened hello.md
---
# Hello World
Welcome
```

---

## Command classification

### A. System message + `---` + content

Commands that return documents or structured data.

| Command | System message | Content |
|---------|---------------|---------|
| `/open path` | `Opened path` | rendered document |
| `/open path#block` | `Opened path#block` | rendered block |
| `/back` | `Back to path` | rendered document |
| `/refresh` | `Refreshed path` | rendered document |
| `/edit path` (view) | `[editing: path]` | source with line numbers |
| `/edit path#block` (view) | `[editing: path#block]` | block source |
| `/help` | `String Commands` | help text |
| `/ls [path]` | `Listing path/` | directory entries |
| `/nav` | `Menus` | menu list |
| `/nav name` | `Menu: name` | menu entries |
| `/nav scaffold` | `Nav Scaffold` | scaffold template |
| `/info` | `Session info` | info key-value pairs |
| `/act` | `Actions` | action list |
| `/act.name --help` | `Action: name` | action schema |
| `/verify path#block` | `Verified path#block` | block content preview |
| `/set` (list) | `Variables` | variable list |
| bash (output) | `exit: N \| cwd: path` | command output |

### B. System message only (no `---`)

Confirmation and status messages.

| Command | System message |
|---------|---------------|
| `/open` (no args) | usage error |
| `/write path` | `Written: path (42 bytes, 3 lines)` |
| `/append path` | `Appended to: path (now 78 bytes)` |
| `/replace path` | `Replaced 1 occurrence in path` |
| `/replace path --all` | `Replaced N occurrences in path` |
| `/replace path:L5[-L10]` | `Replaced path:L5[-L10]` |
| `/edit path` (with body) | `Edited path (2 lines, whole file)` |
| `/edit path#block` (with body) | `Edited path#block (5 lines)` |
| `/close` | `Closed: path` |
| `/set {var} = "val"` | `{var} = "val"` |
| `/undo` | `Undo: reverted path (N lines)` |
| `/act.name --flags` (template response) | action output (template result) |
| `/act.name --flags` (doc response) | category A (rendered doc) |

### C. Errors

Errors are formatted by the daemon as `ERROR(code): message`. Commands
return `err(message, code)` and the daemon wraps them. No `---`
separator.

```
re: [003qm] /open nonexistent.md
ERROR(NOT_FOUND): File not found: nonexistent.md
```

---

## Implementation reference

Return points in `commands.ts` that produce `system message\n---\ncontent`:

1. `cmdHelp()` — `String Commands\n---\n{help text}`
2. `cmdHelp(bash)` — `Bash Session\n---\n{help text}`
3. `cmdLs()` — `Listing {path}/\n---\n{entries}`
4. `cmdNav()` (list) — `Menus\n---\n{menu list}`
5. `cmdNav(name)` — `Menu: {name}\n---\n{entries}`
6. `cmdNav(scaffold)` — `Nav Scaffold\n---\n{scaffold}`
7. `cmdInfo()` — `Session info\n---\n{info lines}`
8. `cmdAction()` (list all) — `Actions\n---\n{action list}`
9. `cmdAction()` (--help, action schema) — `Action: {id}\n---\n{schema}`
10. `cmdAction()` (no flags, action schema) — `Action: {id}\n---\n{schema}`
11. `cmdAction()` (doc response) — `Opened {path}\n---\n{rendered doc}`
12. `cmdEdit()` (view whole file) — `[editing: {path}]\n---\n{source}`
13. `cmdEdit()` (view block) — `[editing: {path}#{block}]\n---\n{source}`
14. `cmdVerify()` — `Verified {path}#{block}\n---\n{preview}`
15. `cmdSet()` (list variables) — `Variables\n---\n{variable lines}`
16. `cmdOpen()` — `Opened {path}\n---\n{rendered doc}`
17. `cmdBack()` — `Back to {path}\n---\n{rendered doc}`
18. `cmdRefresh()` — `Refreshed {path}\n---\n{rendered doc}`
