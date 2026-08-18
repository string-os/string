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
import { STRING_VERSION } from '../version.js';
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
  // Hermetic env: the host session may export STRING_* vars (e.g. a String
  // plugin sets STRING_AGENT_ID), which would redirect CLI agent resolution
  // away from the agents these tests create. Strip them all, then set ours.
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (key.startsWith('STRING_')) delete inherited[key];
  }
  const base: NodeJS.ProcessEnv = {
    ...inherited,
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

    // `agent current` must report the RESOLVED agent (honoring STRING_AGENT_ID /
    // --agent), NOT the raw global config.currentAgent. Regression: it used to
    // print the config value, masking an agent mix-up (config=leo above).
    const currentAsMaya = runCli(env, ['agent', 'current'], { STRING_AGENT_ID: 'maya' });
    assert(/\nmaya\t/.test(currentAsMaya.stdout),
      'agent current honors STRING_AGENT_ID (reports maya, not config leo)');
    assert(!/\nleo\t/.test(currentAsMaya.stdout),
      'agent current does not misreport config leo under STRING_AGENT_ID');
    assert(currentAsMaya.stdout.includes(mayaHome), 'agent current shows the resolved agent home');
    const currentAsFlag = runCli(env, ['--agent', 'maya', 'agent', 'current']);
    assert(/\nmaya\t/.test(currentAsFlag.stdout),
      'agent current honors the --agent flag');
    assert(readConfig(env).currentAgent === 'leo',
      'agent current is read-through — does not mutate config');

    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'string-agent-local-'));
    const localConfig = path.join(localRoot, '.string', 'config.json');
    const localUse = runCli(env, ['agent', 'use', 'maya', '--local'], { STRING_PROJECT_DIR: localRoot });
    assert(localUse.code === 0, 'agent use --local exits 0');
    assert(localUse.stdout.includes('Warning: STRING_CONFIG is set'), 'agent use --local warns when STRING_CONFIG overrides resolution');
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

await section('CLI grammar — unknown flags do not fall through to topics', async () => {
  const env = makeEnv();
  const r = runCli(env, ['--deamon', 'status']);
  assert(r.code !== 0, 'unknown flag exits non-zero');
  assert(r.stderr.includes("unknown flag '--deamon'"), 'unknown flag error shown');
  assert(r.stderr.includes('Did you mean --daemon?'), 'daemon typo suggestion shown');
  assert(!r.stdout.includes('COMMAND_UNSUPPORTED'), 'not routed through String command dispatcher');
});

await section('CLI grammar — management hubs cover agent/event/system', async () => {
  const env = makeEnv();
  const daemon = await startDaemon(env);
  const leoHome = path.join(env.dataDir, 'leo-hub-home');
  const leoHome2 = path.join(env.dataDir, 'leo-hub-home-2');
  try {
    const add = runCli(env, ['agent', 'add', 'leo', '--home', leoHome, '--allow', '/tmp/a,/tmp/b']);
    assert(add.code === 0, `agent hub add exits 0 (stderr: ${add.stderr})`);
    assert(add.stdout.includes("Added agent 'leo'"), 'agent hub add output');
    let leo = readAgents(env).find(u => u.id === 'leo');
    assert(leo?.home === leoHome, 'agent hub add stores home');
    assert(JSON.stringify(leo?.allowedPaths) === JSON.stringify(['/tmp/a', '/tmp/b']),
      'agent hub add stores allowedPaths');

    const use = runCli(env, ['agent', 'use', 'leo']);
    assert(use.code === 0, 'agent hub use exits 0');
    assert(readConfig(env).currentAgent === 'leo', 'agent hub use updates currentAgent');

    const agentHub = runCli(env, ['agent']);
    assert(agentHub.code === 0, 'bare agent hub opens');
    assert(agentHub.stdout.includes('# agent hub'), 'bare agent hub renders hub page');

    const current = runCli(env, ['agent', 'current']);
    assert(current.code === 0, 'agent hub current exits 0');
    assert(current.stdout.includes('leo'), 'agent hub current prints leo');
    assert(current.stdout.includes(leoHome), 'agent hub current prints home');

    const list = runCli(env, ['agent', 'list']);
    assert(list.code === 0, 'agent hub list exits 0');
    assert(/\*\s*leo/.test(list.stdout), 'agent hub list marks current agent');

    const setHome = runCli(env, ['agent', 'set-home', 'leo', leoHome2]);
    assert(setHome.code === 0, 'agent hub set-home exits 0');
    leo = readAgents(env).find(u => u.id === 'leo');
    assert(leo?.home === leoHome2, 'agent hub set-home updates home');
    assert(JSON.stringify(leo?.allowedPaths) === JSON.stringify(['/tmp/a', '/tmp/b']),
      'agent hub set-home preserves allowedPaths');

    const webhook = runCli(env, ['event', 'webhook', 'show']);
    assert(webhook.code === 0, `event hub webhook show exits 0 (stderr: ${webhook.stderr})`);
    assert(webhook.stdout.includes("Local webhook for agent 'leo'"), 'event hub webhook uses current agent');
    assert(webhook.stdout.includes('/webhook/wh_'), 'event hub webhook prints URL');

    const eventHub = runCli(env, ['event']);
    assert(eventHub.code === 0, 'bare event hub opens');
    assert(eventHub.stdout.includes('string event read <id>'), 'event hub shows CLI event commands');

    const status = runCli(env, ['system', 'status']);
    assert(status.code === 0, 'system hub status exits 0');
    assert(status.stdout.includes(`stringd running on port ${env.port}`), 'system hub status prints daemon port');

    const rm = runCli(env, ['agent', 'rm', 'leo']);
    assert(rm.code === 0, 'agent hub rm exits 0');
    assert(!readAgents(env).some(u => u.id === 'leo'), 'agent hub rm removes agent');
    assert(readConfig(env).currentAgent === undefined, 'agent hub rm clears current agent');
  } finally {
    daemon.stop();
    fs.rmSync(path.dirname(env.dataDir), { recursive: true, force: true });
  }
});

