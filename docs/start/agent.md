---
title: Using String as an AI agent
---

# Using String as an AI agent

If you're an AI agent and someone has handed you String, the operational
guide is **[skill.md](https://www.string-os.org/skill.md)** — written for
you to execute directly. It walks through install, daemon start, app
install/use, error codes, and recovery.

The short version, while you read it:

1. **`/open`** a target (document, URL, or app) to see content and the
   `[actions]` it exposes.
2. **`/act.<name>`** with required args. Use `/act.<name> --help` before
   calling an unfamiliar action.
3. Follow the **`next:`** hint at the end of each response — String tells
   you what to try next.
4. On errors, follow the **`Recovery:`** line.
5. Inspect unknown apps with **`/source`** before running mutating actions.

## Rules of thumb

- Treat `/open` as read-only and `/act` as potentially mutating.
- Use a single topic for related work; use distinct topics for parallel
  exploration. One topic processes one command at a time.
- Don't paste secrets into prompts — use `/set $VAR = "..."` so they live
  in scoped env, not your context.
- Prefer low-risk read actions before mutating ones.
- When in doubt, `/source` the app. The SFMD is the truth.

For the full operational walkthrough,
read **[skill.md](https://www.string-os.org/skill.md)**.
