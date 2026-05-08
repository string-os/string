# Changelog

## v0.1.3 (2026-05-08)

Two reshapes to the action runtime and the topic system. **Breaking
changes** to the topic API; action authoring stays compatible.

```
@string-os/string  0.1.3
```

(Other packages unchanged.)

### `@string-os/string` — action I/O

- **Value shortcuts.** Response templates can declare named outputs with
  `{@var} = expr`. Inside a `for:` loop the slug auto-enumerates per
  iteration (`@feed-1`, `@feed-2`, ...); outside it's a single `@var`.
  Downstream actions consume them as flag values:
  `/act.read @feed-3` resolves to the post id without the AI typing a
  long UUID.
- **Tuple values.** RHS form `({a}, {b}, ...)` produces a `string[]` value
  shortcut. Action templates index with `{name[N]}` across URI / body /
  response substitution. Lets one shortcut carry several fields
  (`@card-9 = (issue_number, repo)`) so a single token replaces what used
  to need two.
- **Multi-occurrence `{var}` in URIs.** Payload key deletion is now
  deferred until after the URI replace pass, so `{var}` (or `{var[0]}`
  followed by `{var[1]}`) can repeat in one template without later
  occurrences falling through to literal.
- **Input snapshot for body / response templates.** Templates see the
  caller's original payload, even after the URI step consumed a field.
- **Sibling-file install.** The installer now copies non-`.md` files
  next to `string.md` (helpers, scripts, binaries) with executable mode
  preserved. Apps can ship local CLI wrappers without external packaging.
- **`/act --help`** renders the schema for every action on the current
  doc in one shot. The `[actions]` line on each render shows action names
  only — full signatures live behind `--help`.

### `@string-os/string` — topic system **(breaking)**

- New topic types: `tab` (free-form bare names), `app`, `bash`, `hub`.
- `file:` and `web:` prefixes are removed. `string file:main '...'` now
  fails to parse — use bare names: `string main '...'`, `string notes
  '...'`. The two prefixes carried no enforced semantics; this collapses
  the distinction.
- Reserved bare names `app`, `bash`, `tool`, `system` route to **hub
  topics** instead of free-form sessions. Each hub aggregates / manages
  instances of its kind. v0.2 ships a placeholder page; concrete
  listings and management actions land in a follow-up.
- Canonical and hub targets always carry their own topic. `/open app:X`,
  `/open bash:X`, `/open <hub>` from any session redirect to the
  canonical topic so app/hub sessions stay clean of unrelated content.
- `TopicType` and related public API in `@string-os/string` change
  shape (`'tab' | 'app' | 'bash' | 'hub'`); embedders should re-check
  any `topic.type === 'file' | 'web'` checks.

### Migration from 0.1.x

- `string file:main '...'`         → `string main '...'`
- `string file:<anything> '...'`   → `string <anything> '...'`
- `string web:docs '...'`          → `string docs '...'`
- Bare names `app`, `bash`, `tool`, `system` are now reserved (hub topics).

## v0.1.2 (2026-05-07)

Documentation-friendliness pass: docs that *describe* SFMD syntax no longer
have their illustrative examples mistaken for real shortcuts/warnings.

```
@string-os/core    0.1.2
@string-os/string  0.1.2
```

(Other packages unchanged at 0.1.0. Note: `0.1.1` was a botched publish of
`@string-os/string` where pnpm's `workspace:*` placeholder leaked into the
published `package.json`. `string@0.1.1` was unpublished; `core@0.1.1`
remains in the registry but has been deprecated. Use 0.1.2.)

### `@string-os/core`

- Parser now skips inline code spans (`` `[@id Label](path)` ``) when
  scanning for shortcut definitions. Fenced code blocks were already
  skipped — this closes the inline gap.

### `@string-os/string`

- **Diagnostics out of body.** Unknown-shortcut and parse warnings no
  longer prepend `[!] ...` lines onto rendered content. They live on
  `LoadedDocument.warnings`, surface via `/info`, and ride out on
  `meta.warnings` (new `SessionMeta` field) for JSON consumers.
- **Code-aware shortcut resolution.** The runtime now masks fenced code
  blocks, inline code, and backslash-escaped brackets (`\[`, `\]`,
  `\@`) before resolving `[Label][@id]` invocations. Authors can write
  literal SFMD examples in prose without triggering "Unknown shortcut"
  warnings.
- **Auto-shortcuts respect code regions.** `buildSlugMap` no longer
  generates auto-shortcuts for plain links inside fenced or inline code
  — `` `[GitHub](https://github.com)` `` shown as a syntax example is
  treated as text, not turned into `@github`.
- **`/ls` rejects non-file topics.** When called against `web:`, `app:`,
  or `bash:` topics, `/ls` returns a clear redirect message pointing to
  `/open` and `/nav` instead of leaking a filesystem boundary error.
- Sequential-session model documented in `docs/runtime/topics.md` —
  parallel commands within the same topic race on the "current document"
  basis used for relative-path resolution. Use distinct topics for
  parallel reads.

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

We stay in `0.1.x` until the API stabilizes. Any release in this range
may include breaking changes — read the release notes before upgrading
and pin to an exact version (`@string-os/string@0.1.3`) if you need
stability across upgrades. The `0.2` line is reserved for the first
post-stabilization release.
