# String Install Manifest (v1)

A registry-agnostic JSON format that an HTTP source can return so the daemon's `/install` command knows how to fetch and stage the package without flag input from the agent.

> **Status:** v1 shipping. Implemented in `loader.ts` (manifest detection, `install_hint` surfacing, path validation) and `installer.ts` (atomic staging, delivery dispatch). Schema additions in v1.x are backwards-compatible — unknown fields are ignored by the daemon.

## Why

Today an agent typing `/install <url>` is equivalent to "fetch this single markdown, copy to local". For multi-file or "URL-shortcut" installs, the agent has had to remember flags (`--link`, `--app`). This is a UX tax that grows with the registry.

The manifest format lets the **publisher** encode `delivery` and `files` decisions at publish time. Daemon respects them; agent types one command for any app.

## Schema

When `/install <url>` fetches a URL and the response is JSON matching this shape, the daemon treats it as an install manifest:

```jsonc
{
  "files": [                                 // REQUIRED — array, non-empty.
    { "path": "string.md",                   //   path: relative file path inside the package
      "url":  "https://.../string.md" },     //   url:  HTTPS source for that file
    { "path": "submolts.md",                 //   either url OR content (string) is required
      "url":  "https://.../submolts.md" },
    { "path": "data.md",
      "content": "...inline markdown..." }   //   content lets a manifest carry small files inline
  ],
  "delivery": "local" | "link" | "any",      // OPTIONAL — install mode hint (see below)
  "install_hint": "Run `/install ...` to ..." // OPTIONAL — markdown shown only on pre-install browse
  // ── any other fields are ignored by the daemon ──
}
```

### `files[]`

The `path: 'string.md'` entry is the package root and is REQUIRED. Daemon reads its content (via `url` or inline `content`) as the SFMD document. A manifest whose `files[]` is missing the `string.md` entry is rejected with a clear error before SFMD parsing — without this guard the raw JSON would propagate to the parser as the package source and surface as a misleading "Cannot determine package type" message.

Other entries are package members. Daemon stores them under `packages/{name}/{path}` for local installs.

