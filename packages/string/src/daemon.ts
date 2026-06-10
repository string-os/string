/**
 * stringd — @string-os/string HTTP daemon
 *
 * Manages Browser sessions and exposes them over HTTP + SSE.
 *
 * Architecture: one Browser per agent, sessions identified by topic string.
 *   e.g. agent "neo" → Browser { sessions: "main", "work", "bash:dev" }
 *
 * Endpoints:
 *   POST   /agents             — register agent  { agent_id, home }
 *   GET    /agents             — list all agents
 *   DELETE /agents/:id         — remove agent + all their sessions
 *
 *   GET    /sessions          — list sessions (?agent_id= optional filter)
 *   POST   /sessions          — create session  { agent_id, topic }
 *   DELETE /sessions/:agent_id/:topic — destroy session
 *
 *   POST   /exec              — execute command (SSE response)
 *     headers: X-Agent-Id (required)
 *     body:    { cmd: string, topic?: string, request_id?: string }
 *
 *   GET    /health            — { ok, agents, sessions }
 *   POST   /shutdown          — graceful shutdown
 *
 * SSE response (POST /exec):
 *   event: head
 *   data: { ok, code, cmd, request_id, agent_id, topic, topic_type, meta }
 *
 *   event: content
 *   data: "re: [request_id] /cmd\n<rendered text>"
 *
 *   event: done
 *   data: {}
 */

import http from 'http';
import { mkdirSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Browser } from './index.js';
import { createHtmlToMarkdown } from './html-to-md.js';
import { createLogger, type Logger } from './logger.js';
import { parseTopic, topicToString } from './types.js';
import { AgentRegistry, type Agent } from './agent.js';
import { createStringServer, type McpExecFn } from './mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { EventStore, createWebhookToken, type AgentEvent } from './events.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CommandQueueItem {
  cmd: string;
  parsed: ReturnType<typeof parseTopic>;
  res: http.ServerResponse;
  resolve: () => void;
  aborted: boolean;
}

/** Per-topic execution state (concurrency control). */
interface TopicState {
  created: string;
  executing: boolean;
  queue: CommandQueueItem[];
}

/** One runtime per agent — shared Browser, per-topic state. */
interface RuntimeEntry {
  browser: Browser;
  agentId: string;
  created: string;
  topics: Map<string, TopicState>;
}

interface ExecHead {
  ok: boolean;
  code: string | null;
  cmd: string;
  request_id: string | null;
  agent_id: string;
  topic: string;
  topic_type: string;
  meta: SessionMeta | null;
}

interface SessionMeta {
  uri: string | null;
  title: string | null;
  menus: string[];
  actions: string[];
  history_length: number;
  block_id: string | null;
  converted: boolean;
  warnings: string[];
}

// ─── State ────────────────────────────────────────────────────────────────────

// Daemon data dir is per-OS-agent and cwd-independent: a daemon started from
// any directory must see the same agent registry. Override with STRING_DATA_DIR
// only for tests / isolated installs.
const STRING_DATA_DIR = process.env.STRING_DATA_DIR || join(homedir(), '.string', 'daemon');
const agents = new AgentRegistry([], join(STRING_DATA_DIR, 'agents.json'));
const runtimes = new Map<string, RuntimeEntry>();
const eventStreams = new Map<string, Set<http.ServerResponse>>();
let log: Logger;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// 10 MiB request body cap — prevents trivial OOM from an unbounded POST.
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const MAX_WEBHOOK_TEXT_BYTES = 64 * 1024;

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sseEvent(res: http.ServerResponse, event: string, data: unknown): void {
  // Writing to a socket that the peer reset between our writableEnded check and
  // here can throw synchronously. A failed push to one dead stream must never
  // break the webhook/heartbeat path, so swallow it — the stream's 'close'/
  // 'error' handler will unregister it.
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }
  } catch {
    /* dead stream — cleanup happens via close/error handlers */
  }
}

function notifyEventStreams(agentId: string, event: AgentEvent): void {
  const streams = eventStreams.get(agentId);
  if (!streams || streams.size === 0) return;
  for (const stream of [...streams]) {
    if (stream.writableEnded || stream.destroyed) {
      streams.delete(stream);
      continue;
    }
    sseEvent(stream, 'event', event);
  }
}

