/**
 * stringd HTTP client — ping, ensureAgent, exec (SSE parsing)
 *
 * Uses only Node.js built-in `http` module. No external dependencies.
 */

import http from 'http';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExecResult {
  ok: boolean;
  code: string | null;
  content: string;
  meta: object | null;
}

export interface AgentInfo {
  id: string;
  home: string;
  allowedPaths: string[];
  createdAt: string;
}

export interface AgentWebhookInfo {
  agent_id: string;
  webhook_url: string;
}

export interface AgentEvent {
  id: string;
  agentId: string;
  receivedAt: string;
  source: 'local-webhook';
  text: string;
  status: 'pending' | 'delivered' | 'ack';
  deliveredAt?: string;
  ackedAt?: string;
}

export interface EventWatcher {
  close(): void;
}

// Process-local delivery cache. The daemon replays pending events until ack so a
// restarted MCP/channel process can wake on missed work; this cache prevents one
// still-running process from firing duplicate callbacks during reconnect churn.
const seenEventKeys = new Set<string>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function request(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      // agent: false disables keep-alive. Node 19+ pools sockets on the global
      // agent by default; a pooled idle socket the daemon later resets emits an
      // 'error' outside any request's req/res handlers, which is uncaught and
      // crashes the process. These are short local IPC calls, so a fresh socket
      // per request is cheap and removes that orphan-socket failure class.
      { hostname: '127.0.0.1', port, method, path, headers: { ...headers }, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body !== undefined) {
      req.setHeader('Content-Type', 'application/json');
      req.write(body);
    }
    req.end();
  });
}

// ─── SSE Parser ──────────────────────────────────────────────────────────────

/**
 * Strip the `re: [request_id] /cmd\n` or `re: /cmd\n` prefix from content.
 */
export function stripContentPrefix(raw: string): string {
  if (!raw.startsWith('re: ')) return raw;
  const nl = raw.indexOf('\n');
  if (nl === -1) return '';
  return raw.slice(nl + 1);
}

/**
 * Parse an SSE stream body into structured events.
 * SSE format: `event: <type>\ndata: <json>\n\n`
 */
export function parseSSE(raw: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
  let currentEvent = '';
  let currentData = '';

  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7);
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6);
    } else if (line === '') {
      if (currentEvent) {
        events.push({ event: currentEvent, data: currentData });
        currentEvent = '';
        currentData = '';
      }
    }
  }
  return events;
}

function parseSSEChunk(
  chunk: string,
  state: { event: string; data: string; buffer: string },
  emit: (event: string, data: string) => void,
): void {
  state.buffer += chunk;
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (trimmed.startsWith('event: ')) {
      state.event = trimmed.slice(7);
    } else if (trimmed.startsWith('data: ')) {
      state.data += state.data ? `\n${trimmed.slice(6)}` : trimmed.slice(6);
    } else if (trimmed === '') {
      if (state.event) emit(state.event, state.data);
      state.event = '';
      state.data = '';
    }
  }
}

/**
 * Parse a full SSE response body into an ExecResult.
 */
