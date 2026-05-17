# Contributing to String

Thanks for your interest. String is early (v0.1) and the best contributions right now are:

1. **Try the demo and report where it breaks.** File an issue with your environment and the exact command that failed.
2. **Typo and doc fixes.** PR directly; we'll merge fast.
3. **New cookbook examples.** Open a PR against the [cookbook repo](https://github.com/string-os/cookbook).
4. **Spec discussion.** Open an issue in the [sfmd spec repo](https://github.com/string-os/sfmd) before proposing a PR. We discuss changes in issues first so nobody writes code against a moving target.
5. **Runtime bug fixes.** PR directly with a minimal repro.

Please do not submit PRs for:

- Renames or refactors of internal APIs. The v0.1 surface is deliberately small and we want to keep it stable until v0.2.
- New features that are not tied to an existing issue. Open an issue first, get a `help wanted` label or maintainer ack, then code.

## Development setup

```bash
# Prerequisites: Node.js >= 18, pnpm >= 9
git clone https://github.com/string-os/string.git
cd string
pnpm install
pnpm -r build
pnpm --filter @string-os/string test
```

## Repo layout

```
string/
  packages/
    core/          — SFMD parser and utilities (no runtime deps)
    compiler/      — SFMD compiler and validator
    string/        — runtime: Browser, Session, Loader, CLI, daemon (HTTP+MCP), stdio MCP shim
  docs/
    quickstart.md
    agent-integration.md
    writing-skills.md
    runtime/       — runtime reference docs
  CHANGELOG.md
  README.md
```

## Running the CLI from source

```bash
cd string
pnpm -r build
alias string='node packages/string/dist/cli.js'
string --help
```

## Running tests

There is one test entry point for now:

```bash
pnpm --filter @string-os/string test
```

A real test runner (vitest) is a post-v0.1 follow-up. Adding one is a welcome PR — open an issue first so we can agree on the migration shape.

## Adding a new package

1. Create a directory under `packages/<name>`.
2. Add a `package.json` with `"name": "@string-os/<name>"`, `"version": "0.1.0"`, and the same `"type": "module"`, `"exports"`, `"files"`, and build scripts as existing packages.
3. Add it to the dependency graph explicitly. Avoid circular deps.
4. Run `pnpm install` at the repo root to link the workspace.
5. Run `pnpm -r build` to confirm the new package compiles.
6. Open a PR.

## Commit messages

We follow a simple prefix convention:

- `feat(scope): ...` — new feature
- `fix(scope): ...` — bug fix
- `docs: ...` — documentation
- `refactor: ...` — internal cleanup, no behavior change
- `chore: ...` — tooling, lockfile, repo hygiene

Scope is usually the package name (`string`, `core`, `compiler`, `client`).

## Releasing (maintainers only)

For v0.1, releases are manual and lockstep across all packages.

1. Update `CHANGELOG.md`.
2. Bump `version` in every `packages/*/package.json` and the root `package.json`.
3. Commit with `chore: release vX.Y.Z`.
4. Tag: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
5. Push: `git push && git push --tags`.
6. Publish: `pnpm -r publish --access public` (one package at a time in dependency order if any issue is suspected).
7. Create a GitHub Release tied to the tag with the CHANGELOG section as notes.

## Code of Conduct

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). Be kind. Disagree about ideas, not people. Assume good intent.