Path values must not contain `..`, must not be absolute (no leading `/` or `\`), and must not contain `\0`. Validation runs **before any file is fetched or written** — a single bad path aborts the whole install before the network or filesystem is touched, so a malicious manifest can never leave half-written files behind.

### `install_hint`

Optional markdown string the daemon appends below the package's `string.md` content **only when the manifest URL is opened pre-install** (i.e. via `/open <manifest-url>` to browse what the package contains). It does NOT enter the persisted package source — once `/install` runs, future `/open app:<name>` reads from the local `string.md` and the hint never echoes back.

Typical use: a marketplace surfaces "Run `/install <url>` to install this app" as a one-line nudge for agents browsing the catalog.

### `delivery`

| value | daemon behavior |
|---|---|
| `"local"` | Download every `files[]` entry to `packages/{name}/`. Same as `/install` of a plain markdown URL today. |
| `"link"` | Don't download. Register the manifest URL in `config.json`. Every `/open app:{name}` re-fetches → `/open` always sees the publisher's latest. |
| `"any"` | Treated as `local` by default; agent can override with `--link`. |
| absent | Treated as `local`. |

### Other fields

Only `files[]` and `delivery` have meaning to the daemon. Registries are free to add metadata (`source`, `source_url`, `version`, `published_at`, `description`, etc.) — those fields are for the registry's own UI, ignored by daemon.

## Daemon behavior

When `/install <source>` runs:

1. **Local file or directory** → existing single-file install. Manifest support doesn't apply.
2. **HTTP(S) URL** → daemon fetches with `Accept: application/json, text/markdown, text/plain`.
   - Response body parses as JSON AND has `files[]` array → **treated as manifest**:
     - Loader extracts `files[].path == 'string.md'` content for SFMD parsing.
     - Installer reads `delivery`:
       - `delivery: 'link'` → register URL only, no file copy.
       - `delivery: 'local' | 'any' | undefined` → download all `files[]` to `packages/{name}/`.
   - Response is plain markdown → existing single-file behavior (treat as `string.md`, copy to `packages/{name}/string.md`).
   - Response is JSON but has no `files[]` array → not a manifest, fall through to plain-markdown handling (likely fails frontmatter parsing — a confusing error, but rare).

## Flags as overrides

Agent flags always win over manifest hints:

| flag | effect |
|---|---|
| `--link` | Force link mode even if manifest says `delivery: 'local'`. |
| (future) `--local` | Force download even if manifest says `delivery: 'link'`. |
| `--app` / `--tool` | Override frontmatter `type`. Same as before. |
| `--as <local-name>` | Override the local registry key. Lets two apps that share `(namespace, name)`'s `name` part install side-by-side under different local handles. Independent of manifest contents. |

This keeps power users in control while letting publishers opt into zero-flag UX.

## Atomic staging

Multi-file installs stage every fetched file under
`packages/.{name}.tmp/`, then atomically rename to `packages/{name}/`
once all files have been validated and written. If any step fails
(bad manifest path, network drop, malformed file), the staging
directory is wiped and the existing `packages/{name}/` (if any) is
untouched. Agents never observe a partially-installed package.

## Why this isn't registry coupling

This spec doesn't favor any specific registry:

- Daemon code has zero hardcoded domains. (Verified by grep — see review notes.)
- The manifest shape (`{ files, delivery }`) uses generic, non-vendor-specific keys.
- Any HTTP endpoint emitting this shape gets the same handling — StringHub, a future "othermarket.org", a publisher's own GitHub Pages, etc.
- Non-conforming endpoints continue working through the existing primitive flags (`--link`, `--app`).

The relationship is the same as Docker Engine ↔ OCI Image Format: the runtime supports a public spec, not a specific registry.

## Example

Publisher uploads to a marketplace; marketplace serves at `https://example.market/api/install/foo/bar`:

```http
GET /api/install/foo/bar
Accept: application/json

200 OK
Content-Type: application/json

{
  "files": [
    { "path": "string.md", "url": "https://example.market/files/foo/bar/string.md" },
    { "path": "submolts.md", "url": "https://example.market/files/foo/bar/submolts.md" }
  ],
  "delivery": "local"
}
```

Agent:
```
/install https://example.market/api/install/foo/bar
```

Daemon:
1. Fetches the URL. Content-Type JSON + `files[]` → manifest mode.
2. Extracts string.md content via the URL in `files[0]` (or its inline `content`).
3. Frontmatter sets `name: bar`. Installer creates `packages/bar/`.
4. `delivery: 'local'` → downloads each `files[]` entry.
5. Registers `bar: file:///packages/bar/string.md` in `config.json`.

Result: `Installed app:bar`. Agent never typed a flag.

If `delivery` had been `"link"`, step 4 would skip; `config.json` would register the manifest URL itself; result would be `Linked app:bar`.

## Backwards compatibility

- Existing daemon test suite (623 tests) passes with the manifest path added.
- Plain markdown URLs install identically to before.
- `--link` and `--app`/`--tool` flags work exactly as before; their semantics are unchanged.
- No breaking changes to `config.json`, `packages/`, or any user-visible state.

## Reference implementation

- `packages/string/src/loader.ts` — JSON manifest detection in `loadHttp`, `install_hint` surfacing, missing-`string.md` early bail.
- `packages/string/src/installer.ts` — `readManifestDelivery()` helper, atomic stage-and-rename, manifest path validation.
- `packages/string/src/commands/packages.ts` — `--link`, `--as` flag plumbing (`--link` tristate: true / undefined / future false).

## Open questions

- **`delivery: 'any'`** — current implementation defaults this to local. Should it be configurable per-daemon?
- **Manifest versioning** — no `version` field currently. Add one if the spec evolves?
