# Security Policy

## Supported versions

Only the latest `0.1.x` release receives security updates during the v0.1 preview period. After `v1.0`, we will publish an explicit support policy.

## Reporting a vulnerability

If you discover a security vulnerability in String OS or any `@string-os/*` package, please report it privately rather than filing a public issue.

**Email:** security@string-os.dev *(placeholder — update before public launch)*

Include:

1. A short description of the issue and the attack surface it affects.
2. Steps to reproduce, ideally with a minimal SFMD file or code snippet.
3. Your assessment of severity (low / medium / high / critical) and why.
4. Any mitigation you have already identified.

We will acknowledge your report within 72 hours and share a triage decision within 7 days. If the issue is confirmed, we will coordinate a disclosure timeline with you before publishing a fix.

## Trust and execution model (v0.1)

SFMD files contain executable action commands. In v0.1, the trust model is deliberately minimal:

- **Default allowlist.** String OS ships with a restrictive default action allowlist. Only `read`, `write_artifact`, `checklist`, `handoff`, and `fetch` are enabled by default.
- **Opt-in only.** `bash:` shell sessions and `/exec` require explicit configuration before they are reachable. They are not available by default.
- **Unsigned.** SFMD files are not signed in v0.1. Treat SFMD files the same way you would treat any executable document: **run files only from sources you trust.**
- **Sandboxing is the runtime's job, not the spec's.** The SFMD specification defines the format; enforcement lives in the runtime. This mirrors how HTML is enforced by browsers, not by the HTML spec.

For the full trust and execution doc, see [`spec/trust-and-execution-v0.1.md`](https://github.com/string-os/sfmd/blob/main/spec/trust-and-execution-v0.1.md) in the SFMD spec repo.

Signed packages, fine-grained capabilities, and provenance metadata are planned for v0.2.

## Runtime threat model (v0.1)

String OS is a **single-agent, single-machine agent runtime** in v0.1. The sections below make the trust boundaries explicit so embedders don't ship it with mistaken assumptions.

### Shell execution is by design

- `/exec` and CLI-method actions invoke `/bin/bash -c <command>` intentionally. The agent runtime assumes the LLM is a first-class shell agent. There is no sandbox, no seccomp, no container by default — if the LLM can issue `/exec`, it has the same authority as the OS user who launched `stringd`.
- Both `/exec` and bash topics (`bash:*`) are **opt-in**: the default action allowlist does not enable them. An embedder who enables bash is accepting full shell authority.
- `{...args}` and `{name}` path-param substitution in CLI actions use POSIX single-quote escaping so that LLM-supplied *data* cannot break out into *command*. Templates must not wrap `{...args}` in additional quotes — the slot self-quotes. See `packages/string/src/commands/action.ts`.

**Not in scope for v0.1:** preventing an LLM that already has `/exec` from running arbitrary commands. Sandboxing is the embedder's responsibility (firejail, containers, VMs, per-topic capability scoping — whatever fits your deployment).

### Daemon transport trust

- `stringd` binds to `127.0.0.1` only. It is **not** designed to be exposed on a network, behind a reverse proxy, or inside a shared container.
- `X-Agent-Id` is an **identity header, not authentication**. It selects which agent record to operate under. Any process on the loopback interface can set any header — the assumption is that same-host processes run as the same OS user and therefore trust each other.
- `/shutdown` and `/health` have no auth by design. A hostile local process can kill the daemon; this is equivalent to the same process sending `SIGTERM`, which it could already do.
- CORS is permissive (`Access-Control-Allow-Origin: *`). Browsers should not call `stringd` directly — treat CORS as a convenience for local tooling, not a security boundary.
- Request bodies are capped at 10 MiB to prevent trivial OOM. See `packages/string/src/daemon.ts`.

**Not in scope for v0.1:** multi-tenant daemons, remote access, per-request signing, rate limiting beyond the per-topic queue cap of 16.

### On-disk secret storage

- `env-store` writes `config.json` (environment variables, including API keys) to the daemon's `STRING_DATA_DIR` with mode `0o600` inside a `0o700` directory. On multi-user systems, other local OS users cannot read the file. On single-user systems this is defense in depth.
- `agents.json` (agent registry) uses the same permissions.
- Secrets are stored **in plaintext**. There is no OS-keychain integration in v0.1. If the daemon's data directory is on a shared filesystem, an attacker with root or filesystem-level access can read the keys. Mount the data directory on a user-scoped path.

**Not in scope for v0.1:** OS keychain integration, secret encryption at rest, key rotation.

### Package installation

- `/install` sanitizes package names (from frontmatter or filename) against `[a-zA-Z0-9_-]+` before joining into `~/.string/packages/<name>/`. Path traversal via `../` is blocked.
- The SFMD compiler rejects `/include` directives whose resolved path escapes the source directory.
- Package *content* is not validated, signed, or sandboxed. Installing a package is equivalent to running its actions. **Install only from sources you trust.**

**Not in scope for v0.1:** package signing, provenance metadata, dependency pinning, allowlisted registries. Planned for v0.2.

## Known limitations

- No capability system. An action in the allowlist that is called is fully invoked.
- No revocation. Removing trust from an SFMD file requires removing or rewriting the file.
- No audit log by default. Runtimes may choose to emit one; String OS does not yet.
- No sandbox. See the threat model above.

These are intentional constraints for a v0.1 release. If any of them is a blocker for your use case, please open an issue so we can understand the requirement before v0.2 is designed.