export function sseToExecResult(raw: string): ExecResult {
  const events = parseSSE(raw);

  let ok = false;
  let code: string | null = null;
  let content = '';
  let meta: object | null = null;

  for (const ev of events) {
    if (ev.event === 'head') {
      try {
        const head = JSON.parse(ev.data);
        ok = head.ok ?? false;
        code = head.code ?? null;
        meta = head.meta ?? null;
      } catch { /* ignore */ }
    } else if (ev.event === 'content') {
      try {
        const rawContent = JSON.parse(ev.data) as string;
        content = stripContentPrefix(rawContent);
      } catch { /* ignore */ }
    }
    // 'done' event is ignored — it's just a signal
  }

  return { ok, code, content, meta };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** GET /health — daemon liveness check. */
export async function ping(port: number): Promise<boolean> {
  try {
    const res = await request(port, 'GET', '/health');
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * POST /agents — register or update an agent. Idempotent.
 *
 * `home` is OPTIONAL: when omitted, the daemon ensures the agent exists without
 * overwriting an existing agent's stored home (a brand-new agent gets a derived
 * home). Only an explicit `home` writes/updates the home. `allowedPaths`, when
 * provided, is set on the agent; otherwise existing allowedPaths are preserved.
 */
export async function ensureAgent(
  port: number,
  agent: { id: string; home?: string; allowedPaths?: string[] },
): Promise<void> {
  const payload: { agent_id: string; home?: string; allowed_paths?: string[] } = {
    agent_id: agent.id,
  };
  if (agent.home !== undefined) payload.home = agent.home;
  if (agent.allowedPaths !== undefined) payload.allowed_paths = agent.allowedPaths;

  const res = await request(port, 'POST', '/agents', JSON.stringify(payload));
  if (res.status !== 200) {
    throw new Error(`ensureAgent failed (${res.status}): ${res.body}`);
  }
}

/** GET /agents — list all registered agents. */
export async function listAgents(port: number): Promise<AgentInfo[]> {
  const res = await request(port, 'GET', '/agents');
  if (res.status !== 200) {
    throw new Error(`listAgents failed (${res.status}): ${res.body}`);
  }
  const data = JSON.parse(res.body) as { agents: AgentInfo[] };
  return data.agents ?? [];
}

/** DELETE /agents/:id — remove an agent. Returns whether the agent existed. */
export async function deleteAgent(port: number, id: string): Promise<boolean> {
  const res = await request(port, 'DELETE', `/agents/${encodeURIComponent(id)}`);
  if (res.status !== 200) {
    throw new Error(`deleteAgent failed (${res.status}): ${res.body}`);
  }
  const data = JSON.parse(res.body) as { deleted?: boolean };
  return data.deleted ?? false;
}

/** GET /agents/:id/webhook — show or create an agent's local webhook URL. */
export async function getAgentWebhook(port: number, id: string): Promise<AgentWebhookInfo> {
  const res = await request(port, 'GET', `/agents/${encodeURIComponent(id)}/webhook`);
  if (res.status !== 200) {
    throw new Error(`getAgentWebhook failed (${res.status}): ${res.body}`);
  }
  return JSON.parse(res.body) as AgentWebhookInfo;
}

/** POST /agents/:id/webhook — rotate an agent's local webhook token. */
export async function rotateAgentWebhook(port: number, id: string): Promise<AgentWebhookInfo> {
  const res = await request(port, 'POST', `/agents/${encodeURIComponent(id)}/webhook`, '');
  if (res.status !== 200) {
    throw new Error(`rotateAgentWebhook failed (${res.status}): ${res.body}`);
  }
  return JSON.parse(res.body) as AgentWebhookInfo;
}

/** GET /events/stream — subscribe to live agent-local events. */
export interface WatchOptions {
  /** First reconnect delay after a drop (ms). Doubles per consecutive failure. */
  minReconnectMs?: number;
  /** Reconnect delay ceiling (ms). */
  maxReconnectMs?: number;
  /** Reconnect if no data (event or heartbeat) arrives within this window (ms).
   *  The daemon sends a `ping` every 30s, so this catches silently-dead sockets. */
  idleTimeoutMs?: number;
  /** After `onEvent` settles (its return value, or the promise it returns,
   *  resolves), POST /events/{id}/ack to close the lifecycle loop. This makes
   *  `delivered` a transient waypoint rather than a terminal resting state, so
   *  retention can engage. Ack fires ONLY on a successful settle — if `onEvent`
   *  throws or its promise rejects, the event stays unacked and is replayed on the
   *  next connect (at-least-once preserved). Ack failures are surfaced via
   *  `onError` and are non-fatal (the grace window + next backfill still cover it).
   *  The ack point should therefore be a *provable handoff* (e.g. the channel
   *  notification resolved), never a bare receipt — acking into invisibility would
   *  re-create the missed-event failure this is meant to prevent. */
  autoAck?: boolean;
}

/**
 * Subscribe to an agent's event stream, **self-healing across drops**.
 *
 * The daemon's SSE stream dies whenever the daemon restarts (e.g. every release)
 * or the socket is reset. This watcher reconnects on its own with exponential
 * backoff — not a tight loop — and uses the daemon's 30s heartbeat to detect a
 * half-open connection that never fired an error. Backoff resets once data flows
 * again. `close()` stops reconnecting for good.
 *
 * The daemon replays pending events on connect until they are acked. This watcher
 * suppresses duplicate callbacks within the current process; a restarted process
 * intentionally receives pending events again so unacked work can wake it.
 */
export function watchAgentEvents(
  port: number,
  agentId: string,
  onEvent: (event: AgentEvent) => void | Promise<void>,
  onError?: (error: Error) => void,
  options: WatchOptions = {},
): EventWatcher {
  const minReconnectMs = options.minReconnectMs ?? 2_000;
  const maxReconnectMs = options.maxReconnectMs ?? 30_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 75_000; // > 2 missed 30s heartbeats
  const autoAck = options.autoAck ?? false;

  let closed = false;
  let backoff = minReconnectMs;
  let current: http.ClientRequest | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const state = { event: '', data: '', buffer: '' };

  const clearIdle = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };

  // No event or heartbeat within the idle window → the socket is dead but never
  // told us. Destroy it; the 'error'/'close' path then schedules a reconnect.
  const bumpIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => { current?.destroy(); }, idleTimeoutMs);
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    clearIdle();
    const delay = backoff;
    backoff = Math.min(backoff * 2, maxReconnectMs); // grows only while failing
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  };

  const connect = () => {
    if (closed) return;
    state.event = ''; state.data = ''; state.buffer = '';

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'GET',
        path: '/events/stream',
        headers: { 'X-Agent-Id': agentId },
      },
      (res) => {
        if ((res.statusCode ?? 0) !== 200) {
          const chunks: Buffer[] = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            if (!closed) {
              const body = Buffer.concat(chunks).toString('utf-8');
              onError?.(new Error(`event stream failed (${res.statusCode ?? 0}): ${body}`));
            }
            scheduleReconnect();
          });
          res.on('error', () => scheduleReconnect());
          return;
        }

        bumpIdle();
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          backoff = minReconnectMs; // data flowing → connection is healthy
          bumpIdle();
          parseSSEChunk(chunk, state, (eventName, data) => {
            if (eventName !== 'event') return; // 'ready' / 'ping' are control frames
            try {
              const parsed = JSON.parse(data) as AgentEvent;
              const key = `${port}:${agentId}:${parsed.id}`;
              if (seenEventKeys.has(key)) return;
              seenEventKeys.add(key);
              // `onEvent` may be sync (void) or async; normalize to a promise so
              // auto-ack fires only once it settles successfully. A throw/reject
              // leaves the event unacked → replayed next connect (at-least-once).
              const settled = Promise.resolve(onEvent(parsed));
              if (autoAck) {
                settled
                  .then(() => ackEvent(port, agentId, parsed.id))
                  .catch(e => onError?.(e instanceof Error ? e : new Error(String(e))));
              } else {
                settled.catch(e => onError?.(e instanceof Error ? e : new Error(String(e))));
              }
            } catch (e) {
              onError?.(e instanceof Error ? e : new Error(String(e)));
            }
          });
        });
        res.on('end', () => { if (!closed) scheduleReconnect(); });
        res.on('error', e => { if (!closed) { onError?.(e); scheduleReconnect(); } });
      },
    );

    req.on('error', e => { if (!closed) { onError?.(e); scheduleReconnect(); } });
    req.end();
    current = req;
  };

  connect();

  return {
    close() {
      closed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      clearIdle();
      current?.destroy();
    },
  };
}

