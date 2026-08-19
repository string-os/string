/**
 * Integration tests for capability issuance (#47 item 3) — HTTP mint/list/
 * revoke plus the shell mint verb, all against a real spawned daemon.
 * Unlike fs.test.ts (which pre-seeds capabilities.json), everything here is
 * minted LIVE over HTTP — the flow that retires manual seeding.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'string-capissue-'));
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

function runCli(env: Env, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('npx', ['tsx', CLI, ...args], {
    env: env.base,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
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

function rawGet(port: number, urlPath: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method: 'GET', path: urlPath, agent: false },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

await section('issuance — HTTP mint feeds fs live (no restart, no seeding)', async () => {
  const env = makeEnv();
  const daemon = await startDaemon(env);
  try {
    await client.ensureAgent(env.port, { id: 'ws', home: path.join(env.root, 'ws-home') });

    const minted = await client.mintCapability(env.port, {
      agentId: 'ws', pathPrefix: 'inbox', verbs: ['PUT', 'GET'], ttlMs: HOUR,
    });
    assert(minted.token_id.startsWith('cap_') && minted.secret.startsWith('caps_'), 'mint returns id + secret');
    assert(minted.path_prefix === 'inbox' && minted.single_use === false, 'mint echoes normalized grant');

    const put = await client.fsPut(env.port, 'inbox/live.txt', 'minted live', minted.secret);
    assert(put.status === 201, 'freshly minted capability works immediately');
    const got = await client.fsGet(env.port, 'inbox/live.txt', minted.secret);
    assert(got.ok && got.data!.toString('utf-8') === 'minted live', 'round-trip through live-minted token');

    const desc = await client.describe(env.port);
    assert('capability-tokens' in desc!.capabilities, '/describe advertises capability-tokens');
  } finally {
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await section('issuance — mint validation over HTTP', async () => {
  const env = makeEnv();
  const daemon = await startDaemon(env);
  try {
    await client.ensureAgent(env.port, { id: 'ws' });

    let threw = '';
    try { await client.mintCapability(env.port, { agentId: 'ghost', pathPrefix: '', verbs: ['GET'], ttlMs: HOUR }); } catch (e) { threw = String(e); }
    assert(threw.includes('404'), 'mint for unknown agent → 404 (capability must target a real workspace)');

    threw = '';
    try { await client.mintCapability(env.port, { agentId: 'ws', pathPrefix: '', verbs: ['EXEC' as client.CapabilityVerb], ttlMs: HOUR }); } catch (e) { threw = String(e); }
    assert(threw.includes('400') && threw.includes('system plane'), 'exec verb refused at the mint endpoint');

    threw = '';
    try { await client.mintCapability(env.port, { agentId: 'ws', pathPrefix: '../up', verbs: ['GET'], ttlMs: HOUR }); } catch (e) { threw = String(e); }
    assert(threw.includes('400'), 'escaping path_prefix refused');

    threw = '';
    try { await client.mintCapability(env.port, { agentId: 'ws', pathPrefix: '', verbs: ['GET'], ttlMs: 0 }); } catch (e) { threw = String(e); }
    assert(threw.includes('400'), 'non-positive ttl refused');
  } finally {
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await section('issuance — list has no secrets; revoke kills fs access; presigned single-use', async () => {
  const env = makeEnv();
  const daemon = await startDaemon(env);
  try {
    await client.ensureAgent(env.port, { id: 'ws', home: path.join(env.root, 'ws-home') });
    await client.ensureAgent(env.port, { id: 'other', home: path.join(env.root, 'other-home') });

    const a = await client.mintCapability(env.port, { agentId: 'ws', pathPrefix: 'inbox', verbs: ['PUT', 'GET'], ttlMs: HOUR });
    await client.mintCapability(env.port, { agentId: 'other', pathPrefix: '', verbs: ['STAT'], ttlMs: HOUR });

    const all = await client.listCapabilities(env.port);
    assert(all.length === 2, 'list returns all records');
    assert(all.every(r => !('secret' in r)), 'list never exposes secrets');
    const filtered = await client.listCapabilities(env.port, 'ws');
    assert(filtered.length === 1 && filtered[0].token_id === a.token_id, 'agent_id filter works');

    await client.fsPut(env.port, 'inbox/f.txt', 'x', a.secret);
    const revoked = await client.revokeCapability(env.port, a.token_id);
    assert(revoked === true, 'revoke by token id');
    assert((await client.revokeCapability(env.port, a.token_id)) === false, 'second revoke is a no-op');
    const refused = await client.fsGet(env.port, 'inbox/f.txt', a.secret);
    assert(refused.status === 401 && refused.reason === 'revoked', 'revoked capability refused on fs');

    // Presigned single-use, minted over HTTP, used via ?cap=.
    const writer = await client.mintCapability(env.port, { agentId: 'ws', pathPrefix: 'outbox', verbs: ['PUT'], ttlMs: HOUR });
    await client.fsPut(env.port, 'outbox/report.pdf', 'report bytes', writer.secret);
    const presigned = await client.mintCapability(env.port, {
      agentId: 'ws', pathPrefix: 'outbox/report.pdf', verbs: ['GET'], ttlMs: HOUR, singleUse: true,
    });
    const url = `/fs/outbox/report.pdf?cap=${presigned.secret}`;
    const first = await rawGet(env.port, url);
    assert(first.status === 200 && first.body.toString('utf-8') === 'report bytes', 'presigned GET works once');
    const second = await rawGet(env.port, url);
    assert(second.status === 401, 'presigned replay refused');
  } finally {
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await section('issuance — shell mint verb (CLI e2e): mint, use, list, revoke', async () => {
  const env = makeEnv();
  const daemon = await startDaemon(env);
  try {
    await client.ensureAgent(env.port, { id: 'eve', home: path.join(env.root, 'eve-home') });
    const use = runCli(env, ['agent', 'use', 'eve']);
    assert(use.code === 0, 'agent use eve ok');

    // The worked-example flow from the docs: mint a single-use read cap.
    const put = runCli(env, ['agent', 'capability', 'mint', '--path', 'outbox', '--verbs', 'put', '--ttl', '1h']);
    assert(put.code === 0, `mint put-cap exits 0 (stderr: ${put.stderr})`);
    const putSecret = put.stdout.match(/secret: (caps_[A-Za-z0-9_-]+)/)?.[1];
    assert(!!putSecret, 'mint output shows the secret once');
    await client.fsPut(env.port, 'outbox/report.pdf', 'attachment bytes', putSecret!);

    const mint = runCli(env, ['agent', 'capability', 'mint',
      '--path', 'outbox/report.pdf', '--verbs', 'get', '--ttl', '15m', '--single-use']);
    assert(mint.code === 0, `mint exits 0 (stderr: ${mint.stderr})`);
    assert(mint.stdout.includes('single-use'), 'mint output marks single-use');
    const readSecret = mint.stdout.match(/secret: (caps_[A-Za-z0-9_-]+)/)?.[1];
    const tokenId = mint.stdout.match(/(cap_[A-Za-z0-9_-]+)/)?.[1];
    assert(!!readSecret && !!tokenId, 'mint output has secret + token id');

    const fetched = await rawGet(env.port, `/fs/outbox/report.pdf?cap=${readSecret}`);
    assert(fetched.status === 200 && fetched.body.toString('utf-8') === 'attachment bytes',
      'channel-server-style presigned GET delivers the attachment');
    const replay = await rawGet(env.port, `/fs/outbox/report.pdf?cap=${readSecret}`);
    assert(replay.status === 401, 'attachment capability consumed after delivery');

    const list = runCli(env, ['agent', 'capability', 'list']);
    assert(list.code === 0 && list.stdout.includes(tokenId!), 'capability list shows token id');
    assert(!list.stdout.includes(readSecret!), 'capability list never prints secrets');
    // The header carries the tool's OWN computed count, and it must equal the rows
    // shown (a checker reads the number instead of counting `cap_` lines).
    const capCount = list.stdout.match(/Capabilities[^\n]*\((\d+)\):/);
    assert(capCount !== null, `capability list header carries a count: ${JSON.stringify(list.stdout)}`);
    const capRows = list.stdout.split('\n').filter(l => /\bcap_[A-Za-z0-9_-]+/.test(l)).length;
    assert(Number(capCount![1]) === capRows,
      `capability count (${capCount![1]}) equals rendered rows (${capRows})`);

    const putTokenId = put.stdout.match(/(cap_[A-Za-z0-9_-]+)/)?.[1];
    const revoke = runCli(env, ['agent', 'capability', 'revoke', putTokenId!]);
    assert(revoke.code === 0 && revoke.stdout.includes('Revoked'), 'capability revoke via CLI');
    const dead = await client.fsPut(env.port, 'outbox/again.txt', 'x', putSecret!);
    assert(dead.status === 401 && dead.reason === 'revoked', 'revoked shell-minted capability refused');
  } finally {
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
