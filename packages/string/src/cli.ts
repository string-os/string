#!/usr/bin/env node
/**
 * String CLI
 *
 * Usage:
 *   string <topic> '<body>'              One-shot execution
 *   string <topic>                       Interactive REPL
 *   string --daemon [start|stop|foreground] Daemon process lifecycle
 *   string --help                         Usage
 */

import readline from 'readline';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import * as client from '@string-os/client';
import { parseTopic, topicToString } from './types.js';
import { encodeArgForReparse } from './cli-args.js';
import { resolveAgentId } from './config.js';
import { agentHelp, eventHelp, systemHelp } from './commands/management.js';
import { STRING_VERSION } from './version.js';

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

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function invocationProjectDir(): string {
  return process.env.STRING_PROJECT_DIR?.trim()
    || process.env.CLAUDE_PROJECT_DIR?.trim()
    || process.cwd();
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
      // RETURN the channel-notification promise so auto-ack fires ONLY once the
      // hand-off provably resolves. A failed notification rejects → the event
      // stays unacked and is replayed on the next connect (at-least-once), never
      // acked into invisibility. Without opting into autoAck the daemon never
      // learns the event was consumed, so `delivered` never advances to `ack`
      // and every session resume / compact re-drains the whole backlog (the
      // replay flood). Fire-and-forget here was the bug.
      (event) =>
        server.server.notification({
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
        } as any),
      (error) => {
        // Covers stream, notification, and ack failures now that the callback
        // and auto-ack both surface here.
        process.stderr.write(`string mcp: event channel error: ${error.message}\n`);
      },
      { autoAck: true },
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
      process.stderr.write('Usage: string --daemon [start|stop|foreground]\n');
      process.stderr.write("For daemon status, use `string system status`.\n");
      process.exit(1);
  }
}

// ─── Usage ───────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
String v${STRING_VERSION}

Usage:
  string <topic> '<body>'              Execute command on topic
  string <topic>                       Interactive REPL
  string '<body>'                      Command without topic (uses 'main', or
                                       derives topic from /open app:X targets)
  string --mcp [--agent <id>]          MCP stdio server + Claude Code channel
  string --daemon [start|stop|foreground] Process lifecycle
  string agent <cmd> [args]            Manage agents / current agent
  string event <cmd> [args]            Event inbox + local webhook
  string system <cmd>                  Daemon state
  string --help                        This help

Agent management:
  string agent add <id> [--home <path>] [--allow <p1,p2,...>]
                                       Register an agent with a home (and optional
                                       allowed paths). Home defaults to
                                       ~/.string/agents/<id> when omitted.
  string agent use <id> [--local]      Set the current agent globally, or in
                                       the current workspace with --local
  string agent current                 Show the current agent + its home
  string agent list                    List all agents (* marks the current one)
  string agent set-home <id> <path>    Change an agent's home
  string agent rm <id>                 Remove an agent (clears current if it was)

Local webhooks:
  string event webhook show            Print the current agent's local webhook URL
  string event webhook rotate          Rotate the current agent's webhook token
  POST text to the URL, then read it with \`string event list\`.
  In Claude Code, \`string --mcp\` also pushes webhook events through the
  String channel when loaded as a Claude Code channel.

System management:
  string system status                 Daemon health + port
  string system stop                   Stop the daemon

Agent resolution (highest precedence first):
  --agent <id>  >  STRING_AGENT_ID  >  local config  >  global config  >  "default"
  Set the home at add-time or via \`agent set-home\`. Terse calls never reset a
  stored home — only \`agent add\`/\`set-home\` (or STRING_HOME) write home.

Topics:
  <name>                  Free-form session (e.g. 'main', 'notes', 'research')
  app:<pkg>[:<config>]    Installed app session (e.g. 'app:moltbook')
  bash:<name>             Persistent bash shell (e.g. 'bash:dev')
  app | bash | tool | event | system | agent
                          Hub topics — manage installed/active instances,
                          events, daemon state, and agent identity

Examples:
  string main '/open ./doc.md'
  string notes '/open https://developer.mozilla.org'
  string app:moltbook '/act.feed'
  string bash:dev 'pwd && ls'
  string '/open app:moltbook'           # topic derived → app:moltbook
  string '/install --app ./foo.md'      # default topic → main
  string app                            # app hub: list installed apps
  string system status                  # daemon status
  string agent list                     # registered agents
  string event webhook show             # local webhook URL

Flags:
  --json      JSON envelope output (suppresses ChanFlow)

Environment:
  STRING_PORT        Daemon port (default: 3923)
  STRING_AGENT_ID    Agent ID — overrides config.currentAgent (default: "default")
  STRING_HOME        One-shot home override for this invocation
                  (normal setup: string agent add <id> --home <path>)
  STRING_CONFIG      Client config path override
                  (default: nearest .string/config.json, then ~/.string/config.json)
  STRING_ROOT        Relocate ALL persistent state — config, daemon registry,
                  agent homes, tools (default base: ~/.string). One switch for a
                  hermetic/throwaway instance; STRING_CONFIG/STRING_DATA_DIR still
                  override individually.
`);
}

