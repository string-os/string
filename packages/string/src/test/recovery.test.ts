/**
 * Tests for disk-first agent recovery and its off-switch.
 *
 * By default a starting daemon adopts every agent home under
 * ~/.string/agents (registry self-heal). STRING_NO_AGENT_RECOVERY=1 must
 * skip that: a dev/test daemon on a shared machine starts with an empty
 * registry instead of becoming an /exec path into every agent home on the
 * box. HOME is faked per test so neither case depends on the host machine.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import * as client from '@string-os/client';
import { assert, section } from './runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../cli.ts');

interface Env {
  root: string;
  port: number;
  base: NodeJS.ProcessEnv;
}

function makeEnv(extra: NodeJS.ProcessEnv = {}): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'string-recovery-'));
  const port = 23000 + Math.floor(Math.random() * 9000);
  // Hermetic env: strip inherited STRING_* vars, then set the test-owned
  // values. HOME points into the sandbox so recovery scans OUR fake
  // ~/.string/agents, not the host machine's.
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (key.startsWith('STRING_')) delete inherited[key];
  }
  const base: NodeJS.ProcessEnv = {
    ...inherited,
    HOME: root,
    STRING_DATA_DIR: path.join(root, 'daemon'),
    STRING_CONFIG: path.join(root, 'config.json'),
    STRING_PORT: String(port),
    STRING_LOG: '0',
    ...extra,
  };
  return { root, port, base };
}

async function startDaemon(env: Env): Promise<{ stop: () => void }> {
  const child = spawn('npx', ['tsx', CLI, '--daemon', 'foreground', String(env.port)], {
    env: env.base,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 100; i++) {
    if (await client.ping(env.port)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return {
    stop: () => { try { process.kill(-child.pid!); } catch { /* already gone */ } },
  };
}

function plantAgentHome(env: Env, id: string): void {
  fs.mkdirSync(path.join(env.root, '.string', 'agents', id), { recursive: true });
}

await section('recovery — default: daemon adopts agent homes under ~/.string/agents', async () => {
  const env = makeEnv();
  plantAgentHome(env, 'ghost');
  const daemon = await startDaemon(env);
  try {
    const agents = await client.listAgents(env.port);
    assert(agents.some(a => a.id === 'ghost'), 'ghost agent recovered from disk');
  } finally {
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await section('recovery — STRING_NO_AGENT_RECOVERY=1 starts with an empty registry', async () => {
  const env = makeEnv({ STRING_NO_AGENT_RECOVERY: '1' });
  plantAgentHome(env, 'ghost');
  const daemon = await startDaemon(env);
  try {
    const agents = await client.listAgents(env.port);
    assert(agents.length === 0, 'no agents adopted from disk');

    // The flag only disables adoption — explicit registration still works.
    await client.ensureAgent(env.port, { id: 'explicit' });
    const after = await client.listAgents(env.port);
    assert(after.some(a => a.id === 'explicit'), 'explicit registration unaffected');
    assert(!after.some(a => a.id === 'ghost'), 'ghost stays unregistered');
  } finally {
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
