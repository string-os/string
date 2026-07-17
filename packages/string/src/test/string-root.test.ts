/**
 * STRING_ROOT hermetic-isolation test.
 *
 * The incident this guards against: a throwaway daemon/CLI that isolated only
 * STRING_DATA_DIR (a daemon-only var) still wrote the client `currentAgent` to
 * the GLOBAL ~/.string/config.json and registered a stray agent into the global
 * registry — because config/home resolution is independent of STRING_DATA_DIR.
 *
 * STRING_ROOT is the single isolation switch: setting ONLY STRING_ROOT (no
 * STRING_DATA_DIR, no STRING_CONFIG) must relocate config, the daemon registry,
 * and agent homes under that root — and the daemon must NOT scavenge the real
 * ~/.string/agents tree.
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

/** Env with only STRING_ROOT + STRING_PORT set — deliberately NOT STRING_DATA_DIR
 *  or STRING_CONFIG, to prove STRING_ROOT alone is sufficient for isolation. */
function rootEnv(root: string, port: number): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (key.startsWith('STRING_')) delete inherited[key];
  }
  return { ...inherited, STRING_ROOT: root, STRING_PORT: String(port), STRING_LOG: '0' };
}

function runCli(env: NodeJS.ProcessEnv, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('npx', ['tsx', CLI, ...args], { env, encoding: 'utf-8', timeout: 30_000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function startDaemon(env: NodeJS.ProcessEnv, port: number): Promise<{ stop: () => void }> {
  const child = spawn('npx', ['tsx', CLI, '--daemon', 'foreground', String(port)], {
    env, detached: true, stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 100; i++) {
    if (await client.ping(port)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return { stop: () => { try { process.kill(-child.pid!); } catch { /* already gone */ } } };
}

function postText(port: number, token: string, text: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/webhook/${token}`, method: 'POST', agent: false,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text) },
    }, res => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.write(text); req.end();
  });
}

await section('STRING_ROOT — one switch isolates config + registry + homes from ~/.string', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'string-root-'));
  const port = 24000 + Math.floor(Math.random() * 5000);
  const env = rootEnv(root, port);
  const daemon = await startDaemon(env, port);
  try {
    assert(await client.ping(port), 'daemon up under STRING_ROOT');

    // Register + select an agent WITHOUT --home, so its home is derived.
    assert(runCli(env, ['agent', 'add', 'rooted']).code === 0, 'agent add ok');
    assert(runCli(env, ['agent', 'use', 'rooted']).code === 0, 'agent use ok');

    // 1. Client config landed under the root, not global ~/.string/config.json.
    const configFile = path.join(root, 'config.json');
    assert(fs.existsSync(configFile), 'config.json created under STRING_ROOT');
    assert(JSON.parse(fs.readFileSync(configFile, 'utf-8')).currentAgent === 'rooted',
      'currentAgent written under the root, not global');

    // 2. Daemon registry landed under <root>/daemon, with the derived home under <root>/agents.
    const agentsJson = path.join(root, 'daemon', 'agents.json');
    assert(fs.existsSync(agentsJson), 'agents.json created under STRING_ROOT/daemon');
    const registry: Array<{ id: string; home: string; webhookToken?: string }> = JSON.parse(fs.readFileSync(agentsJson, 'utf-8'));
    const rooted = registry.find(a => a.id === 'rooted');
    assert(!!rooted, 'agent registered under the isolated registry');
    assert(rooted!.home === path.join(root, 'agents', 'rooted'), 'derived home is under STRING_ROOT/agents');

    // 3. The daemon did NOT scavenge the real ~/.string/agents tree (blast-radius
    //    containment — recovery is enabled here, yet no real crew agent appears).
    const listed = await client.listAgents(port);
    assert(!listed.some(a => a.id === 'leo' || a.id === 'nova' || a.id === 'atlas'),
      'no real crew agent scavenged from ~/.string under STRING_ROOT');

    // 4. A webhook event lands under the isolated home, nowhere global.
    //    The token is minted lazily by `webhook show`, then persisted to the
    //    (isolated) registry — re-read it from there.
    assert(runCli(env, ['event', 'webhook', 'show']).code === 0, 'webhook show ok');
    const token = (JSON.parse(fs.readFileSync(agentsJson, 'utf-8')) as Array<{ id: string; webhookToken?: string }>)
      .find(a => a.id === 'rooted')?.webhookToken;
    assert(!!token, 'webhook token minted into the isolated registry');
    const status = await postText(port, token!, 'isolated event');
    assert(status === 202, 'webhook accepted');
    const eventsDir = path.join(root, 'agents', 'rooted', 'events');
    assert(fs.existsSync(eventsDir) && fs.readdirSync(eventsDir).some(f => f.endsWith('.json')),
      'event persisted under the isolated agent home');
  } finally {
    daemon.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
