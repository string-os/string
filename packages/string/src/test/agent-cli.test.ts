/**
 * Integration tests for `string agent` + the clobber fix, exercised end-to-end
 * through a real spawned daemon and the real CLI entrypoint.
 *
 * Each run gets an isolated STRING_DATA_DIR (agents.json), STRING_CONFIG
 * (config.json), and a random STRING_PORT so it never collides with a running
 * daemon or touches the developer's real ~/.string.
 *
 * Verifies:
 *  - agent add <id> --home X --allow a,b  → agents.json has X + allowedPaths
 *  - agent use <id>                       → config.currentAgent = id
 *  - terse exec resolves the current agent (no flags) and does NOT clobber home
 *  - STRING_AGENT_ID and --agent override the current agent
 *  - agent use <id> --local writes workspace-local config
 *  - agent current / list reflect state
 *  - set-home updates home; rm removes + clears current
 *  - allowedPaths preserved across a home-only update (clobber fix, P1)
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import * as client from '@string-os/client';
import { assert, section } from './runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../cli.ts');

interface Env {
  dataDir: string;
  configFile: string;
  port: number;
  base: NodeJS.ProcessEnv;
}

function makeEnv(): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'string-agentcli-'));
  const dataDir = path.join(root, 'daemon');
  const configFile = path.join(root, 'config.json');
  // Random high port to avoid colliding with a real daemon on 3923.
  const port = 21000 + Math.floor(Math.random() * 9000);
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    STRING_DATA_DIR: dataDir,
    STRING_CONFIG: configFile,
    STRING_PORT: String(port),
    STRING_LOG: '0',
  };
  return { dataDir, configFile, port, base };
}

/** Run the CLI synchronously with the given args + isolated env. */
function runCli(
  env: Env,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('npx', ['tsx', CLI, ...args], {
    env: { ...env.base, ...extraEnv },
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

function readAgents(env: Env): Array<{ id: string; home: string; allowedPaths: string[] }> {
  const f = path.join(env.dataDir, 'agents.json');
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, 'utf-8'));
}

function readConfig(env: Env): any {
  if (!fs.existsSync(env.configFile)) return {};
  return JSON.parse(fs.readFileSync(env.configFile, 'utf-8'));
}

await section('agent CLI — add/use/current + clobber fix (e2e)', async () => {
  const env = makeEnv();
  const daemon = await startDaemon(env);
  const leoHome = path.join(env.dataDir, 'leohome');
  try {
    assert(await client.ping(env.port), 'daemon is up on isolated port');

    // agent add leo --home X --allow a,b
    const add = runCli(env, ['agent', 'add', 'leo', '--home', leoHome, '--allow', '/tmp/a,/tmp/b']);
    assert(add.code === 0, `agent add exits 0 (stderr: ${add.stderr})`);
    let agents = readAgents(env);
    const leo = agents.find(u => u.id === 'leo');
    assert(!!leo, 'leo registered in agents.json');
    assert(leo!.home === leoHome, 'leo home is the explicit path');
    assert(JSON.stringify(leo!.allowedPaths) === JSON.stringify(['/tmp/a', '/tmp/b']),
      'allowedPaths set via --allow');

    // agent use leo → config.currentAgent = leo
    const use = runCli(env, ['agent', 'use', 'leo']);
    assert(use.code === 0, 'agent use exits 0');
    assert(readConfig(env).currentAgent === 'leo', 'config.currentAgent = leo');

    // agent current → leo + its home
    const current = runCli(env, ['agent', 'current']);
    assert(current.stdout.includes('leo'), 'current prints leo');
    assert(current.stdout.includes(leoHome), 'current prints leo home');

    // A plain terse call resolves leo (no flags) and must NOT clobber the home.
    const terse = runCli(env, ['main', '/help']);
    assert(terse.code === 0 || terse.code === 1, 'terse call ran (exit 0/1)');
    agents = readAgents(env);
    const leoAfter = agents.find(u => u.id === 'leo');
    assert(leoAfter!.home === leoHome, 'terse call did NOT reset leo home');
    assert(JSON.stringify(leoAfter!.allowedPaths) === JSON.stringify(['/tmp/a', '/tmp/b']),
      'terse call preserved allowedPaths too');

    // --agent default overrides the current agent → registers/uses 'default'.
    const asDefault = runCli(env, ['--agent', 'default', 'main', '/help']);
    assert(asDefault.code === 0 || asDefault.code === 1, '--agent default call ran');
    agents = readAgents(env);
    assert(agents.some(u => u.id === 'default'), '--agent default created/used default agent');
    // leo's home is still intact after the default call.
    assert(readAgents(env).find(u => u.id === 'leo')!.home === leoHome,
      'leo home intact after --agent default');

    // STRING_AGENT_ID selects a different registered agent for the whole process.
    const mayaHome = path.join(env.dataDir, 'mayahome');
    const addMaya = runCli(env, ['agent', 'add', 'maya', '--home', mayaHome]);
    assert(addMaya.code === 0, 'agent add maya exits 0');
    const asMaya = runCli(env, ['main', '/help'], { STRING_AGENT_ID: 'maya' });
    assert(asMaya.code === 0 || asMaya.code === 1, 'STRING_AGENT_ID maya call ran');
    agents = readAgents(env);
    assert(agents.find(u => u.id === 'maya')!.home === mayaHome,
      'STRING_AGENT_ID uses maya without clobbering its home');
    assert(readConfig(env).currentAgent === 'leo',
      'STRING_AGENT_ID call does not change config.currentAgent');

    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'string-agent-local-'));
    const localConfig = path.join(localRoot, '.string', 'config.json');
    const localUse = runCli(env, ['agent', 'use', 'maya', '--local'], { STRING_PROJECT_DIR: localRoot });
    assert(localUse.code === 0, 'agent use --local exits 0');
    assert(JSON.parse(fs.readFileSync(localConfig, 'utf-8')).currentAgent === 'maya',
      'agent use --local writes workspace-local config');
    assert(readConfig(env).currentAgent === 'leo',
      'agent use --local does not change global currentAgent');
    fs.rmSync(localRoot, { recursive: true, force: true });

    // agent list marks the current agent.
    const list = runCli(env, ['agent', 'list']);
    assert(/\*\s*leo/.test(list.stdout), 'list marks leo as current with *');
    assert(list.stdout.includes('default'), 'list includes default agent');

    // set-home updates the home (and preserves allowedPaths — clobber fix P1).
    const newHome = path.join(env.dataDir, 'leohome2');
    const setHome = runCli(env, ['agent', 'set-home', 'leo', newHome]);
    assert(setHome.code === 0, 'set-home exits 0');
    const leoMoved = readAgents(env).find(u => u.id === 'leo')!;
    assert(leoMoved.home === newHome, 'set-home updated home');
    assert(JSON.stringify(leoMoved.allowedPaths) === JSON.stringify(['/tmp/a', '/tmp/b']),
      'set-home (home-only update) preserved allowedPaths');

    // rm leo → removed + current cleared.
    const rm = runCli(env, ['agent', 'rm', 'leo']);
    assert(rm.code === 0, 'agent rm exits 0');
    assert(!readAgents(env).some(u => u.id === 'leo'), 'leo removed from agents.json');
    assert(readConfig(env).currentAgent === undefined, 'currentAgent cleared after removing current');
  } finally {
    daemon.stop();
    fs.rmSync(path.dirname(env.dataDir), { recursive: true, force: true });
  }
});

