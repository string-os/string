# Releasing String

A release is a single "Release String vX.Y.Z" commit that bumps every version
field, followed by an npm publish, a git tag, and a GitHub release.

## Bump every version field

`vX.Y.Z` must be identical across **all** of these. Missing one leaves a stale
label somewhere (e.g. `plugins/string/.codex-plugin/plugin.json` was stuck at
`0.1.6` through several releases, so `codex plugin add` kept showing `0.1.6`).

| File | Field(s) |
|------|----------|
| `packages/string/package.json` | `version` |
| `.codex-plugin/plugin.json` | `version` |
| `.codex-plugin/marketplace.json` | `metadata.version` **and** `plugins[0].version` |
| `.claude-plugin/plugin.json` | `version` |
| `.claude-plugin/marketplace.json` | `metadata.version` **and** `plugins[0].version` |
| `plugins/string/.codex-plugin/plugin.json` | `version` — the manifest `codex plugin add` actually installs |

Quick check that nothing was missed (run before committing):

```bash
grep -rn '"version"' \
  packages/string/package.json \
  .codex-plugin/plugin.json .codex-plugin/marketplace.json \
  .claude-plugin/plugin.json .claude-plugin/marketplace.json \
  plugins/string/.codex-plugin/plugin.json
# every line must show the new version
```

## What the plugins actually run

The plugin MCP servers launch `npx -y @string-os/string@latest --mcp`, so the
**runtime code is always the latest published npm**, independent of the manifest
`version` label. The label is metadata (shown by `plugin add` / listings) and is
keyed for the plugin cache directory — keep it correct so installs aren't
misleading and the cache refreshes, but it does not pin the running code.

## Publish, tag, release

1. `pnpm -r build && pnpm --filter @string-os/string test` (must be green)
2. `npm publish --access public` from `packages/string/`
3. Tag the release commit `vX.Y.Z` and push it
4. Create the GitHub release with notes

The marketplace source is the git repo (`https://github.com/string-os/string.git`),
so plugin-manifest changes go live when the release commit lands on `main` — no
npm publish needed for the manifest itself.
