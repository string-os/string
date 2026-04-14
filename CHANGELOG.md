# Changelog

## v0.1.0 (2026-04-08)

Initial public release.

### @string-os/core v0.1.0
- SFMD parser with block, directive, shortcut, action, and variable support
- Block extractor for `<!-- #id -->` marked regions
- Slug utility for heading-based block addressing

### @string-os/compiler v0.1.0
- Trinity Architecture compiler (inline includes on demand)
- Document validator with error reporting
- CLI tool (`sfmd`) for compile, validate, extract, fix, and clean operations

### @string-os/string v0.1.0
- Browser runtime with multi-session support
- Loader for file:// and http:// documents with content negotiation
- Resolver for includes, menus, navs, and shortcut invocations
- Full command set: /open, /act, /write, /edit, /exec, /ls, /nav, /info, /back, /refresh
- Action system: HTTP (GET/POST/PUT/PATCH/DELETE) and CLI actions
- Response templates with variable extraction
- Environment variable store with cascading scope (global > app > config)
- Auto-shortcut generation for external URLs
- HTML-to-Markdown conversion for web browsing
- PTY-based interactive bash sessions (optional)
- HTTP daemon (stringd) with SSE streaming
- CLI client for daemon interaction

### @string-os/string-mcp v0.1.0
- MCP server wrapping String's Browser runtime
- Tools: string_open, string_act, string_exec, string_ls, string_nav, string_info, string_write
- stdio transport for Claude Desktop and compatible clients
