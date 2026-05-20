/**
 * Integration tests for `string user` + the clobber fix, exercised end-to-end
 * through a real spawned daemon and the real CLI entrypoint.
 *
 * Each run gets an isolated STRINGD_DATA_DIR (users.json), STRINGD_CONFIG
 * (config.json), and a random STRINGD_PORT so it never collides with a running
 * daemon or touches the developer's real ~/.string.
 *
 * Verifies:
 *  - user add <id> --home X --allow a,b  → users.json has X + allowedPaths
 *  - user use <id>                       → config.currentUser = id
 *  - terse exec resolves the current user (no flags) and does NOT clobber home
 *  - --user default overrides the current user
 *  - user current / list reflect state
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'string-usercli-'));
  const dataDir = path.join(root, 'daemon');
  const configFile = path.join(root, 'config.json');
  // Random high port to avoid colliding with a real daemon on 3100.
  const port = 21000 + Math.floor(Math.random() * 9000);
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    STRINGD_DATA_DIR: dataDir,
    STRINGD_CONFIG: configFile,
    STRINGD_PORT: String(port),
    STRINGD_LOG: '0',
  };
  return { dataDir, configFile, port, base };
}

/** Run the CLI synchronously with the given args + isolated env. */
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

function readUsers(env: Env): Array<{ id: string; home: string; allowedPaths: string[] }> {
  const f = path.join(env.dataDir, 'users.json');
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, 'utf-8'));
}

function readConfig(env: Env): any {
  if (!fs.existsSync(env.configFile)) return {};
  return JSON.parse(fs.readFileSync(env.configFile, 'utf-8'));
}

await section('user CLI — add/use/current + clobber fix (e2e)', async () => {
  const env = makeEnv();
  const daemon = await startDaemon(env);
  const leoHome = path.join(env.dataDir, 'leohome');
  try {
    assert(await client.ping(env.port), 'daemon is up on isolated port');

    // user add leo --home X --allow a,b
    const add = runCli(env, ['user', 'add', 'leo', '--home', leoHome, '--allow', '/tmp/a,/tmp/b']);
    assert(add.code === 0, `user add exits 0 (stderr: ${add.stderr})`);
    let users = readUsers(env);
    const leo = users.find(u => u.id === 'leo');
    assert(!!leo, 'leo registered in users.json');
    assert(leo!.home === leoHome, 'leo home is the explicit path');
    assert(JSON.stringify(leo!.allowedPaths) === JSON.stringify(['/tmp/a', '/tmp/b']),
      'allowedPaths set via --allow');

    // user use leo → config.currentUser = leo
    const use = runCli(env, ['user', 'use', 'leo']);
    assert(use.code === 0, 'user use exits 0');
    assert(readConfig(env).currentUser === 'leo', 'config.currentUser = leo');

    // user current → leo + its home
    const current = runCli(env, ['user', 'current']);
    assert(current.stdout.includes('leo'), 'current prints leo');
    assert(current.stdout.includes(leoHome), 'current prints leo home');

    // A plain terse call resolves leo (no flags) and must NOT clobber the home.
    const terse = runCli(env, ['main', '/help']);
    assert(terse.code === 0 || terse.code === 1, 'terse call ran (exit 0/1)');
    users = readUsers(env);
    const leoAfter = users.find(u => u.id === 'leo');
    assert(leoAfter!.home === leoHome, 'terse call did NOT reset leo home');
    assert(JSON.stringify(leoAfter!.allowedPaths) === JSON.stringify(['/tmp/a', '/tmp/b']),
      'terse call preserved allowedPaths too');

    // --user default overrides the current user → registers/uses 'default'.
    const asDefault = runCli(env, ['--user', 'default', 'main', '/help']);
    assert(asDefault.code === 0 || asDefault.code === 1, '--user default call ran');
    users = readUsers(env);
    assert(users.some(u => u.id === 'default'), '--user default created/used default user');
    // leo's home is still intact after the default call.
    assert(readUsers(env).find(u => u.id === 'leo')!.home === leoHome,
      'leo home intact after --user default');

    // user list marks the current user.
    const list = runCli(env, ['user', 'list']);
    assert(/\*\s*leo/.test(list.stdout), 'list marks leo as current with *');
    assert(list.stdout.includes('default'), 'list includes default user');

    // set-home updates the home (and preserves allowedPaths — clobber fix P1).
    const newHome = path.join(env.dataDir, 'leohome2');
    const setHome = runCli(env, ['user', 'set-home', 'leo', newHome]);
    assert(setHome.code === 0, 'set-home exits 0');
    const leoMoved = readUsers(env).find(u => u.id === 'leo')!;
    assert(leoMoved.home === newHome, 'set-home updated home');
    assert(JSON.stringify(leoMoved.allowedPaths) === JSON.stringify(['/tmp/a', '/tmp/b']),
      'set-home (home-only update) preserved allowedPaths');

    // rm leo → removed + current cleared.
    const rm = runCli(env, ['user', 'rm', 'leo']);
    assert(rm.code === 0, 'user rm exits 0');
    assert(!readUsers(env).some(u => u.id === 'leo'), 'leo removed from users.json');
    assert(readConfig(env).currentUser === undefined, 'currentUser cleared after removing current');
  } finally {
    daemon.stop();
    fs.rmSync(path.dirname(env.dataDir), { recursive: true, force: true });
  }
});

