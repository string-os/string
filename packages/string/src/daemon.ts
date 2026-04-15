/**
 * stringd — @string-os/string HTTP daemon
 *
 * Manages Browser sessions and exposes them over HTTP + SSE.
 *
 * Architecture: one Browser per user, sessions identified by topic string.
 *   e.g. user "neo" → Browser { sessions: "file:main", "file:work", "bash:dev" }
 *
 * Endpoints:
 *   POST   /users             — register user  { user_id, home }
 *   GET    /users             — list all users
 *   DELETE /users/:id         — remove user + all their sessions
 *
 *   GET    /sessions          — list sessions (?user_id= optional filter)
 *   POST   /sessions          — create session  { user_id, topic }
 *   DELETE /sessions/:user_id/:topic — destroy session
 *
 *   POST   /exec              — execute command (SSE response)
 *     headers: X-User-Id (required)
 *     body:    { cmd: string, topic?: string, request_id?: string }
 *
 *   GET    /health            — { ok, users, sessions }
 *   POST   /shutdown          — graceful shutdown
 *
 * SSE response (POST /exec):
 *   event: head
 *   data: { ok, code, cmd, request_id, user_id, topic, topic_type, meta }
 *
 *   event: content
 *   data: "re: [request_id] /cmd\n<rendered text>"
 *
 *   event: done
 *   data: {}
 */

import http from 'http';
import { join } from 'path';
import { Browser } from './index.js';
import { createHtmlToMarkdown } from './html-to-md.js';
import { createLogger, type Logger } from './logger.js';
import { parseTopic, topicToString } from './types.js';
import { UserRegistry } from './user.js';

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

/** One runtime per user — shared Browser, per-topic state. */
interface RuntimeEntry {
  browser: Browser;
  userId: string;
  created: string;
  topics: Map<string, TopicState>;
}

interface ExecHead {
  ok: boolean;
  code: string | null;
  cmd: string;
  request_id: string | null;
  user_id: string;
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
}

// ─── State ────────────────────────────────────────────────────────────────────

const STRINGD_DATA_DIR = process.env.STRINGD_DATA_DIR || join(process.cwd(), '.stringd');
const users = new UserRegistry([], join(STRINGD_DATA_DIR, 'users.json'));
const runtimes = new Map<string, RuntimeEntry>();
let log: Logger;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// 10 MiB request body cap — prevents trivial OOM from an unbounded POST.
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

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
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (typeof (res as any).flush === 'function') {
    (res as any).flush();
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
  };
}

function buildSessionSummary(runtime: RuntimeEntry, topic: string, state: TopicState): object {
  return {
    user_id: runtime.userId,
    topic,
    created: state.created,
    ...buildMeta(runtime.browser, topic) ?? {
      uri: null, title: null, menus: [], actions: [],
      history_length: 0, block_id: null,
    },
  };
}

