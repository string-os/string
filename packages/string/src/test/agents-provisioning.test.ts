/**
 * Slice 5 (#47 item 5): one-call agent provisioning + delete-cleanup —
 * the disposable-agent contract that TLDR real-String e2e runs on.
 *
 * POST /agents can pair in a single call (agent + webhook + initial
 * capability); DELETE /agents/:id tears everything down together
 * (registry, runtime/sessions, event streams, capabilities). The last
 * section walks the full disposable lifecycle end to end.
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
const HOUR = 60 * 60 * 1000;

interface Env {
  root: string;
  port: number;
  base: NodeJS.ProcessEnv;
}

function makeEnv(): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'string-provision-'));
  const port = 23000 + Math.floor(Math.random() * 9000);
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
    STRING_NO_AGENT_RECOVERY: '1',
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

function postText(port: number, urlPath: string, text: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method: 'POST', path: urlPath, agent: false,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text) } },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(text);
    req.end();
  });
}

function rawDelete(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method: 'DELETE', path: urlPath, agent: false },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

await section('provisioning — one-call pairing: agent + webhook + capability', async () => {
  const env = makeEnv();
  const daemon = await startDaemon(env);
  try {
    const prov = await client.provisionAgent(env.port, {
      id: 'pair-1',
      webhook: true,
      capability: { pathPrefix: 'inbox', verbs: ['PUT', 'GET'], ttlMs: HOUR },
    });
    assert(prov.created === true, 'agent created');
    assert(prov.home.includes(path.join('.string', 'agents', 'pair-1')), 'home derived when omitted');
    assert(!!prov.webhook_url?.startsWith('http://'), 'webhook_url in the same response');
    assert(!!prov.capability?.secret.startsWith('caps_'), 'initial capability in the same response');
    assert(prov.capability!.path_prefix === 'inbox', 'capability scope echoed');

    // Both provisioned credentials work immediately.
    const hook = await postText(env.port, new URL(prov.webhook_url!).pathname, 'paired event');
    assert(hook.status === 202, 'provisioned webhook accepts events');
    const put = await client.fsPut(env.port, 'inbox/first.txt', 'paired bytes', prov.capability!.secret);
    assert(put.status === 201, 'provisioned capability works on fs');

    // Idempotent re-provision: same webhook URL, nothing re-created.
    const again = await client.provisionAgent(env.port, { id: 'pair-1', webhook: true });
    assert(again.created === false, 're-provision is an ensure');
    assert(again.webhook_url === prov.webhook_url, 'webhook token preserved on re-provision');
    assert(again.capability === undefined, 'no capability minted unless requested');

    // Plain ensureAgent response shape unchanged (no surprise fields).
    const plain = await client.provisionAgent(env.port, { id: 'pair-1' });
    assert(plain.webhook_url === undefined && plain.capability === undefined,
      'extras appear only when requested');
  } finally {
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await section('provisioning — bad capability spec cannot half-create an agent', async () => {
  const env = makeEnv();
  const daemon = await startDaemon(env);
  try {
    let threw = '';
    try {
      await client.provisionAgent(env.port, {
        id: 'half', capability: { pathPrefix: '', verbs: ['EXEC' as client.CapabilityVerb], ttlMs: HOUR },
      });
    } catch (e) { threw = String(e); }
    assert(threw.includes('400'), 'exec verb in pairing spec → 400');
    assert(!(await client.listAgents(env.port)).some(a => a.id === 'half'),
      'agent NOT created when the capability spec is refused');

    threw = '';
    try {
      await client.provisionAgent(env.port, {
        id: 'half', capability: { pathPrefix: '../up', verbs: ['GET'], ttlMs: HOUR },
      });
    } catch (e) { threw = String(e); }
    assert(threw.includes('400'), 'escaping path_prefix in pairing spec → 400');

    threw = '';
    try {
      await client.provisionAgent(env.port, {
        id: 'half', capability: { pathPrefix: 'x', verbs: ['GET'], ttlMs: 0 },
      });
    } catch (e) { threw = String(e); }
    assert(threw.includes('400'), 'zero ttl in pairing spec → 400');
    assert((await client.listAgents(env.port)).length === 0, 'registry still empty after all refusals');
  } finally {
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await section('provisioning — disposable-agent lifecycle e2e (the TLDR recipe)', async () => {
  const env = makeEnv();
  const daemon = await startDaemon(env);
  try {
    // 1. Provision: one call → workspace + webhook + scoped capability.
    const prov = await client.provisionAgent(env.port, {
      id: 'disposable-e2e',
      webhook: true,
      capability: { pathPrefix: '', verbs: ['PUT', 'GET', 'DELETE', 'STAT'], ttlMs: HOUR },
    });
    const cap = prov.capability!.secret;

    // 2. Use: webhook event + fs round-trip + a live session.
    const hook = await postText(env.port, new URL(prov.webhook_url!).pathname, 'work item');
    assert(hook.status === 202, 'event delivered to disposable agent');
    await client.fsPut(env.port, 'inbox/discord/report.pdf', 'attachment', cap);
    const stat = await client.fsStat(env.port, 'inbox/discord/report.pdf', cap);
    assert(stat.exists && stat.size === 'attachment'.length, 'fs round-trip on disposable workspace');
    const exec = await client.exec(env.port, 'disposable-e2e', 'main', '/help');
    assert(exec.ok, 'session runs for the disposable agent');

    // 3. Destroy: one DELETE tears everything down together.
    const del = await rawDelete(env.port, '/agents/disposable-e2e');
    const parsed = JSON.parse(del.body) as {
      deleted: boolean; revoked_capabilities: number; disposed_sessions: number;
    };
    assert(del.status === 200 && parsed.deleted === true, 'delete succeeds');
    assert(parsed.revoked_capabilities === 1, `delete revoked the capability (got ${parsed.revoked_capabilities})`);
    assert(parsed.disposed_sessions >= 1, `delete disposed the live session (got ${parsed.disposed_sessions})`);

    // 4. Everything is dead.
    const deadFs = await client.fsGet(env.port, 'inbox/discord/report.pdf', cap);
    assert(deadFs.status === 401 && deadFs.reason === 'revoked', 'capability dead after delete');
    const deadHook = await postText(env.port, new URL(prov.webhook_url!).pathname, 'late event');
    assert(deadHook.status === 401, 'webhook dead after delete');
    assert((await client.listAgents(env.port)).length === 0, 'registry empty');

    // 5. Same id re-provisions FRESH: new webhook token, no old grants.
    const fresh = await client.provisionAgent(env.port, { id: 'disposable-e2e', webhook: true });
    assert(fresh.created === true, 'same id re-provisions as a new agent');
    assert(fresh.webhook_url !== prov.webhook_url, 'webhook token is fresh, not resurrected');
    const staleCap = await client.fsGet(env.port, 'inbox/discord/report.pdf', cap);
    assert(staleCap.status === 401, 'old capability stays dead across re-provision');
  } finally {
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
