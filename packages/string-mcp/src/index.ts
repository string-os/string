#!/usr/bin/env node
/**
 * String MCP Server
 *
 * Wraps @string-os/string Browser as an MCP server.
 * Each tool maps to a String command.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Browser } from '@string-os/string';

const browser = new Browser({
  home: process.env.STRING_HOME ?? process.cwd(),
  allowHttp: true,
});

const server = new McpServer({
  name: 'string',
  version: '0.1.0',
});

// ── string_open ──────────────────────────────────────────────────────────────

server.registerTool(
  'string_open',
  {
    description: 'Open an SFMD document, URL, directory, or shortcut. Returns the rendered content.',
    inputSchema: {
      uri: z.string().describe('URI, file path, @shortcut, or file.md#block to open'),
      session: z.string().optional().describe('Session name (default: main)'),
    },
  },
  async ({ uri, session }) => {
    const result = await browser.exec(`/open ${uri}`, session);
    return {
      content: [{ type: 'text', text: result.content }],
      isError: !result.ok,
    };
  },
);

// ── string_act ───────────────────────────────────────────────────────────────

server.registerTool(
  'string_act',
  {
    description: 'Execute an action defined in the current document. Use without name to list available actions.',
    inputSchema: {
      action: z.string().describe('Action name and flags, e.g. "search --query hello" or empty to list'),
      session: z.string().optional().describe('Session name (default: main)'),
    },
  },
  async ({ action, session }) => {
    const cmd = action ? `/act.${action}` : '/act';
    const result = await browser.exec(cmd, session);
    return {
      content: [{ type: 'text', text: result.content }],
      isError: !result.ok,
    };
  },
);

// ── string_exec ──────────────────────────────────────────────────────────────

server.registerTool(
  'string_exec',
  {
    description: 'Execute a shell command in the current session context.',
    inputSchema: {
      command: z.string().describe('Shell command to execute'),
      session: z.string().optional().describe('Session name (default: main)'),
    },
  },
  async ({ command, session }) => {
    const result = await browser.exec(`/exec ${command}`, session);
    return {
      content: [{ type: 'text', text: result.content }],
      isError: !result.ok,
    };
  },
);

// ── string_ls ────────────────────────────────────────────────────────────────

server.registerTool(
  'string_ls',
  {
    description: 'List files and directories at the given path.',
    inputSchema: {
      path: z.string().optional().describe('Directory path (default: current directory)'),
      session: z.string().optional().describe('Session name (default: main)'),
    },
  },
  async ({ path, session }) => {
    const cmd = path ? `/ls ${path}` : '/ls';
    const result = await browser.exec(cmd, session);
    return {
      content: [{ type: 'text', text: result.content }],
      isError: !result.ok,
    };
  },
);

// ── string_nav ───────────────────────────────────────────────────────────────

server.registerTool(
  'string_nav',
  {
    description: 'Navigate to a shortcut or list available menus and shortcuts.',
    inputSchema: {
      topic: z.string().optional().describe('Menu name, "page" for page shortcuts, or @shortcut'),
      session: z.string().optional().describe('Session name (default: main)'),
    },
  },
  async ({ topic, session }) => {
    const cmd = topic ? `/nav ${topic}` : '/nav';
    const result = await browser.exec(cmd, session);
    return {
      content: [{ type: 'text', text: result.content }],
      isError: !result.ok,
    };
  },
);

// ── string_info ──────────────────────────────────────────────────────────────

server.registerTool(
  'string_info',
  {
    description: 'Show current session state: open document, variables, shortcuts, history.',
    inputSchema: {
      session: z.string().optional().describe('Session name (default: main)'),
    },
  },
  async ({ session }) => {
    const result = await browser.exec('/info', session);
    return {
      content: [{ type: 'text', text: result.content }],
      isError: !result.ok,
    };
  },
);

// ── string_write ─────────────────────────────────────────────────────────────

server.registerTool(
  'string_write',
  {
    description: 'Write content to a file. Creates the file if it does not exist.',
    inputSchema: {
      path: z.string().describe('File path to write to'),
      content: z.string().describe('Content to write'),
      session: z.string().optional().describe('Session name (default: main)'),
    },
  },
  async ({ path, content, session }) => {
    const result = await browser.exec(`/write ${path}\n${content}`, session);
    return {
      content: [{ type: 'text', text: result.content }],
      isError: !result.ok,
    };
  },
);

// ── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('String MCP server failed to start:', err);
  process.exit(1);
});
