---
title: String Documentation
---

## Getting Started

- [Quick Start](./start/quickstart.md) — install and run your first app in 5 minutes
- [Agent Integration](./start/agent-integration.md) — connect String to your agent framework
- [Writing your first app](./start/writing-an-app.md) — the minimum to author your own app

## Cookbook

Example apps and tutorials live in a separate repo: [`string-os/cookbook`](https://github.com/string-os/cookbook). Clone it and `string '/install --app ./apps/<name>/string.md'` to try them.

## SFMD Specification

- [Overview](./sfmd/overview.md) — the format, why it exists
- [Frontmatter](./sfmd/frontmatter.md), [Blocks](./sfmd/blocks.md), [Directives](./sfmd/directives.md), [Shortcuts](./sfmd/shortcuts.md), [Actions](./sfmd/actions.md), [Variables](./sfmd/variables.md)
- [Trust Model](./sfmd/trust.md)

## Runtime

- [Overview](./runtime/overview.md) — how String works
- [Actions](./runtime/actions.md), [State](./runtime/state.md), [Navigation](./runtime/navigation.md), [Topics](./runtime/topics.md)
- [Tools](./runtime/tools.md), [Packages](./runtime/packages.md), [Editing](./runtime/editing.md)
- [Shell](./runtime/shell.md), [Errors](./runtime/errors.md)
- [MCP](./runtime/mcp.md) — connect Claude, Cursor, Codex via the built-in MCP server

## Reference

- [Protocol](./reference/protocol.md) — stringd HTTP/SSE API
- [Transport](./reference/transport.md) — message structure
- [Response Format](./reference/response-format.md)