await section('daemon — ensureAgent home/allowedPaths contract (clobber fix)', async () => {
  const env = makeEnv();
  const daemon = await startDaemon(env);
  const home = path.join(env.dataDir, 'kavehome');
  try {
    // Explicit home + allowedPaths on create.
    await client.ensureAgent(env.port, { id: 'kaveh', home, allowedPaths: ['/tmp/x'] });
    let kaveh = (await client.listAgents(env.port)).find(u => u.id === 'kaveh')!;
    assert(kaveh.home === home, 'create: explicit home stored');
    assert(JSON.stringify(kaveh.allowedPaths) === JSON.stringify(['/tmp/x']), 'create: allowedPaths stored');

    // ensureAgent WITHOUT home must not overwrite the stored home or allowedPaths.
    await client.ensureAgent(env.port, { id: 'kaveh' });
    kaveh = (await client.listAgents(env.port)).find(u => u.id === 'kaveh')!;
    assert(kaveh.home === home, 'no-home ensure: stored home preserved');
    assert(JSON.stringify(kaveh.allowedPaths) === JSON.stringify(['/tmp/x']),
      'no-home ensure: allowedPaths preserved');

    // Home-only update must preserve existing allowedPaths (don't reset to []).
    const home2 = path.join(env.dataDir, 'kavehome2');
    await client.ensureAgent(env.port, { id: 'kaveh', home: home2 });
    kaveh = (await client.listAgents(env.port)).find(u => u.id === 'kaveh')!;
    assert(kaveh.home === home2, 'home-only update: home changed');
    assert(JSON.stringify(kaveh.allowedPaths) === JSON.stringify(['/tmp/x']),
      'home-only update: allowedPaths preserved (not reset to [])');

    // Explicit allowedPaths update replaces them.
    await client.ensureAgent(env.port, { id: 'kaveh', allowedPaths: ['/tmp/y', '/tmp/z'] });
    kaveh = (await client.listAgents(env.port)).find(u => u.id === 'kaveh')!;
    assert(JSON.stringify(kaveh.allowedPaths) === JSON.stringify(['/tmp/y', '/tmp/z']),
      'explicit allowedPaths update applied');
    assert(kaveh.home === home2, 'allowedPaths-only update preserved home');

    // Brand-new agent with no home gets an auto-derived home (ensureAgentAuto).
    await client.ensureAgent(env.port, { id: 'fresh' });
    const fresh = (await client.listAgents(env.port)).find(u => u.id === 'fresh')!;
    assert(!!fresh && fresh.home.includes(path.join('.string', 'agents', 'fresh')),
      'new agent without home → derived home');
  } finally {
    daemon.stop();
    fs.rmSync(path.dirname(env.dataDir), { recursive: true, force: true });
  }
});
