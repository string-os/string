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
  resolveUserId,
  getCurrentUser,
  setCurrentUser,
  clearCurrentUser,
} from './config.js';

/** Derive user home directory: ~/.string/users/{userId}/ */
function deriveHome(userId: string): string {
  const dir = path.join(os.homedir(), '.string', 'users', userId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Terse-path user provisioning: ensure the user exists WITHOUT clobbering a
 * stored custom home. Only forwards `home` when STRINGD_HOME is explicitly set
 * (that env still forces home for the invocation). Plain calls send no home,
 * so the daemon keeps whatever home is already on record.
 */
async function ensureUserTerse(port: number, userId: string): Promise<void> {
  const home = process.env.STRINGD_HOME?.trim();
  await client.ensureUser(port, home ? { id: userId, home } : { id: userId });
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
  userFlag: string | null,
): Promise<void> {
  const port = Number(process.env.STRINGD_PORT) || 3100;
  const userId = resolveUserId(userFlag);

  if (!await client.ping(port)) {
    await autoStartDaemon(port);
  }

  await ensureUserTerse(port, userId);
  const result = await client.exec(port, userId, topic, body);

  process.stdout.write(formatOutput(topic, result, json) + '\n');
  process.exit(result.ok ? 0 : 1);
}

// ─── REPL ────────────────────────────────────────────────────────────────────

async function enterRepl(
  topic: string,
  json: boolean,
  userFlag: string | null,
): Promise<void> {
  const port = Number(process.env.STRINGD_PORT) || 3100;
  const userId = resolveUserId(userFlag);

  if (!await client.ping(port)) {
    await autoStartDaemon(port);
  }

  await ensureUserTerse(port, userId);

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
        const result = await client.exec(port, userId, topic, cmd);
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
// user is registered, then forwards `string` tool calls to `/exec`.
//
// Config example:
//   { "mcpServers": { "string": { "command": "string",
//                                  "args": ["--mcp", "--user", "claude-desktop"] } } }
//
// Each MCP client should use a distinct `--user` so sessions and `/set` env
// vars don't bleed across clients.

async function cmdMcp(userId: string): Promise<void> {
  const port = Number(process.env.STRINGD_PORT) || 3100;

  if (!await client.ping(port)) {
    await autoStartDaemon(port);
  }
  await ensureUserTerse(port, userId);

  // Dynamic imports keep the heavy MCP SDK out of the cold-start path for
  // every CLI invocation. Only --mcp users pay the cost.
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
    const result = await client.exec(port, userId, topic, cmd);
    return {
      ok: result.ok,
      code: result.code ?? undefined,
      content: result.content,
      topic,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdio closes (client process exits).
}

// ─── Daemon management ───────────────────────────────────────────────────────

async function cmdDaemon(args: string[]): Promise<void> {
  const port = Number(process.env.STRINGD_PORT) || 3100;
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
      console.log(`stringd running on port ${port} — ${info.users} user(s), ${info.sessions} session(s)`);
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

// ─── User management ───────────────────────────────────────────────────────────
//
// `string user` manages the persistent user registry and the configured
// "current user" (~/.string/config.json). Adding a user sets its home; the
// current user is what terse `string <topic> '<cmd>'` calls resolve to when no
// --user flag or STRINGD_USER is present.

/** Parse `--home <path>` and `--allow <p1,p2>` from `string user` args. */
function parseUserOpts(args: string[]): { home?: string; allow?: string[] } {
  const opts: { home?: string; allow?: string[] } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--home') opts.home = args[++i];
    else if (a.startsWith('--home=')) opts.home = a.slice('--home='.length);
    else if (a === '--allow') opts.allow = splitAllow(args[++i]);
    else if (a.startsWith('--allow=')) opts.allow = splitAllow(a.slice('--allow='.length));
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

async function cmdUser(args: string[]): Promise<void> {
  const port = Number(process.env.STRINGD_PORT) || 3100;
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'add': {
      const id = rest[0];
      if (!id) {
        process.stderr.write('Usage: string user add <id> [--home <path>] [--allow <p1,p2,...>]\n');
        process.exit(1);
      }
      const opts = parseUserOpts(rest.slice(1));
      const home = opts.home ?? deriveHome(id);
      await ensureDaemonUp(port);
      await client.ensureUser(port, { id, home, allowedPaths: opts.allow ?? [] });
      console.log(`Added user '${id}' (home: ${home})`);
      if (opts.allow?.length) console.log(`  allowedPaths: ${opts.allow.join(', ')}`);
      console.log(`Run \`string user use ${id}\` to make it the current user.`);
      break;
    }
    case 'use': {
      const id = rest[0];
      if (!id) {
        process.stderr.write('Usage: string user use <id>\n');
        process.exit(1);
      }
      await ensureDaemonUp(port);
      const exists = (await client.listUsers(port)).some(u => u.id === id);
      setCurrentUser(id);
      console.log(`Current user set to '${id}'.`);
      if (!exists) {
        console.log(`Note: user '${id}' is not registered yet — run \`string user add ${id}\` to set its home.`);
      }
      break;
    }
    case 'current': {
      const current = getCurrentUser() ?? 'default';
      await ensureDaemonUp(port);
      const user = (await client.listUsers(port)).find(u => u.id === current);
      const home = user ? user.home : '(not registered)';
      console.log(`${current}\t${home}`);
      break;
    }
    case 'list': {
      await ensureDaemonUp(port);
      const current = getCurrentUser();
      const list = await client.listUsers(port);
      if (list.length === 0) {
        console.log('No users registered.');
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
        process.stderr.write('Usage: string user set-home <id> <path>\n');
        process.exit(1);
      }
      await ensureDaemonUp(port);
      await client.ensureUser(port, { id, home });
      console.log(`Set home for '${id}' → ${home}`);
      break;
    }
    case 'rm': {
      const id = rest[0];
      if (!id) {
        process.stderr.write('Usage: string user rm <id>\n');
        process.exit(1);
      }
      await ensureDaemonUp(port);
      const deleted = await client.deleteUser(port, id);
      if (getCurrentUser() === id) clearCurrentUser();
      console.log(deleted ? `Removed user '${id}'.` : `User '${id}' did not exist.`);
      break;
    }
    default:
      process.stderr.write(`string: unknown user command: ${sub ?? ''}\n`);
      process.stderr.write('Usage: string user <add|use|current|list|set-home|rm> ...\n');
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
  string --mcp [--user <id>]           MCP stdio server (for Claude/Codex/Cursor)
  string --daemon [start|stop|status]  Daemon management
  string user <subcommand>             Manage users / current user (see below)
  string --help                        This help

User management:
  string user add <id> [--home <path>] [--allow <p1,p2,...>]
                                       Register a user with a home (and optional
                                       allowed paths). Home defaults to
                                       ~/.string/users/<id> when omitted.
  string user use <id>                 Set the current user (in config.json)
  string user current                  Show the current user + its home
  string user list                     List all users (* marks the current one)
  string user set-home <id> <path>     Change a user's home
  string user rm <id>                  Remove a user (clears current if it was)

User resolution (highest precedence first):
  --user <id>  >  STRINGD_USER  >  config.currentUser  >  "default"
  Set the home at add-time or via \`user set-home\`. Terse calls never reset a
  stored home — only \`user add\`/\`set-home\` (or STRINGD_HOME) write home.

Topics:
  <name>                  Free-form session (e.g. 'main', 'notes', 'research')
  app:<pkg>[:<config>]    Installed app session (e.g. 'app:moltbook')
  bash:<name>             Persistent bash shell (e.g. 'bash:dev')
  app | bash | tool       Hub topics — manage installed/active instances
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
  STRINGD_PORT    Daemon port (default: 3100)
  STRINGD_USER    User ID — overrides config.currentUser (default: "default")
  STRINGD_HOME    Home directory — forces home for this invocation
                  (default: ~/.string/users/{user})
  STRINGD_CONFIG  Client config path (default: ~/.string/config.json)
`);
}

// ─── Entry ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

// Extract flags
let json = false;
let daemon = false;
let mcp = false;
let help = false;
let userFlag: string | null = null;
const positional: string[] = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--json') json = true;
  else if (arg === '--daemon') daemon = true;
  else if (arg === '--mcp') mcp = true;
  else if (arg === '--help' || arg === '-h') help = true;
  else if (arg === '--user') {
    userFlag = argv[++i] ?? null;
  } else if (arg.startsWith('--user=')) {
    userFlag = arg.slice('--user='.length);
  } else {
    positional.push(arg);
  }
}

if (help) {
  printUsage();
  process.exit(0);
}

if (mcp) {
  const userId = resolveUserId(userFlag);
  cmdMcp(userId).catch(e => {
    process.stderr.write(`string: ${e.message}\n`);
    process.exit(1);
  });
} else if (daemon) {
  cmdDaemon(positional).catch(e => {
    process.stderr.write(`string: ${e.message}\n`);
    process.exit(1);
  });
} else if (positional[0] === 'user') {
  // `string user <add|use|current|list|set-home|rm> ...` — user management.
  // Intercepted before topic dispatch (note: 'user' is also a valid topic
  // name; `string user` with no subcommand prints user usage rather than
  // entering a 'user' REPL).
  cmdUser(positional.slice(1)).catch(e => {
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
  //   - `/open <hub>`  → <hub>       (hub: app, bash, tool, system)
  //
  // Free-form `/open ./file.md` or `/open https://...` keeps the caller's
  // topic. This keeps app/bash/hub sessions clean of unrelated content
  // while letting `main`, `notes`, etc. accumulate any kind of doc.
  const CANONICAL_OPEN_RE = /^\/open\s+(app:[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*|bash:[a-zA-Z0-9_-]+|app|bash|tool|system)\b/;

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
    ? execOneShot(topic, body, json, userFlag)
    : enterRepl(topic, json, userFlag);

  run.catch(e => {
    process.stderr.write(`string: ${e.message}\n`);
    process.exit(1);
  });
}