/**
 * POST /events/{id}/ack — mark an event handled (delivered/pending → ack).
 *
 * Closes the consumer side of the event lifecycle. `delivered` is a transport fact
 * the daemon sets when it flushes an event to a stream; `ack` is the consumer's
 * confirmation that it *handled* the event, and only acked events become
 * retention-purgeable and stop being replayed on the next stream connect.
 *
 * Idempotent on the daemon (re-acking is a 200 no-op), so a consumer can safely
 * retry a dropped ack. Returns `true` when the event was found and is now acked,
 * `false` on 404 (unknown or already-purged event) — a 404 is not thrown because a
 * retry racing retention is a benign outcome, not a client error.
 */
export async function ackEvent(port: number, agentId: string, eventId: string): Promise<boolean> {
  const res = await request(
    port,
    'POST',
    `/events/${encodeURIComponent(eventId)}/ack`,
    '',
    { 'X-Agent-Id': agentId },
  );
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`ackEvent failed (${res.status}): ${res.body}`);
}

/** Backlog snapshot from GET /events/count. */
export interface EventCount {
  /** Never flushed to any stream — genuinely missed work. */
  pending: number;
  /** Flushed to ≥1 stream but not yet acked. */
  delivered: number;
  /** Open work total (pending + delivered) — mirrors the default list view. */
  unacked: number;
  /** `receivedAt` of the oldest unacked event — the "<ts>" in "N unread since
   *  <ts>" — or null when the inbox is clear. */
  oldestUnackedAt: string | null;
}