function buildMeta(browser: Browser, topic: string): SessionMeta | null {
  const sess = browser.session(topic);
  const doc = sess.currentDoc;
  if (!doc) return null;
  return {
    uri: doc.uri,
    title: (doc.frontmatter.title as string) ?? null,
    menus: [...doc.menus.keys()],
    actions: doc.actions.map(a => a.id),
    history_length: sess.historyLength,
    block_id: sess.currentBlockId ?? null,
    converted: !!doc.rawSource,
    warnings: doc.warnings,
  };
}

function buildSessionSummary(runtime: RuntimeEntry, topic: string, state: TopicState): object {
  return {
    agent_id: runtime.agentId,
    topic,
    created: state.created,
    ...buildMeta(runtime.browser, topic) ?? {
      uri: null, title: null, menus: [], actions: [],
      history_length: 0, block_id: null, converted: false, warnings: [],
    },
  };
}

function getOrCreateRuntime(agentId: string, home: string): RuntimeEntry {
  if (!runtimes.has(agentId)) {
    runtimes.set(agentId, {
      browser: new Browser({ home, agentId, htmlToMarkdown: createHtmlToMarkdown() }),
      agentId,
      created: new Date().toISOString(),
      topics: new Map(),
    });
  }
  return runtimes.get(agentId)!;
}

function getOrCreateTopic(runtime: RuntimeEntry, topic: string): TopicState {
  if (!runtime.topics.has(topic)) {
    runtime.topics.set(topic, {
      created: new Date().toISOString(),
      executing: false,
      queue: [],
    });
  }
  return runtime.topics.get(topic)!;
}

const MAX_QUEUE_SIZE = 5;
const QUEUE_WAIT_TIMEOUT_MS = 30_000; // max time a command waits in queue

/** Extract first line of command, truncated to 80 chars */
function truncateCmd(cmd: string): string {
  const firstLine = cmd.split('\n')[0];
  return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
}

// ─── Agent handlers ───────────────────────────────────────────────────────────

async function handleRegisterAgent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  let data: { agent_id?: string; home?: string; allowed_paths?: string[] } = {};
  try { data = JSON.parse(body); } catch { /* ignore */ }

  const agentId = data.agent_id?.trim();
  if (!agentId) {
    sendJson(res, 400, { error: 'agent_id required' });
    return;
  }

  const home = data.home?.trim();
  const allowedPaths = Array.isArray(data.allowed_paths)
    ? data.allowed_paths.map(p => String(p).trim()).filter(Boolean)
    : undefined;
  const existing = agents.get(agentId);

  // No explicit home → "ensure exists" without clobbering a stored home.
  // Existing agent is kept as-is (home untouched); a brand-new agent is
  // auto-provisioned via the shared ensureAgentAuto scheme. allowedPaths is
  // only applied when explicitly provided.
  if (!home) {
    const agent = existing ?? ensureAgentAuto(agentId);
    if (allowedPaths !== undefined) {
      agents.register({ ...agent, allowedPaths });
    }
    sendJson(res, 200, { agent_id: agentId, home: agent.home, created: !existing });
    return;
  }

  // Explicit home → register/update. Preserve existing allowedPaths unless
  // new ones are provided; preserve original createdAt on update.
  const resolvedPaths = allowedPaths ?? existing?.allowedPaths ?? [];
  agents.register({
    id: agentId,
    home,
    allowedPaths: resolvedPaths,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    webhookToken: existing?.webhookToken,
  });
  log.info(existing ? 'agent.update' : 'agent.register', { agentId, home });
  sendJson(res, 200, { agent_id: agentId, home, created: !existing });
}

function handleListAgents(_req: http.IncomingMessage, res: http.ServerResponse): void {
  sendJson(res, 200, {
    agents: agents.list().map(({ webhookToken: _webhookToken, ...agent }) => agent),
  });
}

function handleDeleteAgent(res: http.ServerResponse, agentId: string): void {
  const existed = agents.delete(agentId);
  runtimes.delete(agentId);
  log.info('agent.delete', { agentId, existed });
  sendJson(res, 200, { agent_id: agentId, deleted: existed });
}

