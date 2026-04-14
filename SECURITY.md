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

## Known limitations

- No capability system. An action in the allowlist that is called is fully invoked.
- No revocation. Removing trust from an SFMD file requires removing or rewriting the file.
- No audit log by default. Runtimes may choose to emit one; String OS does not yet.

These are intentional constraints for a v0.1 release. If any of them is a blocker for your use case, please open an issue so we can understand the requirement before v0.2 is designed.