await section('CLI grammar — management help separates CLI and slash forms', async () => {
  const env = makeEnv();

  const agentCliHelp = runCli(env, ['agent', '--help']);
  assert(agentCliHelp.code === 0, 'agent --help exits 0');
  assert(agentCliHelp.stdout.includes('string agent list'), 'agent --help shows CLI form');

    const eventCliHelp = runCli(env, ['event', 'help']);
    assert(eventCliHelp.code === 0, 'event help exits 0');
    assert(eventCliHelp.stdout.includes('string event webhook show'), 'event help shows CLI form');
    assert(eventCliHelp.stdout.includes('string event read <id>'), 'event help shows CLI read alias');

  const daemon = await startDaemon(env);
  try {
    const agentSlashHelp = runCli(env, ['agent', '/help']);
    assert(agentSlashHelp.code === 0, 'agent /help exits 0');
    assert(agentSlashHelp.stdout.includes('/list'), 'agent /help shows slash form');

    const eventSlashHelp = runCli(env, ['event', '/help']);
    assert(eventSlashHelp.code === 0, 'event /help exits 0');
    assert(eventSlashHelp.stdout.includes('/webhook show'), 'event /help shows slash form');

    const systemSlashHelp = runCli(env, ['system', '/help']);
    assert(systemSlashHelp.code === 0, 'system /help exits 0');
    assert(systemSlashHelp.stdout.includes('/status'), 'system /help shows slash form');
  } finally {
    daemon.stop();
    fs.rmSync(path.dirname(env.dataDir), { recursive: true, force: true });
  }
});

await section('CLI grammar — removed top-level webhook command is explicit', async () => {
  const env = makeEnv();
  const r = runCli(env, ['webhook', 'show']);
  assert(r.code !== 0, 'top-level webhook exits non-zero');
  assert(r.stderr.includes('string event webhook show'), 'top-level webhook suggests event hub command');
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

await section('daemon — agent home changes apply without daemon restart', async () => {
  const env = makeEnv();
  const daemon = await startDaemon(env);
  const home1 = path.join(env.dataDir, 'runtime-home-1');
  const home2 = path.join(env.dataDir, 'runtime-home-2');
  fs.mkdirSync(home1, { recursive: true });
  fs.mkdirSync(home2, { recursive: true });
  fs.writeFileSync(path.join(home1, 'marker.md'), '# Old Home\n\nold-home-marker\n');
  fs.writeFileSync(path.join(home2, 'marker.md'), '# New Home\n\nnew-home-marker\n');

  try {
    await client.ensureAgent(env.port, { id: 'runtime', home: home1 });

    const oldResult = await client.exec(env.port, 'runtime', 'main', '/open ./marker.md');
    assert(oldResult.ok, 'opens marker in initial home');
    assert(oldResult.content.includes('old-home-marker'), 'initial runtime uses old home');

    await client.ensureAgent(env.port, { id: 'runtime', home: home2 });

    const newResult = await client.exec(env.port, 'runtime', 'main', '/open ./marker.md');
    assert(newResult.ok, 'opens marker after home update');
    assert(newResult.content.includes('new-home-marker'), 'runtime uses updated home without daemon restart');
    assert(!newResult.content.includes('old-home-marker'), 'updated runtime no longer reads old home');
  } finally {
    daemon.stop();
    fs.rmSync(path.dirname(env.dataDir), { recursive: true, force: true });
  }
});

await section('CLI — --version names the running build (no daemon needed)', async () => {
  // Every box reports the same version string while running a different build; the
  // value of --version is that it names WHICH build (path + build time), so two
  // boxes can be compared instead of argued about. Here we assert the stable
  // contract: version line + a build: line, and -v as an alias. Exits before the
  // daemon is touched.
  const env = makeEnv();
  try {
    const r = runCli(env, ['--version']);
    assert(r.code === 0, `--version exits 0 (stderr: ${r.stderr})`);
    assert(r.stdout.startsWith(`string ${STRING_VERSION}`), `first line names the version: ${JSON.stringify(r.stdout.slice(0, 48))}`);
    assert(r.stdout.includes('build:'), 'names the running build (path + build time)');
    assert(runCli(env, ['-v']).stdout.startsWith(`string ${STRING_VERSION}`), '-v is an alias for --version');
  } finally {
    fs.rmSync(path.dirname(env.dataDir), { recursive: true, force: true });
  }
});
