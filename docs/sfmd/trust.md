---
title: Trust and Execution (SFMD v0.1)
---

# Trust and Execution (SFMD v0.1)

**Status:** Informative. This document describes the trust and execution model used by the reference runtime, [String](https://github.com/string-os/string). It is not part of the SFMD format specification. Other runtimes may implement different models.

**Why separate.** The SFMD format specification defines how a document is structured and parsed. Execution — deciding which actions are allowed to run, with what permissions, and what happens when an untrusted document is opened — is the runtime's responsibility. This mirrors how HTML is enforced by browsers (CSP, same-origin, sandbox), not by the HTML spec itself.

---

## The v0.1 model in one sentence

**Ship a restrictive default action allowlist, make risky capabilities opt-in only, and tell users explicitly to run SFMD files only from trusted sources.**

No signing. No capability system. No provenance metadata. No audit log. These are v0.2 goals.

---

## Default action allowlist

A conforming v0.1 runtime SHOULD enable the following actions by default:

| Action | What it does | Why it's safe-by-default |
|--------|-------------|--------------------------|
| `read` | Reads a file, URL, or shortcut into the current session | Passive; does not mutate external state |
| `write_artifact` | Writes to a file *inside the session's artifact directory* | Mutation is contained to a runtime-managed area |
| `checklist` | Tracks checklist state inside the session | Session-local only |
| `handoff` | Passes control between documents or sessions | Metadata movement, no external effect |
| `fetch` | Makes an HTTP GET against a declared URL | Read-only network; no POST/PUT/DELETE by default |

Any action not in this list MUST be rejected by a default-configured runtime with a clear error message. The error SHOULD name the action and tell the user how to enable it.

## Opt-in only

The following capabilities MUST NOT be reachable without explicit runtime configuration:

- **`bash:` session topic.** Spawns a PTY and runs shell commands. Disabled by default. Enabling it requires either an environment variable, a config file flag, or a command-line argument. The runtime SHOULD document the exact mechanism and refuse to enable it silently.
- **`/exec` command.** Runs arbitrary commands outside a shell session. Disabled by default.
- **Network methods beyond `fetch`.** POST, PUT, DELETE, and any action that performs mutating HTTP requests are opt-in.
- **Filesystem access outside the session artifact directory.** Any action that writes to paths outside the session sandbox must be gated.

The reference String runtime enables all of these via explicit environment variables or config. Read the [String runtime reference docs](https://github.com/string-os/string/tree/main/docs/runtime) for the current set.

---

## Unsigned documents

**SFMD files are not signed in v0.1.** There is no built-in mechanism for verifying authorship, integrity, or provenance. Users must rely on the transport that delivered the file (HTTPS + a trusted host, a verified email attachment, a local file they wrote) to establish trust.

This is a deliberate minimum for the initial release. Adding signing, attestation, or provenance metadata to v0.1 would expand the surface area at exactly the moment the format most needs to be legible to first-touch readers. Signing is a v0.2 priority.

**User-facing guidance.** Runtime distributors and documentation SHOULD include clear language equivalent to:

> SFMD files contain executable action commands. Run SFMD files only from sources you trust. The String runtime ships with a restrictive default allowlist, but you are responsible for ensuring that the files you open come from somewhere you believe is safe.

---

## Threat model (what v0.1 does and does not defend against)

### Defended by default

- **Accidental destructive actions.** The default allowlist does not include shell, exec, or arbitrary filesystem writes. Opening a malicious SFMD file on a default-configured runtime cannot, for example, delete your home directory — the required action is not enabled.
- **Outbound network mutations.** The `fetch` action is GET-only. A malicious file cannot POST to an external server without the user first enabling a mutating network capability.
- **Unknown action injection.** A runtime that encounters an `/act.*` command outside its allowlist MUST reject it with an error, not silently pass it through. This prevents a format-level injection from becoming a code-execution vector.

### NOT defended (v0.2 or later)

- **Documents you manually opt into.** Once a user enables `bash:` or `/exec`, the runtime provides no additional guardrails. There is no per-action sandbox, no time limit, no resource cap, no network isolation. Opt-in means "you own the consequences."
- **Data exfiltration via `fetch`.** A malicious file can encode data in a URL and `fetch` it to a third party. v0.1 has no outbound URL allowlist. Users who need this must add it at the network layer.
- **Supply-chain attacks on the runtime itself.** If `@string-os/string` or a dependency is compromised, any defense described here is moot. Standard supply chain hygiene applies (lockfile pinning, audit tooling, dependency review).
- **Phishing via convincing-looking SFMD files.** A malicious file can present itself as a legitimate app. User-facing trust (URL bar, sender verification, file origin) is out of scope for v0.1.
- **Denial of service.** A malicious file can include a large `{{fetch:URL}}` template pointing at a slow endpoint. v0.1 has no per-action timeouts.

---

## v0.2 roadmap (preview — not normative)

The following are planned for the next minor release. They are listed here so that implementers and integrators can anticipate the direction. They are not promises.

- **Signed packages.** An SFMD bundle format that carries a signature over the document content plus declared capabilities. Readers verify the signature against a trusted key.
- **Capability declarations.** Documents declare which actions they will invoke. The runtime checks the declaration against its active policy before any action runs.
- **Fine-grained permission prompts.** First-run behavior for `fetch` to a new host, first-run behavior for filesystem writes, first-run behavior for shell sessions.
- **Audit log.** Optional runtime-emitted JSONL log of every action invocation, arguments, and result, suitable for review and replay.
- **URL allowlist / blocklist.** Runtime configuration to restrict `fetch` to a known set of hosts.
- **Action timeouts and resource caps.** Per-action limits on wall-clock time, memory, and network bytes.

If any of these is a blocker for your use case, please open an issue at <https://github.com/string-os/sfmd/issues> describing the requirement. v0.2 design will prioritize use cases with concrete blocking needs over speculative ones.

---

## Implementation checklist for runtime authors

A runtime implementing SFMD v0.1 SHOULD:

1. Ship with the default allowlist above.
2. Reject any action outside the allowlist with a clear error naming the action.
3. Require explicit configuration to enable `bash:`, `/exec`, and mutating network.
4. Document the exact configuration mechanism in its README.
5. Include a "run only from trusted sources" warning in its README and CLI help text.
6. Expose a way for the user to list the currently-enabled actions (e.g. `string --capabilities`).
7. Not silently pass through unknown actions under any circumstance.

A runtime MAY:

- Support a stricter allowlist than the default (e.g. a "read-only" profile that disables even `write_artifact`).
- Add runtime-specific actions beyond the default list, but only if they are opt-in.
- Implement v0.2 features (signing, capabilities, audit log) ahead of schedule, but must not reject v0.1 documents that lack v0.2 metadata.

---

## References

- [String runtime SECURITY.md](https://github.com/string-os/string/blob/main/SECURITY.md)
- [SFMD spec overview](./01-overview.md)
- [Actions (`/act.*` grammar)](./06-actions.md)