await section('daemon — ensureUser home/allowedPaths contract (clobber fix)', async () => {
  const env = makeEnv();
  const daemon = await startDaemon(env);
  const home = path.join(env.dataDir, 'kavehome');
  try {
    // Explicit home + allowedPaths on create.
    await client.ensureUser(env.port, { id: 'kaveh', home, allowedPaths: ['/tmp/x'] });
    let kaveh = (await client.listUsers(env.port)).find(u => u.id === 'kaveh')!;
    assert(kaveh.home === home, 'create: explicit home stored');
    assert(JSON.stringify(kaveh.allowedPaths) === JSON.stringify(['/tmp/x']), 'create: allowedPaths stored');

    // ensureUser WITHOUT home must not overwrite the stored home or allowedPaths.
    await client.ensureUser(env.port, { id: 'kaveh' });
    kaveh = (await client.listUsers(env.port)).find(u => u.id === 'kaveh')!;
    assert(kaveh.home === home, 'no-home ensure: stored home preserved');
    assert(JSON.stringify(kaveh.allowedPaths) === JSON.stringify(['/tmp/x']),
      'no-home ensure: allowedPaths preserved');

    // Home-only update must preserve existing allowedPaths (don't reset to []).
    const home2 = path.join(env.dataDir, 'kavehome2');
    await client.ensureUser(env.port, { id: 'kaveh', home: home2 });
    kaveh = (await client.listUsers(env.port)).find(u => u.id === 'kaveh')!;
    assert(kaveh.home === home2, 'home-only update: home changed');
    assert(JSON.stringify(kaveh.allowedPaths) === JSON.stringify(['/tmp/x']),
      'home-only update: allowedPaths preserved (not reset to [])');

    // Explicit allowedPaths update replaces them.
    await client.ensureUser(env.port, { id: 'kaveh', allowedPaths: ['/tmp/y', '/tmp/z'] });
    kaveh = (await client.listUsers(env.port)).find(u => u.id === 'kaveh')!;
    assert(JSON.stringify(kaveh.allowedPaths) === JSON.stringify(['/tmp/y', '/tmp/z']),
      'explicit allowedPaths update applied');
    assert(kaveh.home === home2, 'allowedPaths-only update preserved home');

    // Brand-new user with no home gets an auto-derived home (ensureUserAuto).
    await client.ensureUser(env.port, { id: 'fresh' });
    const fresh = (await client.listUsers(env.port)).find(u => u.id === 'fresh')!;
    assert(!!fresh && fresh.home.includes(path.join('.string', 'users', 'fresh')),
      'new user without home → derived home');
  } finally {
    daemon.stop();
    fs.rmSync(path.dirname(env.dataDir), { recursive: true, force: true });
  }
});
