import { readFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { Bridge } from './bridge.js';
import { connectWebSocket } from './link-websocket.js';
import { CcChannelAdapter } from '../cc/adapter.js';
import { EventStoreInbox } from '../cc/event-store-inbox.js';

/**
 * Launcher for the AGENT-BOX String bridge: one persistent client WebSocket that dials OUT to the
 * cross-machine hub (no inbound port), serving the agents on this box through their String event
 * inboxes (see {@link EventStoreInbox} — it reuses the daemon's existing webhook/event path).
 *
 * Everything is config; the token is read from a 0600 file at start and never logged. The bin
 * resolves each agent's home and webhook URL from the LOCAL stringd over HTTP (`GET /agents`,
 * `POST /agents/<id>/webhook`) — it invents no agent state of its own. It does NOT run on import:
 * {@link startAgentboxBridge} connects only when the bin is executed as the entry point.
 */
export interface BridgeBinConfig {
  hubUrl: string;
  bridgeId: string;
  machineId: string;
  tokenFile: string;
  /** Base URL of the local stringd used to resolve agent home + webhook URL. */
  daemonBaseUrl: string;
  /** The agents this bridge serves — exactly the names the hub token authorizes. */
  agents: string[];
  /**
   * Agents this bridge must REFUSE to serve: Codex (node) sessions never read-ack String events,
   * so the cc-channel inbox would never see a delivered and every message to them would queue
   * forever. The daemon's agent registry exposes no runtime `kind`, so this can't be detected from
   * the live state — it is a configured stop-list (default: the known Codex roster), and a start
   * that lists any of them fails loudly rather than silently black-holing their mail.
   */
  denyAgents: string[];
  /** Directory for the per-agent dedup maps (0700, bridge-owned, outside any agent home). */
  stateDir: string;
  heartbeatIntervalMs: number;
}

/** Known Codex (node) sessions — they do not read-ack String events, so the cc bridge can't serve them. */
export const DEFAULT_CODEX_AGENTS = ['atlas', 'milo', 'pike'];

/** Resolve config from the environment with the production defaults. Pure (no IO) and testable. */
export function resolveBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeBinConfig {
  const bridgeId = env.CREW_BRIDGE_ID?.trim() || 'agentbox';
  const stringPort = env.STRING_PORT?.trim() || '3923';
  return {
    hubUrl: env.CREW_BRIDGE_HUB_URL?.trim() || 'wss://hub.h1r.ai',
    bridgeId,
    machineId: env.CREW_BRIDGE_MACHINE_ID?.trim() || bridgeId,
    tokenFile:
      env.CREW_BRIDGE_TOKEN_FILE?.trim() ||
      path.join(os.homedir(), '.config', 'crew-messenger', 'agentbox.token'),
    daemonBaseUrl: env.STRING_DAEMON_URL?.trim() || `http://127.0.0.1:${stringPort}`,
    agents: (env.CREW_BRIDGE_AGENTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    denyAgents: (env.CREW_BRIDGE_DENY_AGENTS ?? DEFAULT_CODEX_AGENTS.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    stateDir:
      env.CREW_BRIDGE_STATE_DIR?.trim() ||
      path.join(os.homedir(), '.local', 'state', 'crew-messenger-bridge'),
    heartbeatIntervalMs: Number(env.CREW_BRIDGE_HEARTBEAT_MS) || 15_000,
  };
}

async function readToken(file: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    throw new Error(`cannot read bridge token file ${file}: ${(err as Error).message}`);
  }
  const token = raw.trim();
  if (!token) throw new Error(`bridge token file is empty: ${file}`);
  return token;
}

/** `GET /agents` → id -> home for exactly the agents we serve (fail if any is not registered). */
async function resolveHomes(
  baseUrl: string,
  want: string[],
  fetchImpl: typeof fetch,
): Promise<Map<string, string>> {
  const res = await fetchImpl(`${baseUrl}/agents`);
  if (!res.ok) throw new Error(`GET ${baseUrl}/agents returned ${res.status}`);
  const json = (await res.json()) as { agents?: Array<{ id: string; home: string }> };
  const homes = new Map<string, string>();
  for (const a of json.agents ?? []) {
    if (want.includes(a.id)) homes.set(a.id, a.home);
  }
  const missing = want.filter((id) => !homes.has(id));
  if (missing.length) throw new Error(`agents not registered on the daemon: ${missing.join(', ')}`);
  return homes;
}

/** `POST /agents/<id>/webhook` → the agent's webhook URL (idempotent; mints a token if absent). */
async function resolveWebhookUrl(
  baseUrl: string,
  agentId: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const res = await fetchImpl(`${baseUrl}/agents/${encodeURIComponent(agentId)}/webhook`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`POST ${baseUrl}/agents/${agentId}/webhook returned ${res.status}`);
  const json = (await res.json()) as { webhook_url?: string };
  if (!json.webhook_url) throw new Error(`no webhook_url for agent ${agentId}`);
  return json.webhook_url;
}

/**
 * Build the configured bridge and connect it. Resolves once the hello handshake completes.
 * Running this is the ONLY thing that touches the live daemon / hub, so it happens solely when the
 * bin is executed — not on import.
 */
export async function startAgentboxBridge(
  cfg: BridgeBinConfig = resolveBridgeConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<Bridge> {
  if (cfg.agents.length === 0) {
    throw new Error('CREW_BRIDGE_AGENTS is empty; refusing to start a bridge that serves no agents');
  }
  const denied = cfg.agents.filter((id) => cfg.denyAgents.includes(id));
  if (denied.length) {
    throw new Error(
      `refusing to serve Codex agent(s) over the cc-channel bridge: ${denied.join(', ')} — ` +
        'they do not read-ack String events, so their mail would queue forever. ' +
        'Remove them from CREW_BRIDGE_AGENTS (or override CREW_BRIDGE_DENY_AGENTS if the roster changed).',
    );
  }
  const token = await readToken(cfg.tokenFile);
  const homes = await resolveHomes(cfg.daemonBaseUrl, cfg.agents, fetchImpl);

  const bridge = new Bridge({
    bridgeId: cfg.bridgeId,
    machineId: cfg.machineId,
    token,
    connect: () => connectWebSocket(cfg.hubUrl),
    heartbeatIntervalMs: cfg.heartbeatIntervalMs,
    onError: (reason) => console.error(`[bridge ${cfg.bridgeId}] ${reason}`),
  });

  for (const agentId of cfg.agents) {
    const webhookUrl = await resolveWebhookUrl(cfg.daemonBaseUrl, agentId, fetchImpl);
    const inbox = new EventStoreInbox({
      agentId,
      home: homes.get(agentId)!,
      webhookUrl,
      mapPath: path.join(cfg.stateDir, `${agentId}.map.json`),
      fetchImpl,
    });
    const adapter = new CcChannelAdapter({ inbox, onAck: (ack) => bridge.reportAck(ack) });
    await adapter.start();
    bridge.register(agentId, adapter);
  }

  await bridge.start();
  console.log(
    `[bridge ${cfg.bridgeId}] connected to ${cfg.hubUrl}; serving ${cfg.agents.length} agent(s): ${cfg.agents.join(', ')}`,
  );
  return bridge;
}

// Entry point: start only when executed directly, never on import.
if (import.meta.url === `file://${process.argv[1]}`) {
  startAgentboxBridge().catch((err) => {
    console.error('[bridge] failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
