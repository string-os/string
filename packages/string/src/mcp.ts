/**
 * MCP server factory — exposes String's command surface as a single MCP tool.
 *
 * Single tool: `string({ topic, cmd })` — runs a String command in a topic
 * and returns the result. Mirrors the CLI's `string <topic> '<cmd>'` shape
 * exactly. The agent learns one verb, then everything else is `/info`,
 * `/act --help`, etc. inside the command surface.
 *
 * Two consumers:
 *   - daemon.ts attaches this to a streamable-HTTP transport at /mcp
 *   - cli.ts (--mcp flag) attaches it to stdio and forwards via @string-os/client
 *
 * Both share the same tool spec; only the `execFn` differs.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** Result returned by an exec backend. Matches the daemon's exec envelope. */
export interface McpExecResult {
  ok: boolean;
  code?: string | null;
  content: string;
  topic?: string;
}

/** Function that runs one command in a topic and returns the result. */
export type McpExecFn = (topic: string, cmd: string) => Promise<McpExecResult>;

const TOOL_DESCRIPTION = [
  'Run a String command in a topic. Topic is `main`, `app:NAME`, ',
  '`app:NAME:CONFIG`, or `bash:NAME`. `cmd` must start with `/`. ',
  'Examples: `/open ./doc.md`, `/act.search --q "..."`, `/exec "ls -la"`. ',
  'To discover what is available in a topic, run `/info` or `/act --help`.',
].join('');

const inputSchema = {
  topic: z
    .string()
    .min(1)
    .describe('Topic: `main` (tab), `app:NAME[:CONFIG]`, or `bash:NAME`.'),
  cmd: z
    .string()
    .min(1)
    .describe('Command starting with `/` (e.g. `/open ./README.md`).'),
};

/**
 * Create a fresh McpServer instance with the `string` tool registered.
 *
 * A new server is created per HTTP request (stateless mode) so concurrent
 * callers don't share transport state. Stdio shims call this once at startup.
 */
export function createStringServer(execFn: McpExecFn): McpServer {
  const server = new McpServer({ name: 'string', version: '0.1.0' });

  server.registerTool(
    'string',
    {
      title: 'String',
      description: TOOL_DESCRIPTION,
      inputSchema,
    },
    async ({ topic, cmd }) => {
      const result = await execFn(topic, cmd);
      const structuredContent: Record<string, unknown> = {
        ok: result.ok,
        topic: result.topic ?? topic,
      };
      if (result.code) structuredContent.code = result.code;
      return {
        content: [{ type: 'text' as const, text: result.content }],
        isError: !result.ok,
        structuredContent,
      };
    },
  );

  return server;
}
