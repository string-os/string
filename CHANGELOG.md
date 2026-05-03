# Changelog

## v0.1.0 (2026-05-03)

First public npm release.

```
@string-os/core      0.1.0
@string-os/client    0.1.0
@string-os/compiler  0.1.0
@string-os/string    0.1.0
```

`@string-os/string-mcp` is not part of this release; it will publish separately when MCP integration is wired up.

### `@string-os/core`

- SFMD parser: blocks, directives (`[!menu]`, `[!nav]`, `[!include]`, `[!requirements]`), shortcuts, action blocks, frontmatter, variables.
- Block extractor for `<!-- #id -->` regions.
- Variable-length CommonMark fences (3+ backticks) supported per spec.

### `@string-os/client`

- HTTP/SSE client for `stringd` with zero runtime dependencies (Node built-ins only).
- API: `ping`, `ensureUser`, `exec`, `health`, `shutdown` plus SSE helpers.
- Speaks stringd protocol v0.1.

### `@string-os/compiler`

- Trinity-style multi-file compiler (inline `[!include]` references on demand).
- Document validator with error reporting.
- `sfmd` CLI: `compile`, `validate`, `extract`, `fix`, `clean`.

### `@string-os/string`

**Runtime**
- Browser with multi-session support, persistent across daemon restarts.
- Loader for `file://` and `http(s)://` documents with content negotiation and HTML-to-Markdown conversion.
- Resolver for includes, menus, navs, shortcut invocations, and `[!requirements]` auto-detection.
- Topic system: `file:`, `app:`, `app:<name>:<config>`, `web:`, `bash:`, `tool:`. Topics carry env scope (global → app → config cascade).

**Commands**
- Navigation: `/open`, `/back`, `/refresh`, `/close`, `/info`, `/ls`, `/nav`.
- Actions: `/act.<name>` with GNU-style invocation (positional, `--flag value`, `--flag=value`, short aliases, `--` separator). `act:` URI scheme for in-doc dispatch.
- Editing: `/write`, `/edit` with one-level undo.
- Shell: `/exec` (one-shot) and persistent `bash:` topic via PTY (optional dep).
- Packages: `/install --app|--tool`, `/uninstall`. Apps/tools install into `{home}/packages/<name>/`.
- Env: `/set $VAR = "value"` with global/app/config scope.

**Action authoring**
- Action blocks declare typed fields with required/optional, default values, and short aliases (`name, -n: type ...`).
- HTTP actions: GET/POST/PUT/PATCH/DELETE with header flags (`-H "Key: Value"`) and body templates (`-d '{...}'`).
- CLI actions: shell-escaped `{field}` substitution, `$ARGS` passthrough.
- Response templates (`act.<id>.response`): variable extraction from JSON, `for:` iteration over arrays.
- Frontmatter `requires: [VAR1, VAR2]` cross-checked against env store at `/open` time; missing vars surface as a warning.
- Setup hint on action failure when a sibling `requirements.md` exists.

**Daemon**
- HTTP server (default port 3100) with SSE streaming for long-running actions.
- Per-user home directory under `~/.string/users/{user}/` (flat layout — no nested `.string/`).
- Auto-start on first CLI call; manage explicitly with `string --daemon start|stop|status`.

**CLI**
- One-shot: `string <topic> '<command>'`. REPL: `string <topic>`.
- Output frame: `<𝒞=string:<topic>>...</𝒞>` for clean stdout parsing. `--json` flag for envelope JSON.
- Short flag aliases shown in `/help` and `--help`.

### Pre-1.0 stability

`0.x.y` follows: minor bumps (`0.1 → 0.2`) may include breaking changes; patches (`0.1.0 → 0.1.1`) are backwards compatible. Pin with `~0.1.0` for safety.
