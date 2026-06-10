#!/usr/bin/env node
/**
 * String CLI
 *
 * Usage:
 *   string <topic> '<body>'              One-shot execution
 *   string <topic>                       Interactive REPL
 *   string --daemon [start|stop|status]   Daemon management
 *   string --help                         Usage
 */

import readline from 'readline';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import * as client from '@string-os/client';
import { parseTopic, topicToString } from './types.js';
import {
  resolveAgentId,
  getCurrentAgent,
  setCurrentAgent,
  clearCurrentAgent,
  configPath,
  globalConfigPath,
  projectConfigPathForWrite,
} from './config.js';

/** Derive agent home directory: ~/.string/agents/{agentId}/ */
function deriveHome(agentId: string): string {
  const dir = path.join(os.homedir(), '.string', 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Terse-path agent provisioning: ensure the agent exists WITHOUT clobbering a
 * stored custom home. Only forwards `home` when STRING_HOME is explicitly set
 * (that env still forces home for the invocation). Plain calls send no home,
 * so the daemon keeps whatever home is already on record.
 */
async function ensureAgentTerse(port: number, agentId: string): Promise<void> {
  const home = process.env.STRING_HOME?.trim();
  await client.ensureAgent(port, home ? { id: agentId, home } : { id: agentId });
}

// ─── ChanFlow output ─────────────────────────────────────────────────────────

import { wrapEnvelope } from './envelope.js';

function formatOutput(
  topic: string,
  result: { ok: boolean; code?: string | null; content: string },
  json: boolean,
): string {
  if (json) {
    return JSON.stringify({
      ok: result.ok,
      topic,
      ...(result.code && { code: result.code }),
      content: result.content,
    });
  }
  return wrapEnvelope(topic, result.content);
}

// ─── Daemon auto-start ───────────────────────────────────────────────────────

async function autoStartDaemon(port: number): Promise<void> {
  const cliPath = fileURLToPath(import.meta.url);
  const isTsSource = cliPath.endsWith('.ts');
  const execBin = isTsSource ? 'npx' : process.execPath;
  const execArgs = isTsSource
    ? ['tsx', cliPath, '--daemon', 'foreground', String(port)]
    : [cliPath, '--daemon', 'foreground', String(port)];
  const child = spawn(execBin, execArgs, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (await client.ping(port)) return;
  }
  process.stderr.write('string: failed to start stringd on port ' + port + '\n');
  process.exit(1);
}

// ─── One-shot execution ──────────────────────────────────────────────────────

async function execOneShot(
  topic: string,
  body: string,
  json: boolean,
  agentFlag: string | null,
): Promise<void> {
  const port = Number(process.env.STRING_PORT) || 3923;
  const agentId = resolveAgentId(agentFlag);

  if (!await client.ping(port)) {
    await autoStartDaemon(port);
  }

  await ensureAgentTerse(port, agentId);
  const result = await client.exec(port, agentId, topic, body);

  process.stdout.write(formatOutput(topic, result, json) + '\n');
  process.exit(result.ok ? 0 : 1);
}

// ─── REPL ────────────────────────────────────────────────────────────────────

async function enterRepl(
  topic: string,
  json: boolean,
  agentFlag: string | null,
): Promise<void> {
  const port = Number(process.env.STRING_PORT) || 3923;
  const agentId = resolveAgentId(agentFlag);

  if (!await client.ping(port)) {
    await autoStartDaemon(port);
  }

  await ensureAgentTerse(port, agentId);

  const isTTY = process.stdin.isTTY ?? false;

  const prompt = () => {
    if (isTTY && !json) process.stderr.write(`[${topic}] > `);
  };

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  const lines: string[] = [];
  let closed = false;

  rl.on('line', (line) => lines.push(line));
  rl.on('close', () => { closed = true; });

  await new Promise<void>(resolveLoop => {
    const processNext = async () => {
      if (lines.length === 0) {
        if (closed) { resolveLoop(); return; }
        setTimeout(processNext, 10);
        return;
      }

      const line = lines.shift()!;
      const cmd = line.trim();

      if (!cmd) {
        if (!closed || lines.length > 0) setTimeout(processNext, 10);
        else resolveLoop();
        return;
      }
      if (cmd === '/exit' || cmd === '/quit') { resolveLoop(); return; }

      try {
        const result = await client.exec(port, agentId, topic, cmd);
        process.stdout.write(formatOutput(topic, result, json) + '\n');
      } catch (e) {
        process.stderr.write(`string: ${String(e)}\n`);
      }

      if (!closed || lines.length > 0) setTimeout(processNext, 10);
      else resolveLoop();
    };

    prompt();
    setTimeout(processNext, 10);
  });

  if (isTTY && !json) process.stderr.write('\nBye.\n');
  process.exit(0);
}

// ─── MCP stdio shim ──────────────────────────────────────────────────────────
//
// Exposes the daemon's MCP surface over stdio. Used by MCP clients (Claude
// Desktop, Codex, Cursor) that spawn a child process and speak JSON-RPC
// over stdin/stdout. The shim auto-starts the daemon if needed, ensures the
// agent is registered, then forwards `string` tool calls to `/exec`.
//
// Config example:
//   { "mcpServers": { "string": { "command": "string", "args": ["--mcp"] } } }
//
// Advanced users can pass a distinct `--agent` so sessions and `/set` env vars
// don't bleed across clients.

async function cmdMcp(agentId: string): Promise<void> {
  const port = Number(process.env.STRING_PORT) || 3923;

  if (!await client.ping(port)) {
    await autoStartDaemon(port);
  }
  await ensureAgentTerse(port, agentId);

  // Dynamic imports keep the heavy MCP SDK out of the cold-start path for
  // every CLI invocation. Only --mcp agents pay the cost.
  const { createStringServer } = await import('./mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

  const server = createStringServer(async (rawTopic, cmd) => {
    // Pre-validate topic so failures surface with the precise code (e.g.
    // INVALID_TARGET) instead of being flattened to HTTP_ERROR by the
    // daemon's sync 400 path. Mirrors the canonical form before sending.
    const parsed = parseTopic(rawTopic);
    if (!parsed) {
      return {
        ok: false,
        code: 'INVALID_TARGET',
        content: `Invalid topic: ${rawTopic}`,
        topic: rawTopic,
      };
    }
    const topic = topicToString(parsed);
    const result = await client.exec(port, agentId, topic, cmd);
    return {
      ok: result.ok,
      code: result.code ?? undefined,
      content: result.content,
      topic,
    };
  }, { claudeChannel: true });

  let watcher: client.EventWatcher | null = null;
  const stopWatcher = () => {
    watcher?.close();
    watcher = null;
  };
  const startWatcher = () => {
    if (watcher) return;
    watcher = client.watchAgentEvents(
      port,
      agentId,
      (event) => {
        void server.server.notification({
          method: 'notifications/claude/channel',
          params: {
            content: event.text,
            meta: {
              source: 'string',
              agent_id: event.agentId,
              event_id: event.id,
              received_at: event.receivedAt,
              event: event.source,
            },
          },
        } as any).catch(e => {
          process.stderr.write(`string mcp: channel notification failed: ${String(e)}\n`);
        });
      },
      (error) => {
        process.stderr.write(`string mcp: event stream error: ${error.message}\n`);
      },
    );
  };
  server.server.oninitialized = startWatcher;

  const transport = new StdioServerTransport();
  process.on('SIGINT', stopWatcher);
  process.on('SIGTERM', stopWatcher);
  await server.connect(transport);
  startWatcher();
  // Server runs until stdio closes (client process exits).
}

// ─── Claude Code channel compatibility alias ────────────────────────────────
//
// `string --mcp` now provides both the `string` MCP tool and the Claude Code
// channel capability. Keep the old flag as a compatibility alias so existing
// local test configs do not break.

async function cmdClaudeChannel(agentId: string): Promise<void> {
  await cmdMcp(agentId);
}

// ─── Daemon management ───────────────────────────────────────────────────────

async function cmdDaemon(args: string[]): Promise<void> {
  const port = Number(process.env.STRING_PORT) || 3923;
  const sub = args[0] || 'start';

  switch (sub) {
    case 'start': {
      if (await client.ping(port)) {
        console.log(`stringd already running on port ${port}`);
        return;
      }
      await autoStartDaemon(port);
      console.log(`stringd started on port ${port}`);
      break;
    }
    case 'stop': {
      if (!await client.ping(port)) {
        console.log('stringd is not running');
        return;
      }
      await client.shutdown(port);
      console.log('stringd stopped');
      break;
    }
    case 'status': {
      if (!await client.ping(port)) {
        console.log('stringd is not running');
        process.exit(1);
      }
      const info = await client.health(port);
      console.log(`stringd running on port ${port} — ${info.agents} agent(s), ${info.sessions} session(s)`);
      break;
    }
    case 'foreground': {
      // Internal: run daemon in foreground (used by autoStartDaemon)
      const hasLog = args.includes('--log');
      const fgPort = args[1] ? parseInt(args[1], 10) : port;
      const { startDaemon } = await import('./daemon.js');
      startDaemon(fgPort, { log: hasLog });
      break;
    }
    default:
      process.stderr.write(`string: unknown daemon command: ${sub}\n`);
      process.stderr.write('Usage: string --daemon [start|stop|status]\n');
      process.exit(1);
  }
}

// ─── Agent management ───────────────────────────────────────────────────────────
//
// `string agent` manages the persistent agent registry and the configured
// "current agent" (selected .string/config.json). Adding an agent sets its home; the
// current agent is what terse `string <topic> '<cmd>'` calls resolve to when no
// --agent flag or STRING_AGENT_ID is present.

/** Parse `--home <path>` and `--allow <p1,p2>` from `string agent` args. */
function parseAgentOpts(args: string[]): { home?: string; allow?: string[]; local?: boolean } {
  const opts: { home?: string; allow?: string[]; local?: boolean } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--home') opts.home = args[++i];
    else if (a.startsWith('--home=')) opts.home = a.slice('--home='.length);
    else if (a === '--allow') opts.allow = splitAllow(args[++i]);
    else if (a.startsWith('--allow=')) opts.allow = splitAllow(a.slice('--allow='.length));
    else if (a === '--local') opts.local = true;
  }
  return opts;
}

function splitAllow(val?: string): string[] {
  if (!val) return [];
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

async function ensureDaemonUp(port: number): Promise<void> {
  if (!await client.ping(port)) {
    await autoStartDaemon(port);
  }
}

async function cmdAgent(args: string[]): Promise<void> {
  const port = Number(process.env.STRING_PORT) || 3923;
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'add': {
      const id = rest[0];
      if (!id) {
        process.stderr.write('Usage: string agent add <id> [--home <path>] [--allow <p1,p2,...>]\n');
        process.exit(1);
      }
      const opts = parseAgentOpts(rest.slice(1));
      const home = opts.home ?? deriveHome(id);
      await ensureDaemonUp(port);
      await client.ensureAgent(port, { id, home, allowedPaths: opts.allow ?? [] });
      console.log(`Added agent '${id}' (home: ${home})`);
      if (opts.allow?.length) console.log(`  allowedPaths: ${opts.allow.join(', ')}`);
      console.log(`Run \`string agent use ${id}\` to make it the current agent.`);
      break;
    }
    case 'use': {
      const id = rest[0];
      if (!id) {
        process.stderr.write('Usage: string agent use <id> [--local]\n');
        process.exit(1);
      }
      const opts = parseAgentOpts(rest.slice(1));
      await ensureDaemonUp(port);
      const exists = (await client.listAgents(port)).some(u => u.id === id);
      setCurrentAgent(id, opts.local ? 'project' : 'global');
      const file = opts.local ? projectConfigPathForWrite() : globalConfigPath();
      console.log(`Current agent set to '${id}' (${opts.local ? 'local' : 'global'}: ${file}).`);
      if (!exists) {
        console.log(`Note: agent '${id}' is not registered yet — run \`string agent add ${id}\` to set its home.`);
      }
      break;
    }
    case 'current': {
      const current = getCurrentAgent() ?? 'default';
      await ensureDaemonUp(port);
      const agent = (await client.listAgents(port)).find(u => u.id === current);
      const home = agent ? agent.home : '(not registered)';
      console.log(`${current}\t${home}\tconfig: ${configPath()}`);
      break;
    }
    case 'list': {
      await ensureDaemonUp(port);
      const current = getCurrentAgent();
      const list = await client.listAgents(port);
      if (list.length === 0) {
        console.log('No agents registered.');
        break;
      }
      for (const u of list) {
        const marker = u.id === current ? '* ' : '  ';
        console.log(`${marker}${u.id}\t${u.home}`);
      }
      break;
    }
    case 'set-home': {
      const id = rest[0];
      const home = rest[1];
      if (!id || !home) {
        process.stderr.write('Usage: string agent set-home <id> <path>\n');
        process.exit(1);
      }
      await ensureDaemonUp(port);
      await client.ensureAgent(port, { id, home });
      console.log(`Set home for '${id}' → ${home}`);
      break;
    }
    case 'rm': {
      const id = rest[0];
      if (!id) {
        process.stderr.write('Usage: string agent rm <id>\n');
        process.exit(1);
      }
      await ensureDaemonUp(port);
      const deleted = await client.deleteAgent(port, id);
      if (getCurrentAgent() === id) clearCurrentAgent();
      console.log(deleted ? `Removed agent '${id}'.` : `Agent '${id}' did not exist.`);
      break;
    }
    default:
      process.stderr.write(`string: unknown agent command: ${sub ?? ''}\n`);
      process.stderr.write('Usage: string agent <add|use|current|list|set-home|rm> ...\n');
      process.exit(1);
  }
}

async function cmdWebhook(args: string[], agentFlag: string | null): Promise<void> {
  const port = Number(process.env.STRING_PORT) || 3923;
  const sub = args[0] || 'show';
  const agentId = resolveAgentId(agentFlag);

  await ensureDaemonUp(port);
  await ensureAgentTerse(port, agentId);

  switch (sub) {
    case 'show':
    case 'create': {
      const info = await client.getAgentWebhook(port, agentId);
      console.log(`Local webhook for agent '${agentId}':`);
      console.log(info.webhook_url);
      console.log('');
      console.log('Send text with:');
      console.log(`  curl -X POST --data-binary @message.txt ${info.webhook_url}`);
      break;
    }
    case 'rotate': {
      const info = await client.rotateAgentWebhook(port, agentId);
      console.log(`Rotated local webhook for agent '${agentId}':`);
      console.log(info.webhook_url);
      break;
    }
    default:
      process.stderr.write(`string: unknown webhook command: ${sub}\n`);
      process.stderr.write('Usage: string webhook [show|create|rotate]\n');
      process.exit(1);
  }
}

// ─── Usage ───────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
String v0.1

Usage:
  string <topic> '<body>'              Execute command on topic
  string <topic>                       Interactive REPL
  string '<body>'                      Command without topic (uses 'main', or
                                       derives topic from /open app:X targets)
  string --mcp [--agent <id>]          MCP stdio server + Claude Code channel
  string --daemon [start|stop|status]  Daemon management
  string agent <subcommand>            Manage agents / current agent (see below)
  string webhook [show|rotate]         Show or rotate current agent local webhook
  string --help                        This help

Agent management:
  string agent add <id> [--home <path>] [--allow <p1,p2,...>]
                                       Register an agent with a home (and optional
                                       allowed paths). Home defaults to
                                       ~/.string/agents/<id> when omitted.
  string agent use <id> [--local]       Set the current agent globally, or in
                                       the current workspace with --local
  string agent current                  Show the current agent + its home
  string agent list                     List all agents (* marks the current one)
  string agent set-home <id> <path>     Change an agent's home
  string agent rm <id>                  Remove an agent (clears current if it was)

Local webhooks:
  string webhook show                   Print the current agent's local webhook URL
  string webhook rotate                 Rotate the current agent's webhook token
  POST text to the URL, then read it with \`string event /events\`.
  In Claude Code, \`string --mcp\` also pushes webhook events through the
  String channel when loaded as a Claude Code channel.

Agent resolution (highest precedence first):
  --agent <id>  >  STRING_AGENT_ID  >  local config  >  global config  >  "default"
  Set the home at add-time or via \`agent set-home\`. Terse calls never reset a
  stored home — only \`agent add\`/\`set-home\` (or STRING_HOME) write home.

Topics:
  <name>                  Free-form session (e.g. 'main', 'notes', 'research')
  app:<pkg>[:<config>]    Installed app session (e.g. 'app:moltbook')
  bash:<name>             Persistent bash shell (e.g. 'bash:dev')
  app | bash | tool       Hub topics — manage installed/active instances
  event                   Agent event inbox
  system                  Daemon controls (env, status, restart)

Examples:
  string main '/open ./doc.md'
  string notes '/open https://developer.mozilla.org'
  string app:moltbook '/act.feed'
  string bash:dev 'pwd && ls'
  string '/open app:moltbook'           # topic derived → app:moltbook
  string '/install --app ./foo.md'      # default topic → main
  string app                            # app hub: list installed apps

Flags:
  --json      JSON envelope output (suppresses ChanFlow)

Environment:
  STRING_PORT        Daemon port (default: 3923)
  STRING_AGENT_ID    Agent ID — overrides config.currentAgent (default: "default")
  STRING_HOME        One-shot home override for this invocation
                  (normal setup: string agent add <id> --home <path>)
  STRING_CONFIG      Client config path override
                  (default: nearest .string/config.json, then ~/.string/config.json)
`);
}

