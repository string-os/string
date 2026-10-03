/**
 * S7 — agent-box bridge launcher config. Proofs:
 *  - the production defaults are exactly the agreed deploy values (hub wss://hub.h1r.ai, bridgeId
 *    agentbox, loopback daemon on STRING_PORT, the agreed token-file + state-dir paths);
 *  - every value is env-overridable; the agents list tolerates spaces/empties; STRING_DAEMON_URL
 *    wins over STRING_PORT; machineId falls back to bridgeId;
 *  - the launcher refuses to start with no agents (before any network/daemon contact);
 *  - the launcher refuses to serve a Codex agent (they never read-ack), by default roster and when
 *    the deny-list is overridden — also before any IO.
 */
import path from 'path';
import os from 'os';
import { assert, section } from './runner.js';
import { DEFAULT_CODEX_AGENTS, resolveBridgeConfig, startAgentboxBridge } from '../messenger/hub/bridge-bin.js';

await section('bridge-bin: production defaults', async () => {
  const c = resolveBridgeConfig({});
  assert(c.hubUrl === 'wss://hub.h1r.ai', 'default hub URL');
  assert(c.bridgeId === 'agentbox', 'default bridgeId');
  assert(c.machineId === 'agentbox', 'default machineId mirrors bridgeId');
  assert(c.daemonBaseUrl === 'http://127.0.0.1:3923', 'default daemon is loopback stringd');
  assert(c.agents.length === 0, 'no agents by default (must be configured explicitly)');
  assert(c.heartbeatIntervalMs === 15_000, 'default heartbeat 15s');
  assert(c.tokenFile === path.join(os.homedir(), '.config', 'crew-messenger', 'agentbox.token'), 'default token file path');
  assert(c.stateDir === path.join(os.homedir(), '.local', 'state', 'crew-messenger-bridge'), 'default state dir');
});

await section('bridge-bin: env overrides + agents parsing', async () => {
  const c = resolveBridgeConfig({
    CREW_BRIDGE_HUB_URL: 'wss://staging.example/hub',
    CREW_BRIDGE_ID: 'box2',
    CREW_BRIDGE_TOKEN_FILE: '/etc/crew/box2.token',
    CREW_BRIDGE_AGENTS: 'nova, leo ,, milo ',
    CREW_BRIDGE_STATE_DIR: '/var/lib/crew-bridge',
    CREW_BRIDGE_HEARTBEAT_MS: '5000',
    STRING_PORT: '3999',
  });
  assert(c.hubUrl === 'wss://staging.example/hub', 'hub URL overridden');
  assert(c.bridgeId === 'box2' && c.machineId === 'box2', 'bridgeId override, machineId still mirrors it');
  assert(c.tokenFile === '/etc/crew/box2.token', 'token file overridden');
  assert(JSON.stringify(c.agents) === JSON.stringify(['nova', 'leo', 'milo']), 'agents trimmed, empties dropped');
  assert(c.stateDir === '/var/lib/crew-bridge', 'state dir overridden');
  assert(c.heartbeatIntervalMs === 5000, 'heartbeat overridden');
  assert(c.daemonBaseUrl === 'http://127.0.0.1:3999', 'daemon base follows STRING_PORT');
});

await section('bridge-bin: STRING_DAEMON_URL wins; explicit machineId stands', async () => {
  const c = resolveBridgeConfig({
    STRING_PORT: '3999',
    STRING_DAEMON_URL: 'http://127.0.0.1:3923',
    CREW_BRIDGE_ID: 'agentbox',
    CREW_BRIDGE_MACHINE_ID: 'the-linux-box',
  });
  assert(c.daemonBaseUrl === 'http://127.0.0.1:3923', 'explicit daemon URL overrides STRING_PORT');
  assert(c.machineId === 'the-linux-box', 'explicit machineId is kept');
});

await section('bridge-bin: refuses to start with no agents (before any IO)', async () => {
  const neverFetch = (async () => {
    throw new Error('fetch must not be called when there are no agents');
  }) as unknown as typeof fetch;
  let threw = false;
  try {
    await startAgentboxBridge(resolveBridgeConfig({}), neverFetch);
  } catch (err) {
    threw = /serves no agents/.test((err as Error).message);
  }
  assert(threw, 'an empty agents list is a hard refusal, not a silent no-op');
});

await section('bridge-bin: default deny-list is the known Codex roster', async () => {
  const c = resolveBridgeConfig({ CREW_BRIDGE_AGENTS: 'nova' });
  assert(JSON.stringify(c.denyAgents) === JSON.stringify(DEFAULT_CODEX_AGENTS), 'deny-list defaults to the Codex roster');
  const custom = resolveBridgeConfig({ CREW_BRIDGE_DENY_AGENTS: 'foo , bar ,' });
  assert(JSON.stringify(custom.denyAgents) === JSON.stringify(['foo', 'bar']), 'deny-list is overridable and trimmed');
});

await section('bridge-bin: refuses to serve a Codex agent (before any IO)', async () => {
  const neverFetch = (async () => {
    throw new Error('fetch must not be called when a denied agent is listed');
  }) as unknown as typeof fetch;
  let threw = false;
  try {
    // milo is a Codex session on the default deny roster.
    await startAgentboxBridge(resolveBridgeConfig({ CREW_BRIDGE_AGENTS: 'nova,milo' }), neverFetch);
  } catch (err) {
    threw = /Codex agent/.test((err as Error).message) && /milo/.test((err as Error).message);
  }
  assert(threw, 'a Codex agent in the serve list is a hard refusal naming the offender');
});
