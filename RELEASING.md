# Releasing String

A release is a single "Release String vX.Y.Z" commit that bumps every version
field, followed by an npm publish, a git tag, and a GitHub release.

## Bump every version field

`vX.Y.Z` must be identical across **all** of these. Missing one leaves a stale
label somewhere (e.g. `plugins/string/.codex-plugin/plugin.json` was stuck at
`0.1.6` through several releases, so `codex plugin add` kept showing `0.1.6`).

| File | Field(s) |
|------|----------|
| `package.json` | `version` |
| `packages/string/package.json` | `version` |
| `.codex-plugin/plugin.json` | `version` |
| `.codex-plugin/marketplace.json` | `metadata.version` **and** `plugins[0].version` |
| `.claude-plugin/plugin.json` | `version` |
| `.claude-plugin/marketplace.json` | `metadata.version` **and** `plugins[0].version` |
| `plugins/string/.codex-plugin/plugin.json` | `version` — the manifest `codex plugin add` actually installs |
| `.mcp.json` and `plugins/string/.mcp.json` | `mcpServers.string.args[]` package pin |

Quick check that nothing was missed (run before committing):

```bash
pnpm check:version
```

## What the plugins actually run

The plugin MCP servers launch `npx -y @string-os/string@X.Y.Z --mcp`, pinned to
the same version as `packages/string/package.json`. That keeps the installed
plugin label, cache directory, and running MCP server coherent. Do not use
`@latest` here; it lets the plugin metadata and runtime drift.

## Publish, tag, release

1. `pnpm check:version && pnpm -r build && pnpm --filter @string-os/string test` (must be green)
2. `npm publish --access public` from `packages/string/`
3. Tag the release commit `vX.Y.Z` and push it
4. Create the GitHub release with notes

The marketplace source is the git repo (`https://github.com/string-os/string.git`),
so plugin-manifest changes go live when the release commit lands on `main` — no
npm publish needed for the manifest itself.