function getOrCreateRuntime(userId: string, home: string): RuntimeEntry {
  if (!runtimes.has(userId)) {
    runtimes.set(userId, {
      browser: new Browser({ home, userId, htmlToMarkdown: createHtmlToMarkdown() }),
      userId,
      created: new Date().toISOString(),
      topics: new Map(),
    });
  }
  return runtimes.get(userId)!;
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

// ─── User handlers ───────────────────────────────────────────────────────────

async function handleRegisterUser(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  let data: { user_id?: string; home?: string } = {};
  try { data = JSON.parse(body); } catch { /* ignore */ }

  const userId = data.user_id?.trim();
  if (!userId) {
    sendJson(res, 400, { error: 'user_id required' });
    return;
  }
  const home = data.home?.trim();
  if (!home) {
    sendJson(res, 400, { error: 'home required' });
    return;
  }

  const existed = users.has(userId);
  users.register({
    id: userId,
    home,
    allowedPaths: [],
    createdAt: existed ? users.get(userId)!.createdAt : new Date().toISOString(),
  });
  log.info(existed ? 'user.update' : 'user.register', { userId, home });
  sendJson(res, 200, { user_id: userId, home, created: !existed });
}

function handleListUsers(_req: http.IncomingMessage, res: http.ServerResponse): void {
  sendJson(res, 200, { users: users.list() });
}

function handleDeleteUser(res: http.ServerResponse, userId: string): void {
  const existed = users.delete(userId);
  runtimes.delete(userId);
  log.info('user.delete', { userId, existed });
  sendJson(res, 200, { user_id: userId, deleted: existed });
}

// ─── Session handlers ────────────────────────────────────────────────────────

function handleListSessions(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const filterUserId = url.searchParams.get('user_id');

  const list: object[] = [];
  for (const [userId, runtime] of runtimes) {
    if (filterUserId && userId !== filterUserId) continue;
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
  let data: { user_id?: string; topic?: string } = {};
  try { data = JSON.parse(body); } catch { /* ignore */ }

  const userId = data.user_id?.trim();
  if (!userId) {
    sendJson(res, 400, { error: 'user_id required' });
    return;
  }

  const user = users.get(userId);
  if (!user) {
    sendJson(res, 401, { error: `Unknown user: ${userId}` });
    return;
  }

  const rawTopic = data.topic?.trim() || '';
  const parsed = parseTopic(rawTopic);
  if (!parsed) {
    sendJson(res, 400, { error: `Invalid topic: ${rawTopic}` });
    return;
  }
  const topic = topicToString(parsed);
  const runtime = getOrCreateRuntime(userId, user.home);
  const existed = runtime.topics.has(topic);
  getOrCreateTopic(runtime, topic);
  runtime.browser.session(topic); // ensure Browser session exists
  if (!existed) log.info('session.create', { userId, topic });
  sendJson(res, 200, { user_id: userId, topic, topic_type: parsed.type, created: !existed });
}

function handleDeleteSession(
  res: http.ServerResponse,
  userId: string,
  topic: string,
): void {
  const runtime = runtimes.get(userId);
  if (!runtime) {
    sendJson(res, 200, { user_id: userId, topic, deleted: false });
    return;
  }
  const existed = runtime.topics.delete(topic);
  if (existed) {
    runtime.browser.closeSession(topic);
    log.info('session.delete', { userId, topic });
  }
  sendJson(res, 200, { user_id: userId, topic, deleted: existed });
}

// ─── Exec handler ────────────────────────────────────────────────────────────

async function handleExec(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) {
    log.error('exec.validation', { reason: 'missing X-User-Id' });
    sendJson(res, 400, { error: 'X-User-Id header required' });
    return;
  }

  const user = users.get(userId);
  if (!user) {
    log.error('exec.validation', { reason: 'unknown user', userId });
    sendJson(res, 401, { error: `Unknown user: ${userId}` });
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
    log.error('exec.validation', { reason: 'invalid topic', userId, topic: rawTopic });
    sendJson(res, 400, { error: `Invalid topic: ${rawTopic}` });
    return;
  }
  const topic = topicToString(parsed);
  const requestId = (data.request_id ?? '').trim() || null;

  const runtime = getOrCreateRuntime(userId, user.home);
  const state = getOrCreateTopic(runtime, topic);
  const cmdLabel = truncateCmd(cmd);

  // Queue if topic is busy; reject if queue is full
  if (state.executing) {
    if (state.queue.length >= MAX_QUEUE_SIZE) {
      log.info('exec.queue_full', { userId, topic, queueLength: state.queue.length });
      sendJson(res, 429, {
        error: 'QUEUE_FULL',
        message: `Topic ${userId}:${topic} has ${MAX_QUEUE_SIZE} commands queued. Try again later.`,
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
      log.info('exec.queued', { userId, topic, cmd: cmdLabel, queueLength: state.queue.length });
    });

    if (aborted) {
      // Remove from queue if still there
      const idx = state.queue.indexOf(item);
      if (idx !== -1) state.queue.splice(idx, 1);
      log.info('exec.queue_timeout', { userId, topic, cmd: cmdLabel });
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

  await executeCommand(runtime, state, cmd, cmdLabel, parsed!, userId, topic, requestId, res);

  // Process next queued command if any
  drainQueue(state);
}

async function executeCommand(
  runtime: RuntimeEntry,
  state: TopicState,
  cmd: string,
  cmdLabel: string,
  parsed: NonNullable<ReturnType<typeof parseTopic>>,
  userId: string,
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
      user_id: userId,
      topic,
      topic_type: parsed.type,
      meta: buildMeta(runtime.browser, topic),
    };
    sseEvent(res, 'head', head);

    log.info('exec', {
      userId, topic, cmd: cmdLabel,
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
      user_id: userId,
      topic,
      topic_type: parsed.type,
      meta: null,
    };
    sseEvent(res, 'head', head);
    sseEvent(res, 'content', `re: ${reqLabel}${cmdLabel}\nERROR(INTERNAL_ERROR): ${String(e)}`);
    log.error('exec', {
      userId, topic, cmd: cmdLabel,
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

// ─── Router ───────────────────────────────────────────────────────────────────

function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    const reqUserId = req.headers['x-user-id'] as string | undefined;
    log.info('request', { method, path: pathname, userId: reqUserId ?? '' });

    try {
      // ── User routes ──
      if (method === 'GET' && pathname === '/users') {
        handleListUsers(req, res);
      } else if (method === 'POST' && pathname === '/users') {
        await handleRegisterUser(req, res);
      } else if (method === 'DELETE' && pathname.startsWith('/users/')) {
        const id = decodeURIComponent(pathname.slice('/users/'.length));
        handleDeleteUser(res, id);

      // ── Session routes ──
      } else if (method === 'GET' && pathname === '/sessions') {
        handleListSessions(req, res);
      } else if (method === 'POST' && pathname === '/sessions') {
        await handleCreateSession(req, res);
      } else if (method === 'DELETE' && pathname.startsWith('/sessions/')) {
        // /sessions/:user_id/:topic
        const rest = decodeURIComponent(pathname.slice('/sessions/'.length));
        const slashIdx = rest.indexOf('/');
        if (slashIdx === -1) {
          sendJson(res, 400, { error: 'Expected /sessions/:user_id/:topic' });
        } else {
          const userId = rest.slice(0, slashIdx);
          const topic = rest.slice(slashIdx + 1);
          handleDeleteSession(res, userId, topic);
        }

      // ── Exec ──
      } else if (method === 'POST' && pathname === '/exec') {
        await handleExec(req, res);

      // ── Lifecycle ──
      } else if (method === 'POST' && pathname === '/shutdown') {
        sendJson(res, 200, { ok: true, message: 'stringd shutting down' });
        setTimeout(() => process.exit(0), 50);
      } else if (method === 'GET' && pathname === '/health') {
        let totalTopics = 0;
        for (const r of runtimes.values()) totalTopics += r.topics.size;
        sendJson(res, 200, { ok: true, users: users.list().length, sessions: totalTopics });

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

export function startDaemon(port = 3100, opts?: { log?: boolean }): void {
  const logEnabled = opts?.log || process.env.STRINGD_LOG === '1';
  log = createLogger({
    enabled: logEnabled,
    dir: join(STRINGD_DATA_DIR, 'logs'),
  });

  const loadedUsers = users.list().length;
  if (loadedUsers > 0) {
    console.log(`Loaded ${loadedUsers} user(s) from ${STRINGD_DATA_DIR}/users.json`);
  }

  const server = createServer();
  server.listen(port, () => {
    console.log(`stringd listening on http://localhost:${port}`);
    console.log('Endpoints: POST/GET/DELETE /users  GET/POST/DELETE /sessions  POST /exec');
    log.info('server.start', { port, dataDir: STRINGD_DATA_DIR, logEnabled });
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