function webhookUrl(req: http.IncomingMessage, token: string): string {
  const host = req.headers.host || '127.0.0.1:3923';
  return `http://${host}/webhook/${encodeURIComponent(token)}`;
}

function ensureAgentWebhook(agent: Agent): Agent {
  if (agent.webhookToken) return agent;
  const updated: Agent = { ...agent, webhookToken: createWebhookToken() };
  agents.register(updated);
  return updated;
}

function handleGetAgentWebhook(req: http.IncomingMessage, res: http.ServerResponse, agentId: string): void {
  const agent = agents.get(agentId);
  if (!agent) {
    sendJson(res, 404, { error: `Unknown agent: ${agentId}` });
    return;
  }
  const updated = ensureAgentWebhook(agent);
  sendJson(res, 200, {
    agent_id: agentId,
    webhook_url: webhookUrl(req, updated.webhookToken!),
  });
}

function handleRotateAgentWebhook(req: http.IncomingMessage, res: http.ServerResponse, agentId: string): void {
  const agent = agents.get(agentId);
  if (!agent) {
    sendJson(res, 404, { error: `Unknown agent: ${agentId}` });
    return;
  }
  const updated: Agent = { ...agent, webhookToken: createWebhookToken() };
  agents.register(updated);
  log.info('agent.webhook.rotate', { agentId });
  sendJson(res, 200, {
    agent_id: agentId,
    webhook_url: webhookUrl(req, updated.webhookToken!),
  });
}

async function handleWebhook(token: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const agent = agents.list().find(a => a.webhookToken === token);
  if (!agent) {
    sendJson(res, 401, { error: 'Unknown webhook token' });
    return;
  }

  const text = await readBody(req);
  const byteLength = Buffer.byteLength(text, 'utf-8');
  if (byteLength === 0) {
    sendJson(res, 400, { error: 'Webhook body must be non-empty text' });
    return;
  }
  if (byteLength > MAX_WEBHOOK_TEXT_BYTES) {
    sendJson(res, 413, { error: `Webhook body exceeds ${MAX_WEBHOOK_TEXT_BYTES} bytes` });
    return;
  }

  const event = await new EventStore(agent.home).append(agent.id, text, 'local-webhook');
  notifyEventStreams(agent.id, event);
  log.info('webhook.event', { agentId: agent.id, eventId: event.id, bytes: byteLength });
  sendJson(res, 202, {
    ok: true,
    agent_id: agent.id,
    event_id: event.id,
  });
}

function handleEventStream(req: http.IncomingMessage, res: http.ServerResponse): void {
  const agentId = (req.headers['x-agent-id'] as string | undefined)?.trim();
  if (!agentId) {
    sendJson(res, 400, { error: 'X-Agent-Id header required' });
    return;
  }
  if (!agents.has(agentId)) {
    sendJson(res, 401, { error: `Unknown agent: ${agentId}` });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof (res as any).flushHeaders === 'function') {
    (res as any).flushHeaders();
  }

  let streams = eventStreams.get(agentId);
  if (!streams) {
    streams = new Set();
    eventStreams.set(agentId, streams);
  }
  streams.add(res);
  log.info('events.stream.open', { agentId, count: streams.size });
  sseEvent(res, 'ready', { agent_id: agentId });

  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) sseEvent(res, 'ping', { t: new Date().toISOString() });
  }, 30_000);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    streams!.delete(res);
    if (streams!.size === 0) eventStreams.delete(agentId);
    log.info('events.stream.close', { agentId });
  };
  req.on('close', close);
  res.on('close', close);
  // An abrupt client disconnect (a Claude session or `--mcp` channel exiting,
  // a dropped connection) resets the socket. Without an 'error' listener that
  // surfaces as an uncaught ECONNRESET that crashes the daemon. Treat it as a
  // normal stream close.
  req.on('error', close);
  res.on('error', close);
}

/**
 * Get or auto-register an agent. Used by entry points (like /mcp) where the
 * client has no separate agent-provisioning step. The home is derived as
 * `~/.string/agents/{agentId}` — the same scheme the CLI uses — and created
 * on disk if it does not exist. Idempotent.
 *
 * Returns the Agent record; never null.
 */
