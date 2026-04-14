# 10 — Shell Execution

Two modes of shell execution in String.

## Two Modes

| | `/exec` | `bash:name` |
|---|---|---|
| State | None (stateless) | Full shell state |
| cwd | Document dir or home | Cumulative |
| Env | base + `{var}` | Cumulative |
| Use case | Quick one-shot | Long-running work |

## /exec — Stateless One-Shot

- Syntax: `/exec <command>`
- Spawns a new `/bin/bash -c` process every time
- cwd: current document directory → falls back to home if no document open
- env: `process.env` + session variables (`{var}`) exported as environment variables
  - Variables starting with `_` (config variables) are excluded
- Timeout: 30 seconds
- stderr + stdout merged into single output
- Empty input → `COMMAND_UNSUPPORTED` error

### Practical Notes

Everything after `/exec ` is passed verbatim to `bash -c`. Write commands as you would type them in a terminal — do NOT wrap the whole command in quotes.

```
/exec pwd                              ✅ single command
/exec pwd; echo '---'; ls -la          ✅ chained commands
/exec for f in *.md; do wc -l "$f"; done   ✅ shell constructs work
/exec echo $HOME                       ✅ shell variables expand normally

/exec "pwd; echo test"                 ❌ quotes become part of the command
                                          → bash tries to run literal "pwd; echo test"
                                          → EXIT_127 (command not found)
```

## bash:name — Stateful Terminal

> ⚠️ Meta-commands in bash sessions use `//` prefix.
> - Correct: `//help`, `//info`, `//close`
> - Incorrect: `/help` (may be sent to bash and fail)

- Topic scheme: `bash:name` (ChanFlow: `<𝒞=string:bash:name>`)
- All input is sent to shell stdin — plain text works as-is (no `/` prefix needed)
- `//` prefix → String meta-command (`//help`, `//info`, `//close`)
- State preserved: cwd, env vars, shell history

```
echo hello                 ✅ plain text → shell stdin
/bin/echo hello            ✅ absolute path → shell stdin
cd /tmp && pwd             ✅ chained commands
//help                     ✅ String meta-command
//close                    ✅ String meta-command
/help                      ❌ sent to bash as-is → "bash: /help: No such file or directory"
```

## Common

### Output Format

```
exit: N | cwd: /path
---
output here
```

- `exit: 0` → `ok: true`
- `exit: non-zero` → `ok: false`

### Session Variable Export

Both modes export session `{var}` as environment variables:
- `{MY_VAR}` → `MY_VAR=value` in env
- Variables starting with `_` are excluded (config/internal)
- `$var` (runtime variables) are never exported