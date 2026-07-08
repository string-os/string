/**
 * Tests for GET /describe — the daemon self-describe endpoint (#47 item 4).
 *
 * Clients must never assume a daemon's API surface from its port; /describe
 * is the handshake: version + api id + self-declared instance identity +
 * capability map with operational limits. /health stays a minimal liveness
 * check and its shape is pinned here so /describe work never leaks into it.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import * as client from '@string-os/client';
import { assert, section } from './runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../cli.ts');
const PKG_VERSION = (
  JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')) as { version: string }
).version;

interface Env {
  root: string;
  dataDir: string;
  port: number;
  base: NodeJS.ProcessEnv;
}

function makeEnv(): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'string-describe-'));
  const dataDir = path.join(root, 'daemon');
  const port = 23000 + Math.floor(Math.random() * 9000);
  // Hermetic env: strip inherited STRING_* vars (a host session may export
  // e.g. STRING_AGENT_ID), then set the test-owned values.
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (key.startsWith('STRING_')) delete inherited[key];
  }
  const base: NodeJS.ProcessEnv = {
    ...inherited,
    STRING_DATA_DIR: dataDir,
    STRING_CONFIG: path.join(root, 'config.json'),
    STRING_PORT: String(port),
    STRING_LOG: '0',
  };
  return { root, dataDir, port, base };
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

function writeInstanceConfig(env: Env, contents: unknown): void {
  fs.mkdirSync(env.dataDir, { recursive: true });
  fs.writeFileSync(path.join(env.dataDir, 'daemon.json'), JSON.stringify(contents));
}

await section('describe — default (unconfigured) instance', async () => {
  const env = makeEnv();
  const daemon = await startDaemon(env);
  try {
    const desc = await client.describe(env.port);
    assert(!!desc, 'describe returns a body');
    assert(desc!.name === 'stringd', 'name is stringd');
    assert(desc!.version === PKG_VERSION, 'version matches package.json');
    assert(desc!.api === 'string-daemon/v2', 'api surface id is string-daemon/v2');
    assert(desc!.instance.instance_label === 'stringd', 'unconfigured label defaults to stringd');
    assert(desc!.instance.role === 'unknown',
      'unconfigured role reports unknown (fail-safe: consumers refuse unlabeled daemons)');

    for (const key of ['describe', 'agents', 'agent-webhooks', 'events', 'event-stream', 'sessions', 'exec', 'mcp']) {
      assert(key in desc!.capabilities, `capability advertised: ${key}`);
    }
    assert(desc!.capabilities['events'].max_webhook_text_bytes === 64 * 1024,
      'events capability advertises webhook text cap');
    assert(desc!.capabilities['exec'].max_request_body_bytes === 10 * 1024 * 1024,
      'exec capability advertises request body cap');
    assert(desc!.capabilities['fs']?.max_bytes === 32 * 1024 * 1024,
      'fs capability advertises max_bytes');

    // /health is pinned: liveness only, no instance/capability leakage.
    const h = await client.health(env.port);
    assert(h.ok === true && h.version === PKG_VERSION, '/health still answers ok+version');
    assert(JSON.stringify(Object.keys(h).sort()) === JSON.stringify(['agents', 'ok', 'sessions', 'version']),
      '/health shape unchanged (ok, version, agents, sessions)');
  } finally {
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await section('describe — instance identity from daemon.json', async () => {
  const env = makeEnv();
  writeInstanceConfig(env, { instance_label: 'live-main', role: 'production' });
  const daemon = await startDaemon(env);
  try {
    const desc = await client.describe(env.port);
    assert(desc!.instance.instance_label === 'live-main', 'configured label reported');
    assert(desc!.instance.role === 'production', 'configured role reported');

    // Identity is read per request: relabeling applies without a restart.
    writeInstanceConfig(env, { instance_label: 'scratch', role: 'test' });
    const relabeled = await client.describe(env.port);
    assert(relabeled!.instance.instance_label === 'scratch', 'relabel applies without restart');
    assert(relabeled!.instance.role === 'test', 'role change applies without restart');

    // Invalid values fall back to fail-safe defaults, not to a trusted role.
    writeInstanceConfig(env, { instance_label: '   ', role: 'prod' });
    const fallback = await client.describe(env.port);
    assert(fallback!.instance.instance_label === 'stringd', 'blank label falls back to default');
    assert(fallback!.instance.role === 'unknown', 'invalid role falls back to unknown, never dev');
  } finally {
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await section('describe — client returns null for pre-v2 daemons (404)', async () => {
  // A pre-/describe daemon answers /health but 404s /describe (the :3100
  // surface-mismatch class). The client maps that to null, not an error.
  const legacy = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '0.0.1', agents: 0, sessions: 0 }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Not found: ${req.method} ${req.url}` }));
  });
  const port = await new Promise<number>(resolve => {
    legacy.listen(0, '127.0.0.1', () => {
      resolve((legacy.address() as { port: number }).port);
    });
  });
  try {
    assert(await client.ping(port), 'legacy daemon answers /health');
    const desc = await client.describe(port);
    assert(desc === null, 'describe → null on 404 (unknown surface)');
  } finally {
    legacy.close();
  }
});