function ensureAgentAuto(agentId: string): Agent {
  const existing = agents.get(agentId);
  if (existing) return existing;

  const home = join(homedir(), '.string', 'agents', agentId);
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  } catch (e) {
    // mkdir failures land here only on permissions/IO. Surface them as logs;
    // the subsequent registry write will fail too and the caller will 500.
    log.error('agent.auto_register.mkdir_failed', { agentId, home, error: String(e) });
  }
  agents.register({
    id: agentId,
    home,
    allowedPaths: [],
    createdAt: new Date().toISOString(),
  });
  log.info('agent.auto_register', { agentId, home });
  return agents.get(agentId)!;
}

// ─── Session handlers ────────────────────────────────────────────────────────

function handleListSessions(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const filterAgentId = url.searchParams.get('agent_id');

  const list: object[] = [];
  for (const [agentId, runtime] of runtimes) {
    if (filterAgentId && agentId !== filterAgentId) continue;
    for (const [topic, state] of runtime.topics) {
      list.push(buildSessionSummary(runtime, topic, state));
    }
  }
  sendJson(res, 200, { sessions: list });
}

async function handleCreateSession(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  let data: { agent_id?: string; topic?: string } = {};
  try { data = JSON.parse(body); } catch { /* ignore */ }

  const agentId = data.agent_id?.trim();
  if (!agentId) {
    sendJson(res, 400, { error: 'agent_id required' });
    return;
  }

  const agent = agents.get(agentId);
  if (!agent) {
    sendJson(res, 401, { error: `Unknown agent: ${agentId}` });
    return;
  }

  const rawTopic = data.topic?.trim() || '';
  const parsed = parseTopic(rawTopic);
  if (!parsed) {
    sendJson(res, 400, { error: `Invalid topic: ${rawTopic}` });
    return;
  }
  const topic = topicToString(parsed);
  const runtime = getOrCreateRuntime(agentId, agent.home);
  const existed = runtime.topics.has(topic);
  getOrCreateTopic(runtime, topic);
  runtime.browser.session(topic); // ensure Browser session exists
  if (!existed) log.info('session.create', { agentId, topic });
  sendJson(res, 200, { agent_id: agentId, topic, topic_type: parsed.type, created: !existed });
}

function handleDeleteSession(
  res: http.ServerResponse,
  agentId: string,
  topic: string,
): void {
  const runtime = runtimes.get(agentId);
  if (!runtime) {
    sendJson(res, 200, { agent_id: agentId, topic, deleted: false });
    return;
  }
  const existed = runtime.topics.delete(topic);
  if (existed) {
    runtime.browser.closeSession(topic);
    log.info('session.delete', { agentId, topic });
  }
  sendJson(res, 200, { agent_id: agentId, topic, deleted: existed });
}

// ─── Exec handler ────────────────────────────────────────────────────────────

