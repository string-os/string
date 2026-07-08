/**
 * Integration tests for the System plane fs verbs (#47 item 1) — a real
 * spawned daemon, real bytes, capability-gated end to end.
 *
 * Capabilities are seeded by writing the daemon's capabilities.json (via
 * CapabilityStore against the same persistPath) BEFORE the daemon starts —
 * minting over HTTP is slice 4. Secrets here live only inside each test's
 * tmpdir state and die with it.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import * as client from '@string-os/client';
import { CapabilityStore } from '../capability.js';
import { assert, section } from './runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../cli.ts');
const HOUR = 60 * 60 * 1000;

interface Env {
  root: string;
  dataDir: string;
  port: number;
  base: NodeJS.ProcessEnv;
}

function makeEnv(): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'string-fs-'));
  const dataDir = path.join(root, 'daemon');
  const port = 23000 + Math.floor(Math.random() * 9000);
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (key.startsWith('STRING_')) delete inherited[key];
  }
  const base: NodeJS.ProcessEnv = {
    ...inherited,
    HOME: root,
    STRING_DATA_DIR: dataDir,
    STRING_CONFIG: path.join(root, 'config.json'),
    STRING_PORT: String(port),
    STRING_LOG: '0',
    STRING_NO_AGENT_RECOVERY: '1',
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

/** Seed the daemon's capability store on disk before it starts. */
function seedStore(env: Env): CapabilityStore {
  return new CapabilityStore({ persistPath: path.join(env.dataDir, 'capabilities.json') });
}

function rawFs(
  port: number,
  method: string,
  urlPath: string,
  body?: Buffer,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path: urlPath, agent: false,
        headers: body !== undefined ? { 'Content-Length': body.length } : {} },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

