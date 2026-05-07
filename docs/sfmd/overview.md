---
title: SFMD Overview
---

**SFMD** (String Flavored Markdown) is a set of extensions to CommonMark designed for AI agent interaction.

---

## Why now

AI agents have started doing real autonomous work — reading, navigating, deciding, executing. But the infrastructure they operate on was designed for humans: HTML rendered for visual parsing, apps built around click journeys, docs optimized for skim-reading. Agents parse all of it indirectly, slowly, and expensively.

SFMD is a bet that giving agents a surface designed for *them* — a portable document format that is simultaneously human-readable, AI-readable without HTML parsing, and AI-executable via inline action commands — makes agent work cheaper and more reliable. We don't have the cost/quality numbers yet. We will publish them as the research matures. In the meantime, the format, the reference runtime ([String](https://github.com/string-os/string)), and the cross-agent portability demo let you see the shape of the bet for yourself.

---

## What SFMD is

SFMD is CommonMark with six additions:

1. **Frontmatter** — YAML metadata at the top of a document
2. **Blocks** — named regions addressable by ID
3. **Directives** — navigation and include declarations
4. **Shortcuts** — named references to URIs
5. **Actions** — executable definitions in fenced code blocks
6. **Variables** — references substituted at runtime

Every SFMD document is a valid CommonMark document. SFMD never introduces syntax that breaks CommonMark parsing.

---

## Design constraint

**SFMD MUST be 100% CommonMark compatible.**

Every construct uses features CommonMark already allows:

| SFMD feature | CommonMark construct used |
|-------------|-------------------------|
| Frontmatter | Text before first heading (or `---` delimiters) |
| Blocks | HTML comments (`<!-- -->`) |
| Directives | Link syntax (`[text](url)`) |
| Shortcuts | Link syntax (`[text](url)`) |
| Actions | Fenced code blocks (` ``` `) |
| Variables | Not rendered — substituted before parsing |

An SFMD document opened in GitHub, Obsidian, VS Code, or any CommonMark viewer renders as readable Markdown. No information is hidden. Convenience is reduced, but content is fully preserved.

---

## What SFMD is not

SFMD defines structure, references, and declarations. It does not define execution.

```
Applications / AI Agents
        ↑
    String OS          ← execution, navigation, actions, state
        ↑
 SFMD Documents        ← structure, references, declarations
        ↑
   CommonMark          ← base syntax
```

String (or any other runtime) reads SFMD and operates on it. SFMD itself has no opinions about how commands work, how actions execute, or how secrets are stored. This separation means SFMD can be used by any runtime — not just String.

This also means the security model for executable content lives in the runtime, not in the spec. See [`trust-and-execution-v0.1.md`](./trust-and-execution-v0.1.md) for the reference runtime's v0.1 model.

---

## Stability

SFMD v0.1 is the **initial public release**. The format is usable and the reference runtime runs it, but the spec is not frozen.

| Construct | Status | What may change |
|-----------|--------|-----------------|
| Frontmatter (YAML) | **Stable** | Schema may gain optional fields; required fields will not be removed or renamed. |
| Blocks (HTML-comment delimited) | **Stable** | The delimiter syntax is frozen. |
| Directives | **Stable for v0.1.x** | Current directive set is frozen; new directives may be added. |
| Shortcuts (named, auto, relative) | **Stable** | The three link styles are frozen. |
| Actions (`/act.*` grammar) | **Stable for v0.1.x** | Grammar is frozen; the default runtime allowlist may expand in v0.2. |
| Parameter templates (`{var\|opts}`) | **Stable** | Frozen for v0.1.x. |
| Variables (`$VAR`, `{var}`) | **Stable** | Frozen for v0.1.x. |
| Live data binding (`{{fetch:URL}}`) | **Experimental** | The one construct likely to evolve before v0.2. Expect richer forms such as `{{fetch:URL\|cache=10m}}`. The current form will remain supported. |

**Versioning policy.** SFMD follows semantic versioning at the spec level:

- **Patch (`v0.1.0 → v0.1.1`):** clarifications, examples, typo fixes. No behavior changes.
- **Minor (`v0.1 → v0.2`):** additive new constructs, backward compatible. Documents written for v0.1 remain valid.
- **Major (`v0.1 → v1.0`):** the first frozen spec. After v1.0, breaking changes require a major bump and a migration path.

Documents may declare their compatible spec version in frontmatter:

```yaml
---
sfmd: "0.1"
---
```

Runtimes are expected to refuse documents that declare a version higher than they support.

---

## File conventions

- **Encoding:** UTF-8
- **Extension:** `.md` (or `.sfmd` if disambiguation matters in your toolchain)
- **Line endings:** LF (recommended) or CRLF
- **MIME type:** `text/markdown; variant=sfmd` (suggested; not yet registered)