async function handleExec(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const agentId = (req.headers['x-agent-id'] as string | undefined)?.trim();
  if (!agentId) {
    log.error('exec.validation', { reason: 'missing X-Agent-Id' });
    sendJson(res, 400, { error: 'X-Agent-Id header required' });
    return;
  }

  const agent = agents.get(agentId);
  if (!agent) {
    log.error('exec.validation', { reason: 'unknown agent', agentId });
    sendJson(res, 401, { error: `Unknown agent: ${agentId}` });
    return;
  }

  const body = await readBody(req);
  let data: { cmd?: string; topic?: string; request_id?: string } = {};
  try {
    data = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body — expected { "cmd": "..." }' });
    return;
  }

  const cmd = (data.cmd ?? '').trim();
  if (!cmd) {
    sendJson(res, 400, { error: 'Empty command — provide non-empty "cmd" field' });
    return;
  }

  const rawTopic = (data.topic ?? '').trim();
  const parsed = parseTopic(rawTopic);
  if (!parsed) {
    log.error('exec.validation', { reason: 'invalid topic', agentId, topic: rawTopic });
    sendJson(res, 400, { error: `Invalid topic: ${rawTopic}` });
    return;
  }
  const topic = topicToString(parsed);
  const requestId = (data.request_id ?? '').trim() || null;

  const runtime = getOrCreateRuntime(agentId, agent.home);
  const state = getOrCreateTopic(runtime, topic);
  const cmdLabel = truncateCmd(cmd);

  // Queue if topic is busy; reject if queue is full
  if (state.executing) {
    if (state.queue.length >= MAX_QUEUE_SIZE) {
      log.info('exec.queue_full', { agentId, topic, queueLength: state.queue.length });
      sendJson(res, 429, {
        error: 'QUEUE_FULL',
        message: `Topic ${agentId}:${topic} has ${MAX_QUEUE_SIZE} commands queued. Try again later.`,
      });
      return;
    }

    // Wait in queue until it's our turn, with timeout and disconnect handling
    const item: CommandQueueItem = { cmd, parsed: parsed!, res, resolve: () => {}, aborted: false };
    const aborted = await new Promise<boolean>(resolve => {
      item.resolve = () => resolve(false);

      // Client disconnected while waiting
      const onClose = () => {
        item.aborted = true;
        resolve(true);
      };
      res.on('close', onClose);

      // Queue wait timeout
      const timer = setTimeout(() => {
        item.aborted = true;
        resolve(true);
      }, QUEUE_WAIT_TIMEOUT_MS);

      // Clean up on resolve
      const origResolve = item.resolve;
      item.resolve = () => {
        clearTimeout(timer);
        res.removeListener('close', onClose);
        origResolve();
      };

      state.queue.push(item);
      log.info('exec.queued', { agentId, topic, cmd: cmdLabel, queueLength: state.queue.length });
    });

    if (aborted) {
      // Remove from queue if still there
      const idx = state.queue.indexOf(item);
      if (idx !== -1) state.queue.splice(idx, 1);
      log.info('exec.queue_timeout', { agentId, topic, cmd: cmdLabel });
      if (!res.headersSent && !res.writableEnded) {
        sendJson(res, 504, { error: 'QUEUE_TIMEOUT', message: 'Timed out waiting in queue.' });
      }
      return;
    }
  }

  // Skip if client already disconnected
  if (res.writableEnded) {
    drainQueue(state);
    return;
  }

  await executeCommand(runtime, state, cmd, cmdLabel, parsed!, agentId, topic, requestId, res);

  // Process next queued command if any
  drainQueue(state);
}

async function executeCommand(
  runtime: RuntimeEntry,
  state: TopicState,
  cmd: string,
  cmdLabel: string,
  parsed: NonNullable<ReturnType<typeof parseTopic>>,
  agentId: string,
  topic: string,
  requestId: string | null,
  res: http.ServerResponse,
): Promise<void> {
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof (res as any).flushHeaders === 'function') {
      (res as any).flushHeaders();
    }
  }

  const reqLabel = requestId ? `[${requestId}] ` : '';

  state.executing = true;
  const t0 = Date.now();
  try {
    const result = await runtime.browser.exec(cmd, topic, parsed.type);
    const durationMs = Date.now() - t0;
    const head: ExecHead = {
      ok: result.ok,
      code: result.code ?? null,
      cmd: cmdLabel,
      request_id: requestId,
      agent_id: agentId,
      topic,
      topic_type: parsed.type,
      meta: buildMeta(runtime.browser, topic),
    };
    sseEvent(res, 'head', head);

    log.info('exec', {
      agentId, topic, cmd: cmdLabel,
      ok: result.ok, code: result.code ?? '', durationMs,
    });

    let body: string;
    if (result.ok) {
      body = `re: ${reqLabel}${cmdLabel}\n${result.content}`;
    } else {
      body = `re: ${reqLabel}${cmdLabel}\nERROR(${result.code ?? 'UNKNOWN'}): ${result.content}`;
    }
    sseEvent(res, 'content', body);
  } catch (e) {
    const durationMs = Date.now() - t0;
    const head: ExecHead = {
      ok: false,
      code: 'INTERNAL_ERROR',
      cmd: cmdLabel,
      request_id: requestId,
      agent_id: agentId,
      topic,
      topic_type: parsed.type,
      meta: null,
    };
    sseEvent(res, 'head', head);
    sseEvent(res, 'content', `re: ${reqLabel}${cmdLabel}\nERROR(INTERNAL_ERROR): ${String(e)}`);
    log.error('exec', {
      agentId, topic, cmd: cmdLabel,
      message: String(e), stack: (e as Error).stack ?? '', durationMs,
    });
  } finally {
    state.executing = false;
  }

  sseEvent(res, 'done', {});
  res.end();
}