// ─── Entry ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

// Extract flags
let json = false;
let daemon = false;
let mcp = false;
let help = false;
let agentFlag: string | null = null;
const positional: string[] = [];

function dieUnknownFlag(arg: string): never {
  const suggestion = arg === '--deamon' ? ' Did you mean --daemon?' : '';
  process.stderr.write(`string: unknown flag '${arg}'.${suggestion}\n`);
  process.stderr.write('Run `string --help` for usage.\n');
  process.exit(1);
}

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (positional.length > 0) {
    positional.push(arg);
  } else if (arg === '--json') json = true;
  else if (arg === '--daemon') daemon = true;
  else if (arg === '--mcp') mcp = true;
  else if (arg === '--help' || arg === '-h') help = true;
  else if (arg === '--agent') {
    const value = argv[++i];
    if (!value || value.startsWith('-')) {
      process.stderr.write('string: --agent requires an agent id\n');
      process.exit(1);
    }
    agentFlag = value;
  } else if (arg.startsWith('--agent=')) {
    agentFlag = arg.slice('--agent='.length);
  } else if (arg.startsWith('-')) {
    dieUnknownFlag(arg);
  } else {
    positional.push(arg);
  }
}

if (help) {
  printUsage();
  process.exit(0);
}

function printHubCliHelp(name: string): boolean {
  const wantsHelp = positional.length === 2 && (positional[1] === '--help' || positional[1] === 'help');
  if (!wantsHelp) return false;
  if (name === 'agent') console.log(agentHelp('cli'));
  else if (name === 'event') console.log(eventHelp('cli'));
  else if (name === 'system') console.log(systemHelp('cli'));
  else return false;
  return true;
}

if (mcp) {
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
} else if (positional.length === 0) {
  printUsage();
} else if (printHubCliHelp(positional[0])) {
  process.exit(0);
} else if (positional[0] === 'webhook') {
  process.stderr.write("string: 'webhook' is no longer a top-level command. Use `string event webhook show`.\n");
  process.exit(1);
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
  const CANONICAL_OPEN_RE = /^\/open\s+(app:[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*|bash:[a-zA-Z0-9_-]+|app|bash|tool|event|system|agent)\b/;

  let topic: string;
  let body: string;
  if (positional[0].startsWith('/')) {
    body = positional.map(encodeArgForReparse).join(' ');
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
    body = positional.slice(1).map(encodeArgForReparse).join(' ');
    if (!body && parsed.type === 'hub') {
      body = '/open';
    } else if (parsed.type === 'hub' && body === '--help') {
      body = '/help';
    } else if (parsed.type === 'hub' && body && !body.trimStart().startsWith('/')) {
      body = '/' + body;
    }
    if (
      parsed.type === 'hub'
      && topic === 'agent'
      && /^\/use(?:\s|$)/.test(body)
      && /\s--local(?:\s|$)/.test(` ${body} `)
    ) {
      if (!/\s--project-dir(?:=|\s|$)/.test(` ${body} `)) {
        body += ` --project-dir ${quotePosix(invocationProjectDir())}`;
      }
      if (process.env.STRING_CONFIG && !/\s--config-override(?:=|\s|$)/.test(` ${body} `)) {
        body += ` --config-override ${quotePosix(process.env.STRING_CONFIG)}`;
      }
    }

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
