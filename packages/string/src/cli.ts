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

/** Derive user home directory: ~/.string/users/{userId}/ */
function deriveHome(userId: string): string {
  const dir = path.join(os.homedir(), '.string', 'users', userId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── ChanFlow output ─────────────────────────────────────────────────────────

const CHANFLOW_OPEN = (topic: string) => `<𝒞=string:${topic}>`;
const CHANFLOW_CLOSE = `</𝒞>`;

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
  return `${CHANFLOW_OPEN(topic)}\n${result.content}\n${CHANFLOW_CLOSE}`;
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

async function execOneShot(topic: string, body: string, json: boolean): Promise<void> {
  const port = Number(process.env.STRINGD_PORT) || 3100;
  const userId = process.env.STRINGD_USER || 'default';
  const home = process.env.STRINGD_HOME || deriveHome(userId);

  if (!await client.ping(port)) {
    await autoStartDaemon(port);
  }

  await client.ensureUser(port, { id: userId, home });
  const result = await client.exec(port, userId, topic, body);

  process.stdout.write(formatOutput(topic, result, json) + '\n');
  process.exit(result.ok ? 0 : 1);
}

// ─── REPL ────────────────────────────────────────────────────────────────────

async function enterRepl(topic: string, json: boolean): Promise<void> {
  const port = Number(process.env.STRINGD_PORT) || 3100;
  const userId = process.env.STRINGD_USER || 'default';
  const home = process.env.STRINGD_HOME || deriveHome(userId);

  if (!await client.ping(port)) {
    await autoStartDaemon(port);
  }

  await client.ensureUser(port, { id: userId, home });

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

// ─── Usage ───────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
String v0.1

Usage:
  string <topic> '<body>'              Execute command on topic
  string <topic>                       Interactive REPL
  string '<body>'                      Command without topic (uses file:main, or
                                       derives topic from /open app:X targets)
  string --daemon [start|stop|status]   Daemon management
  string --help                         This help

Examples:
  string app:weather '/act.now --city Seoul'
  string file:main '/open ./doc.md'
  string web:docs '/open https://developer.mozilla.org'
  string app:weather                    # enters REPL
  string '/open app:weather'            # topic auto-derived → app:weather
  string '/install --app ./foo.md'      # default topic → file:main

Flags:
  --json      JSON envelope output (suppresses ChanFlow)

Environment:
  STRINGD_PORT    Daemon port (default: 3100)
  STRINGD_USER    User ID (default: "default")
  STRINGD_HOME    Home directory (default: ~/.string/users/{user})
`);
}

// ─── Entry ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

// Extract flags
let json = false;
let daemon = false;
let help = false;
const positional: string[] = [];

for (const arg of argv) {
  if (arg === '--json') json = true;
  else if (arg === '--daemon') daemon = true;
  else if (arg === '--help' || arg === '-h') help = true;
  else positional.push(arg);
}

if (help) {
  printUsage();
  process.exit(0);
}

if (daemon) {
  cmdDaemon(positional).catch(e => {
    process.stderr.write(`string: ${e.message}\n`);
    process.exit(1);
  });
} else if (positional.length === 0) {
  printUsage();
} else {
  // If the first positional starts with '/', treat the whole thing as a
  // command body. Default topic is `file:main`. For `/open app:X` or
  // `/open tool:X`, derive topic from the target so app-scoped env (like
  // $API_KEY) resolves correctly without forcing the user to type the
  // topic twice.
  let topic: string;
  let body: string;
  if (positional[0].startsWith('/')) {
    body = positional.join(' ');
    let derived = 'file:main';
    const openMatch = body.match(/^\/open\s+(app:[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)?|tool:[a-zA-Z0-9_-]+)\b/);
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
  }

  const run = body
    ? execOneShot(topic, body, json)
    : enterRepl(topic, json);

  run.catch(e => {
    process.stderr.write(`string: ${e.message}\n`);
    process.exit(1);
  });
}