/**
 * GET /events/count — an agent's backlog snapshot without draining the stream.
 *
 * The proactive visibility primitive: a session (or the `--mcp` consumer at
 * channel init) reads this to surface "N unread since <ts>" instead of relying on
 * a stream backfill landing in an attended context — the direct guard against a
 * backlog hiding unseen.
 */
export async function eventCount(port: number, agentId: string): Promise<EventCount> {
  const res = await request(port, 'GET', '/events/count', undefined, { 'X-Agent-Id': agentId });
  if (res.status !== 200) {
    throw new Error(`eventCount failed (${res.status}): ${res.body}`);
  }
  const d = JSON.parse(res.body) as {
    pending: number; delivered: number; unacked: number; oldest_unacked_at: string | null;
  };
  return {
    pending: d.pending,
    delivered: d.delivered,
    unacked: d.unacked,
    oldestUnackedAt: d.oldest_unacked_at,
  };
}

/** POST /exec — execute a command, parse SSE response into ExecResult. */
export async function exec(
  port: number,
  agentId: string,
  topic: string,
  cmd: string,
): Promise<ExecResult> {
  const res = await request(
    port,
    'POST',
    '/exec',
    JSON.stringify({ cmd, topic }),
    { 'X-Agent-Id': agentId },
  );

  // Non-SSE error (400, 401, 429, etc.)
  if (res.status !== 200) {
    let message = res.body;
    try {
      const json = JSON.parse(res.body);
      message = json.error ?? json.message ?? res.body;
    } catch { /* use raw body */ }
    return { ok: false, code: 'HTTP_ERROR', content: message, meta: null };
  }

  return sseToExecResult(res.body);
}

/** POST /shutdown — graceful daemon shutdown. */
export async function shutdown(port: number): Promise<void> {
  await request(port, 'POST', '/shutdown');
}

/** GET /health — daemon health with agent/session counts. */
export async function health(port: number): Promise<{ ok: boolean; version?: string; agents: number; sessions: number }> {
  const res = await request(port, 'GET', '/health');
  if (res.status !== 200) {
    throw new Error(`health check failed (${res.status}): ${res.body}`);
  }
  return JSON.parse(res.body);
}

/** GET /describe — daemon self-description (version + capability handshake). */
export interface DaemonDescription {
  name: string;
  version: string;
  /** API surface version, e.g. "string-daemon/v2". */
  api: string;
  /** Self-declared identity — clients refuse production daemons by role, not
   *  port. "unknown" = unlabeled instance; treat as refuse-by-default. */
  instance: { instance_label: string; role: 'production' | 'dev' | 'test' | 'unknown' };
  /** Feature id → operational limits. Presence of a key = feature supported. */
  capabilities: Record<string, Record<string, number | string | boolean>>;
}