function drainQueue(state: TopicState): void {
  // Skip aborted items (client disconnected or timed out while waiting)
  while (state.queue.length > 0 && state.queue[0].aborted) {
    state.queue.shift();
  }
  const next = state.queue.shift();
  if (!next) return;
  next.resolve(); // unblock the waiting handleExec
}

// ─── MCP route ───────────────────────────────────────────────────────────────
//
// /mcp speaks the MCP protocol over StreamableHTTP transport. One tool —
// `string({ topic, cmd })` — wraps the same execution surface as /exec.
// Stateless mode: a fresh server+transport per request, no session IDs.
// X-Agent-Id picks the agent; unknown agents are auto-registered on first
// touch so MCP clients don't need a separate provisioning call.

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const agentId = (req.headers['x-agent-id'] as string | undefined)?.trim() || 'default';
  const agent = ensureAgentAuto(agentId);
  const runtime = getOrCreateRuntime(agentId, agent.home);

  const execFn: McpExecFn = async (rawTopic, cmd) => {
    const parsed = parseTopic(rawTopic);
    if (!parsed) {
      return { ok: false, code: 'INVALID_TARGET', content: `Invalid topic: ${rawTopic}` };
    }
    const topic = topicToString(parsed);
    const state = getOrCreateTopic(runtime, topic);

    // MVP serial guard. MCP clients are low-concurrency; reject overlapping
    // calls on the same topic with a clear code. Queue support can be added
    // later by mirroring /exec's queue mechanism.
    if (state.executing) {
      return {
        ok: false,
        code: 'BUSY',
        content: `Topic ${topic} is executing another command. Retry shortly.`,
        topic,
      };
    }

    state.executing = true;
    const t0 = Date.now();
    try {
      const result = await runtime.browser.exec(cmd, topic, parsed.type);
      const durationMs = Date.now() - t0;
      log.info('mcp.exec', {
        agentId, topic, cmd: truncateCmd(cmd),
        ok: result.ok, code: result.code ?? '', durationMs,
      });
      return {
        ok: result.ok,
        code: result.code ?? undefined,
        content: result.content,
        topic,
      };
    } catch (e) {
      log.error('mcp.exec.internal', { agentId, topic, error: String(e) });
      return {
        ok: false,
        code: 'INTERNAL_ERROR',
        content: String(e),
        topic,
      };
    } finally {
      state.executing = false;
    }
  };

  const server = createStringServer(execFn);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const parsedBody = body ? JSON.parse(body) : undefined;
    await transport.handleRequest(req, res, parsedBody);
  } catch (e) {
    log.error('mcp.transport', { agentId, error: String(e) });
    if (!res.headersSent) sendJson(res, 500, { error: String(e) });
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    const reqUserId = req.headers['x-agent-id'] as string | undefined;
    log.info('request', { method, path: pathname, agentId: reqUserId ?? '' });

    try {
      // ── Agent routes ──
      if (method === 'GET' && pathname === '/agents') {
        handleListAgents(req, res);
      } else if (method === 'POST' && pathname === '/agents') {
        await handleRegisterAgent(req, res);
      } else if ((method === 'GET' || method === 'POST') && pathname.startsWith('/agents/') && pathname.endsWith('/webhook')) {
        const id = decodeURIComponent(pathname.slice('/agents/'.length, -'/webhook'.length));
        if (method === 'GET') handleGetAgentWebhook(req, res, id);
        else handleRotateAgentWebhook(req, res, id);
      } else if (method === 'DELETE' && pathname.startsWith('/agents/')) {
        const id = decodeURIComponent(pathname.slice('/agents/'.length));
        handleDeleteAgent(res, id);

      // ── Local webhook ──
      } else if (method === 'POST' && pathname.startsWith('/webhook/')) {
        const token = decodeURIComponent(pathname.slice('/webhook/'.length));
        await handleWebhook(token, req, res);

      // ── Agent event stream ──
      } else if (method === 'GET' && pathname === '/events/stream') {
        handleEventStream(req, res);

      // ── Session routes ──
      } else if (method === 'GET' && pathname === '/sessions') {
        handleListSessions(req, res);
      } else if (method === 'POST' && pathname === '/sessions') {
        await handleCreateSession(req, res);
      } else if (method === 'DELETE' && pathname.startsWith('/sessions/')) {
        // /sessions/:agent_id/:topic
        const rest = decodeURIComponent(pathname.slice('/sessions/'.length));
        const slashIdx = rest.indexOf('/');
        if (slashIdx === -1) {
          sendJson(res, 400, { error: 'Expected /sessions/:agent_id/:topic' });
        } else {
          const agentId = rest.slice(0, slashIdx);
          const topic = rest.slice(slashIdx + 1);
          handleDeleteSession(res, agentId, topic);
        }

      // ── Exec ──
      } else if (method === 'POST' && pathname === '/exec') {
        await handleExec(req, res);

      // ── MCP ──
      // POST = JSON-RPC request, GET = SSE notification stream, DELETE = session teardown.
      // All three handled by the same StreamableHTTPServerTransport.
      } else if (pathname === '/mcp' && (method === 'POST' || method === 'GET' || method === 'DELETE')) {
        await handleMcp(req, res);

      // ── Lifecycle ──
      } else if (method === 'POST' && pathname === '/shutdown') {
        sendJson(res, 200, { ok: true, message: 'stringd shutting down' });
        setTimeout(() => process.exit(0), 50);
      } else if (method === 'GET' && pathname === '/health') {
        let totalTopics = 0;
        for (const r of runtimes.values()) totalTopics += r.topics.size;
        sendJson(res, 200, { ok: true, agents: agents.list().length, sessions: totalTopics });

      } else {
        sendJson(res, 404, { error: `Not found: ${method} ${pathname}` });
      }
    } catch (e) {
      log.error('internal', { message: String(e), stack: (e as Error).stack ?? '' });
      if (!res.headersSent) sendJson(res, 500, { error: String(e) });
    }
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startDaemon(port = 3923, opts?: { log?: boolean }): void {
  const logEnabled = opts?.log || process.env.STRING_LOG === '1';
  log = createLogger({
    enabled: logEnabled,
    dir: join(STRING_DATA_DIR, 'logs'),
  });

  // Disk-first recovery: ~/.string/agents/<id> is the source of truth for agent
  // homes. If the registry JSON gets lost/corrupted or the daemon migrates
  // STRING_DATA_DIR, re-register any home dirs we discover. Idempotent.
  const agentsRoot = join(homedir(), '.string', 'agents');
  try {
    for (const entry of readdirSync(agentsRoot)) {
      const home = join(agentsRoot, entry);
      try {
        if (!statSync(home).isDirectory()) continue;
      } catch {
        continue;
      }
      if (agents.has(entry)) continue;
      agents.register({
        id: entry,
        home,
        allowedPaths: [],
        createdAt: new Date().toISOString(),
      });
    }
  } catch {
    // agentsRoot doesn't exist yet — fresh install, fine.
  }

  const loadedUsers = agents.list().length;
  if (loadedUsers > 0) {
    console.log(`Loaded ${loadedUsers} agent(s) from ${STRING_DATA_DIR}/agents.json`);
  }

  const server = createServer();
  // Explicit loopback bind — never expose the daemon on external interfaces.
  // The protocol assumes local-only trust (no auth, no TLS); binding 0.0.0.0
  // would silently violate that. Remote/multi-host deployments require an
  // explicit `--bind` + auth layer, planned for a later milestone.
  server.listen(port, '127.0.0.1', () => {
    console.log(`stringd listening on http://127.0.0.1:${port}`);
    console.log('Endpoints: POST/GET/DELETE /agents  GET/POST /agents/:id/webhook  POST /webhook/:token  GET /events/stream  GET/POST/DELETE /sessions  POST /exec  /mcp');
    log.info('server.start', { port, dataDir: STRING_DATA_DIR, logEnabled });
  });

  const shutdown = (signal: string) => {
    log.info('server.stop', { signal });
    log.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