// ─── Entry ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

// Extract flags
let json = false;
let daemon = false;
let mcp = false;
let claudeChannel = false;
let help = false;
let agentFlag: string | null = null;
const positional: string[] = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--json') json = true;
  else if (arg === '--daemon') daemon = true;
  else if (arg === '--mcp') mcp = true;
  else if (arg === '--claude-channel') claudeChannel = true;
  else if (arg === '--help' || arg === '-h') help = true;
  else if (arg === '--agent') {
    agentFlag = argv[++i] ?? null;
  } else if (arg.startsWith('--agent=')) {
    agentFlag = arg.slice('--agent='.length);
  } else {
    positional.push(arg);
  }
}

if (help) {
  printUsage();
  process.exit(0);
}

if (claudeChannel) {
  const agentId = resolveAgentId(agentFlag);
  cmdClaudeChannel(agentId).catch(e => {
    process.stderr.write(`string: ${e.message}\n`);
    process.exit(1);
  });
} else if (mcp) {
  const agentId = resolveAgentId(agentFlag);
  cmdMcp(agentId).catch(e => {
    process.stderr.write(`string: ${e.message}\n`);
    process.exit(1);
  });
} else if (daemon) {
  cmdDaemon(positional).catch(e => {
    process.stderr.write(`string: ${e.message}\n`);
    process.exit(1);
  });
} else if (positional[0] === 'agent') {
  // `string agent <add|use|current|list|set-home|rm> ...` — agent management.
  // Intercepted before topic dispatch.
  cmdAgent(positional.slice(1)).catch(e => {
    process.stderr.write(`string: ${e.message}\n`);
    process.exit(1);
  });
} else if (positional[0] === 'webhook') {
  cmdWebhook(positional.slice(1), agentFlag).catch(e => {
    process.stderr.write(`string: ${e.message}\n`);
    process.exit(1);
  });
} else if (positional.length === 0) {
  printUsage();
} else {
  // If the first positional starts with '/', treat the whole thing as a
  // command body. Default topic is `main` (free-form tab).
  //
  // Canonical and hub targets override the topic regardless of how the
  // call was routed:
  //   - `/open app:X`  → app:X       (canonical app session)
  //   - `/open bash:X` → bash:X      (canonical bash session)
  //   - `/open <hub>`  → <hub>       (hub: app, bash, tool, event, system)
  //
  // Free-form `/open ./file.md` or `/open https://...` keeps the caller's
  // topic. This keeps app/bash/hub sessions clean of unrelated content
  // while letting `main`, `notes`, etc. accumulate any kind of doc.
  const CANONICAL_OPEN_RE = /^\/open\s+(app:[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*|bash:[a-zA-Z0-9_-]+|app|bash|tool|event|system)\b/;

  let topic: string;
  let body: string;
  if (positional[0].startsWith('/')) {
    body = positional.join(' ');
    let derived = 'main';
    const openMatch = body.match(CANONICAL_OPEN_RE);
    if (openMatch) derived = openMatch[1];
    topic = derived;
  } else {
    const rawTopic = positional[0];
    const parsed = parseTopic(rawTopic);
    if (!parsed) {
      process.stderr.write(`string: invalid topic: ${rawTopic}\n`);
      process.exit(1);
    }
    topic = topicToString(parsed);
    body = positional.slice(1).join(' ');

    // Body overrides topic when it opens a canonical or hub target — those
    // URIs are bound to their own topic regardless of how the call was routed.
    const openMatch = body.match(CANONICAL_OPEN_RE);
    if (openMatch) topic = openMatch[1];
  }

  const run = body
    ? execOneShot(topic, body, json, agentFlag)
    : enterRepl(topic, json, agentFlag);

  run.catch(e => {
    process.stderr.write(`string: ${e.message}\n`);
    process.exit(1);
  });
}