/**
 * Describe a daemon. Returns null when the daemon predates the /describe
 * endpoint (pre-v2 surfaces answer 404 here while /health still works) —
 * callers treat null as "unknown surface, probe before use".
 */
export async function describe(port: number): Promise<DaemonDescription | null> {
  const res = await request(port, 'GET', '/describe');
  if (res.status === 404) return null;
  if (res.status !== 200) {
    throw new Error(`describe failed (${res.status}): ${res.body}`);
  }
  return JSON.parse(res.body) as DaemonDescription;
}

// ─── System plane: fs verbs ──────────────────────────────────────────────────
//
// PUT/GET/DELETE/STAT /fs/{workspace-path}, authenticated by a capability
// secret (Authorization: Bearer). STAT maps to HTTP HEAD; stat data rides in
// Content-Length / Last-Modified headers. These helpers never throw on
// application-level refusals — the status (and reason, when the daemon sends
// one) is the result, so callers/tests can assert on 401/403/404/409/413.

function fsUrlPath(fsPath: string): string {
  return '/fs/' + fsPath.split('/').map(encodeURIComponent).join('/');
}

function fsRequest(
  port: number,
  method: string,
  fsPath: string,
  cap: string,
  body?: Buffer,
): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path: fsUrlPath(fsPath),
        agent: false, // see request(): fresh socket per call, no pooled-socket resets
        headers: {
          Authorization: `Bearer ${cap}`,
          ...(body !== undefined
            ? { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function fsReason(body: Buffer): string | undefined {
  try { return (JSON.parse(body.toString('utf-8')) as { reason?: string }).reason; } catch { return undefined; }
}

/** PUT /fs/{path} — write bytes. 201 created / 200 overwritten. */
export async function fsPut(
  port: number,
  fsPath: string,
  data: Buffer | string,
  cap: string,
): Promise<{ status: number; ok: boolean; created?: boolean; reason?: string }> {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  const res = await fsRequest(port, 'PUT', fsPath, cap, buf);
  return { status: res.status, ok: res.status === 200 || res.status === 201, created: res.status === 201, reason: fsReason(res.body) };
}

/** GET /fs/{path} — read bytes. `data` is set only on 200. */
export async function fsGet(
  port: number,
  fsPath: string,
  cap: string,
): Promise<{ status: number; ok: boolean; data?: Buffer; reason?: string }> {
  const res = await fsRequest(port, 'GET', fsPath, cap);
  if (res.status === 200) return { status: 200, ok: true, data: res.body };
  return { status: res.status, ok: false, reason: fsReason(res.body) };
}

/** STAT (HTTP HEAD) /fs/{path} — size/mtime from headers; 404 = not a file. */
export async function fsStat(
  port: number,
  fsPath: string,
  cap: string,
): Promise<{ status: number; exists: boolean; size?: number; mtime?: string }> {
  const res = await fsRequest(port, 'HEAD', fsPath, cap);
  if (res.status !== 200) return { status: res.status, exists: false };
  return {
    status: 200,
    exists: true,
    size: Number(res.headers['content-length']),
    mtime: res.headers['last-modified'],
  };
}

/** DELETE /fs/{path} — idempotent; `existed` says whether bytes were removed. */
export async function fsDelete(
  port: number,
  fsPath: string,
  cap: string,
): Promise<{ status: number; ok: boolean; existed?: boolean; reason?: string }> {
  const res = await fsRequest(port, 'DELETE', fsPath, cap);
  if (res.status !== 200) return { status: res.status, ok: false, reason: fsReason(res.body) };
  const parsed = JSON.parse(res.body.toString('utf-8')) as { existed?: boolean };
  return { status: 200, ok: true, existed: parsed.existed };
}

// ─── Capability issuance ─────────────────────────────────────────────────────

export type CapabilityVerb = 'PUT' | 'GET' | 'DELETE' | 'STAT';

/** Returned by mint — the only place the secret ever appears. */
export interface MintedCapability {
  token_id: string;
  secret: string;
  agent_id: string;
  path_prefix: string;
  verbs: CapabilityVerb[];
  expires_at: string;
  single_use: boolean;
}

/** Public capability record — no secret. */
export interface CapabilityInfo {
  token_id: string;
  agent_id: string;
  path_prefix: string;
  verbs: CapabilityVerb[];
  expires_at: string;
  single_use: boolean;
  created_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

/** POST /capabilities — mint a scoped fs capability into an agent's workspace. */
export async function mintCapability(
  port: number,
  spec: {
    agentId: string;
    pathPrefix: string;
    verbs: CapabilityVerb[];
    ttlMs: number;
    singleUse?: boolean;
  },
): Promise<MintedCapability> {
  const res = await request(port, 'POST', '/capabilities', JSON.stringify({
    agent_id: spec.agentId,
    path_prefix: spec.pathPrefix,
    verbs: spec.verbs,
    ttl_ms: spec.ttlMs,
    single_use: spec.singleUse ?? false,
  }));
  if (res.status !== 201) {
    throw new Error(`mintCapability failed (${res.status}): ${res.body}`);
  }
  return JSON.parse(res.body) as MintedCapability;
}

/** GET /capabilities[?agent_id=] — list public capability records. */
export async function listCapabilities(port: number, agentId?: string): Promise<CapabilityInfo[]> {
  const query = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : '';
  const res = await request(port, 'GET', `/capabilities${query}`);
  if (res.status !== 200) {
    throw new Error(`listCapabilities failed (${res.status}): ${res.body}`);
  }
  return (JSON.parse(res.body) as { capabilities: CapabilityInfo[] }).capabilities ?? [];
}

/** DELETE /capabilities/:tokenId — revoke by public token id. */
export async function revokeCapability(port: number, tokenId: string): Promise<boolean> {
  const res = await request(port, 'DELETE', `/capabilities/${encodeURIComponent(tokenId)}`);
  if (res.status !== 200) {
    throw new Error(`revokeCapability failed (${res.status}): ${res.body}`);
  }
  return (JSON.parse(res.body) as { revoked?: boolean }).revoked ?? false;
}

/**
 * POST /agents with the one-call provisioning extras — pairing in a single
 * request: ensure the agent exists, get its webhook URL, and mint an initial
 * scoped capability. Built for disposable test agents:
 * provision → use → deleteAgent() (which revokes everything with it).
 */
export interface ProvisionedAgent {
  agent_id: string;
  home: string;
  created: boolean;
  webhook_url?: string;
  capability?: Omit<MintedCapability, 'agent_id'>;
}

export async function provisionAgent(
  port: number,
  spec: {
    id: string;
    home?: string;
    allowedPaths?: string[];
    webhook?: boolean;
    capability?: { pathPrefix: string; verbs: CapabilityVerb[]; ttlMs: number; singleUse?: boolean };
  },
): Promise<ProvisionedAgent> {
  const payload: Record<string, unknown> = { agent_id: spec.id };
  if (spec.home !== undefined) payload.home = spec.home;
  if (spec.allowedPaths !== undefined) payload.allowed_paths = spec.allowedPaths;
  if (spec.webhook !== undefined) payload.webhook = spec.webhook;
  if (spec.capability !== undefined) {
    payload.capability = {
      path_prefix: spec.capability.pathPrefix,
      verbs: spec.capability.verbs,
      ttl_ms: spec.capability.ttlMs,
      single_use: spec.capability.singleUse ?? false,
    };
  }
  const res = await request(port, 'POST', '/agents', JSON.stringify(payload));
  if (res.status !== 200) {
    throw new Error(`provisionAgent failed (${res.status}): ${res.body}`);
  }
  return JSON.parse(res.body) as ProvisionedAgent;
}
