# String — An OS for AI

String gives AI agents a single, consistent interface to apps, documents, websites, APIs, and files.

Everything is Markdown. Every action is a command. New capabilities come from new documents, not new code.

## Get Started

```bash
npm install -g @string-os/string
string file:main '/open ./README.md'
```

That's it. `string` is a normal CLI once installed. See the [Quick Start](./quickstart.md) for the full walkthrough.

## Learn More

- [Quick Start](./quickstart.md) — up and running in 5 minutes
- [Agent Integration](./agent-integration.md) — CLI, MCP, and library usage
- [Writing Skills](./writing-skills.md) — create tools and apps as Markdown files

## Key Ideas

**SFMD (String Flavored Markdown)** extends CommonMark with navigation, actions, and block addressing — while remaining 100% compatible with any Markdown viewer.

**Two primitives** cover nearly everything:
- `/open` — see something
- `/act` — do something

**Four integration paths** share the same core:
- **CLI** — `string file:main '/open doc.md'`
- **MCP Server** — plug into Claude Desktop or any MCP-compatible agent
- **In-process library** — `import { Browser } from '@string-os/string'`
- **Daemon client** — `import { exec } from '@string-os/client'` (any Node.js program; other languages via the [stringd protocol](./stringd-protocol-v0.1.md))

## Packages

| Package | npm |
|---------|-----|
| `@string-os/core` | SFMD parser and extractor |
| `@string-os/compiler` | Document compiler and validator |
| `@string-os/client` | HTTP/SSE client for stringd (standalone, no deps) |
| `@string-os/string` | Runtime + daemon + CLI |
| `@string-os/string-mcp` | MCP server |

## Links

- [GitHub Repository](https://github.com/string-os/string)
- [SFMD Specification](https://github.com/string-os/sfmd)
- [Cookbook](https://github.com/string-os/cookbook)
