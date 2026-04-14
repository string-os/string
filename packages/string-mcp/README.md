# @string-os/string-mcp

MCP (Model Context Protocol) server for String. Lets any MCP-aware AI client — Claude Desktop, Cursor, and others — read and execute SFMD documents with zero custom integration.

## Install

```bash
npm install -g @string-os/string-mcp
```

## Claude Desktop setup

Add to your Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "string": {
      "command": "npx",
      "args": ["@string-os/string-mcp"]
    }
  }
}
```

Restart Claude Desktop. The `string` server will appear in the MCP panel, and Claude will be able to open SFMD documents and invoke their actions.

## Cursor setup

Cursor supports MCP natively. Add the same config block in Cursor's MCP settings.

## What it exposes

The MCP server surfaces String runtime capabilities as MCP tools:

- `open` — load an SFMD document (file path, URL, or shortcut)
- `act` — invoke an action defined in a loaded document
- `nav` — navigate shortcuts and menus
- `info` — show current session and document state

## Security

Action execution is gated by the String runtime's default allowlist. See [SECURITY.md](https://github.com/string-os/string/blob/main/SECURITY.md) for the v0.1 trust model.

## Related

- [`@string-os/string`](https://www.npmjs.com/package/@string-os/string) — the runtime this adapter wraps
- [String monorepo](https://github.com/string-os/string)
- [MCP specification](https://modelcontextprotocol.io)

## License

MIT