await section('fs — byte-exact round-trip: PUT / GET / STAT / DELETE', async () => {
  const env = makeEnv();
  const store = seedStore(env);
  const cap = store.mint({ agentId: 'ws', pathPrefix: 'inbox', verbs: ['PUT', 'GET', 'DELETE', 'STAT'], ttlMs: HOUR });
  const daemon = await startDaemon(env);
  try {
    await client.ensureAgent(env.port, { id: 'ws', home: path.join(env.root, 'ws-home') });

    // Every byte value + some length that doesn't align to anything.
    const payload = Buffer.concat([
      Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
      Buffer.from('String fs round-trip \u{1F9F5} — non-ASCII too', 'utf-8'),
    ]);

    const put = await client.fsPut(env.port, 'inbox/discord/report.pdf', payload, cap.secret);
    assert(put.status === 201 && put.created === true, `first PUT creates (201), got ${put.status}`);

    const got = await client.fsGet(env.port, 'inbox/discord/report.pdf', cap.secret);
    assert(got.ok && got.data!.equals(payload), 'GET returns byte-exact payload');

    const stat = await client.fsStat(env.port, 'inbox/discord/report.pdf', cap.secret);
    assert(stat.exists && stat.size === payload.length, 'STAT (HEAD) reports exact size');
    assert(!!stat.mtime, 'STAT reports Last-Modified');

    const put2 = await client.fsPut(env.port, 'inbox/discord/report.pdf', Buffer.from('v2'), cap.secret);
    assert(put2.status === 200 && put2.created === false, 'overwrite PUT answers 200');
    const got2 = await client.fsGet(env.port, 'inbox/discord/report.pdf', cap.secret);
    assert(got2.data!.toString('utf-8') === 'v2', 'overwrite is visible');

    const del = await client.fsDelete(env.port, 'inbox/discord/report.pdf', cap.secret);
    assert(del.ok && del.existed === true, 'DELETE removes the file');
    const gone = await client.fsGet(env.port, 'inbox/discord/report.pdf', cap.secret);
    assert(gone.status === 404, 'GET after DELETE is 404');
    const statGone = await client.fsStat(env.port, 'inbox/discord/report.pdf', cap.secret);
    assert(statGone.status === 404 && !statGone.exists, 'STAT after DELETE is 404');
    const delAgain = await client.fsDelete(env.port, 'inbox/discord/report.pdf', cap.secret);
    assert(delAgain.ok && delAgain.existed === false, 'DELETE is idempotent (200, existed=false)');

    // Bytes actually live in the agent workspace, nowhere else.
    await client.fsPut(env.port, 'inbox/discord/again.bin', payload, cap.secret);
    const onDisk = fs.readFileSync(path.join(env.root, 'ws-home', 'inbox', 'discord', 'again.bin'));
    assert(onDisk.equals(payload), 'file lands under the agent home');
  } finally {
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await section('fs — authz matrix: 401/403/400 semantics', async () => {
  const env = makeEnv();
  const store = seedStore(env);
  const putOnly = store.mint({ agentId: 'ws', pathPrefix: 'inbox', verbs: ['PUT'], ttlMs: HOUR });
  const expired = store.mint({ agentId: 'ws', pathPrefix: 'inbox', verbs: ['GET'], ttlMs: 1 });
  const daemon = await startDaemon(env);
  try {
    await client.ensureAgent(env.port, { id: 'ws', home: path.join(env.root, 'ws-home') });
    await client.fsPut(env.port, 'inbox/f.txt', 'hello', putOnly.secret);

    const noCap = await rawFs(env.port, 'GET', '/fs/inbox/f.txt');
    assert(noCap.status === 401, 'no capability → 401');

    const forged = await client.fsGet(env.port, 'inbox/f.txt', 'caps_forged');
    assert(forged.status === 401 && forged.reason === 'unknown_token', 'forged secret → 401 unknown_token');

    const wrongVerb = await client.fsGet(env.port, 'inbox/f.txt', putOnly.secret);
    assert(wrongVerb.status === 403 && wrongVerb.reason === 'verb_not_allowed', 'verb outside grant → 403');

    const outside = await client.fsPut(env.port, 'outbox/f.txt', 'x', putOnly.secret);
    assert(outside.status === 403 && outside.reason === 'path_outside_scope', 'path outside subtree → 403');

    await new Promise(r => setTimeout(r, 50));
    const late = await client.fsGet(env.port, 'inbox/f.txt', expired.secret);
    assert(late.status === 401 && late.reason === 'expired', 'expired capability → 401');

    // WHATWG URL parsing collapses dot segments (raw or single-encoded)
    // BEFORE routing, so this lands outside /fs and 404s — it can never
    // reach a workspace. Anything that does reach the fs layer with a
    // literal '..' is killed by the verifier (covered in capability.test).
    const traversal = await rawFs(env.port, 'GET', '/fs/inbox/%2e%2e/%2e%2e/etc/passwd?cap=' + putOnly.secret);
    assert(traversal.status !== 200 && traversal.body.indexOf('escape') === -1,
      `encoded traversal never serves bytes (got ${traversal.status})`);

    // Double-encoded dots survive URL parsing but decode to the LITERAL
    // segment '%2e%2e' — a weird filename inside the workspace, not '..'.
    const doubleEnc = await rawFs(env.port, 'PUT', '/fs/inbox/%252e%252e?cap=' + putOnly.secret, Buffer.from('contained'));
    assert(doubleEnc.status === 201, `double-encoded dots are a literal filename (got ${doubleEnc.status})`);
    assert(fs.existsSync(path.join(env.root, 'ws-home', 'inbox', '%2e%2e')),
      'double-encoded write stayed inside the workspace');

    const exec = await rawFs(env.port, 'POST', '/fs/inbox/f.txt?cap=' + putOnly.secret, Buffer.from('x'));
    assert(exec.status === 405, 'non-data method on the system plane → 405');
  } finally {
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await section('fs — presigned single-use URL (?cap=) consumed exactly once', async () => {
  const env = makeEnv();
  const store = seedStore(env);
  const presigned = store.mint({
    agentId: 'ws', pathPrefix: 'outbox/report.pdf', verbs: ['GET'], ttlMs: HOUR, singleUse: true,
  });
  const writer = store.mint({ agentId: 'ws', pathPrefix: 'outbox', verbs: ['PUT'], ttlMs: HOUR });
  const daemon = await startDaemon(env);
  try {
    await client.ensureAgent(env.port, { id: 'ws', home: path.join(env.root, 'ws-home') });
    await client.fsPut(env.port, 'outbox/report.pdf', 'the report bytes', writer.secret);

    const url = `/fs/outbox/report.pdf?cap=${presigned.secret}`;
    const first = await rawFs(env.port, 'GET', url);
    assert(first.status === 200 && first.body.toString('utf-8') === 'the report bytes',
      'presigned GET succeeds once');
    const second = await rawFs(env.port, 'GET', url);
    assert(second.status === 401, `presigned GET refused on reuse (got ${second.status})`);
  } finally {
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await section('fs — symlinks refused anywhere along the path', async () => {
  const env = makeEnv();
  const store = seedStore(env);
  const cap = store.mint({ agentId: 'ws', pathPrefix: '', verbs: ['PUT', 'GET'], ttlMs: HOUR });
  const daemon = await startDaemon(env);
  try {
    const home = path.join(env.root, 'ws-home');
    await client.ensureAgent(env.port, { id: 'ws', home });

    // A secret outside the workspace, and links pointing at it.
    const outside = path.join(env.root, 'outside-secret.txt');
    fs.writeFileSync(outside, 'workspace escape target');
    fs.mkdirSync(path.join(home, 'inbox'), { recursive: true });
    fs.symlinkSync(outside, path.join(home, 'inbox', 'link-file'));
    fs.symlinkSync(path.dirname(outside), path.join(home, 'inbox', 'link-dir'));

    const viaFile = await client.fsGet(env.port, 'inbox/link-file', cap.secret);
    assert(viaFile.status === 403, `GET through symlink refused (got ${viaFile.status})`);

    const viaDir = await client.fsGet(env.port, 'inbox/link-dir/outside-secret.txt', cap.secret);
    assert(viaDir.status === 403, `GET through symlinked dir refused (got ${viaDir.status})`);

    const writeThrough = await client.fsPut(env.port, 'inbox/link-dir/injected.txt', 'x', cap.secret);
    assert(writeThrough.status === 403, `PUT through symlinked dir refused (got ${writeThrough.status})`);
    assert(!fs.existsSync(path.join(env.root, 'injected.txt')), 'nothing written outside the workspace');
  } finally {
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await section('fs — size cap and directory conflicts', async () => {
  const env = makeEnv();
  const store = seedStore(env);
  const cap = store.mint({ agentId: 'ws', pathPrefix: '', verbs: ['PUT', 'GET', 'DELETE'], ttlMs: HOUR });
  const daemon = await startDaemon(env);
  try {
    const home = path.join(env.root, 'ws-home');
    await client.ensureAgent(env.port, { id: 'ws', home });

    const tooBig = Buffer.alloc(32 * 1024 * 1024 + 1);
    const big = await client.fsPut(env.port, 'big.bin', tooBig, cap.secret);
    assert(big.status === 413, `PUT over fs.max_bytes → 413 (got ${big.status})`);

    const exactlyMax = Buffer.alloc(32 * 1024 * 1024);
    const atCap = await client.fsPut(env.port, 'max.bin', exactlyMax, cap.secret);
    assert(atCap.ok, 'PUT of exactly fs.max_bytes succeeds');

    fs.mkdirSync(path.join(home, 'somedir'));
    const putDir = await client.fsPut(env.port, 'somedir', 'x', cap.secret);
    assert(putDir.status === 409, `PUT onto a directory → 409 (got ${putDir.status})`);
    const getDir = await client.fsGet(env.port, 'somedir', cap.secret);
    assert(getDir.status === 409, `GET of a directory → 409 (got ${getDir.status})`);
    const delDir = await client.fsDelete(env.port, 'somedir', cap.secret);
    assert(delDir.status === 409, `DELETE of a directory → 409 (got ${delDir.status})`);

    const midFile = await client.fsPut(env.port, 'max.bin/child.txt', 'x', cap.secret);
    assert(midFile.status === 409, `PUT below a file → 409 (got ${midFile.status})`);
  } finally {
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await section('fs — agent delete revokes its capabilities; /describe advertises fs', async () => {
  const env = makeEnv();
  const store = seedStore(env);
  const cap = store.mint({ agentId: 'doomed', pathPrefix: '', verbs: ['PUT', 'GET'], ttlMs: HOUR });
  const daemon = await startDaemon(env);
  try {
    await client.ensureAgent(env.port, { id: 'doomed', home: path.join(env.root, 'doomed-home') });
    const before = await client.fsPut(env.port, 'f.txt', 'x', cap.secret);
    assert(before.ok, 'capability works while the agent exists');

    await client.deleteAgent(env.port, 'doomed');
    const after = await client.fsGet(env.port, 'f.txt', cap.secret);
    assert(after.status === 401 && after.reason === 'revoked', 'agent delete revokes its capabilities');

    const desc = await client.describe(env.port);
    assert(desc!.capabilities['fs']?.max_bytes === 32 * 1024 * 1024,
      '/describe advertises fs.max_bytes = 32MB');
  } finally {
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
