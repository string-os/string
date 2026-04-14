/**
 * stringd HTTP client — ping, ensureUser, exec (SSE parsing)
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
      { hostname: '127.0.0.1', port, method, path, headers: { ...headers } },
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

/** POST /users — register or update a user. Idempotent. */
export async function ensureUser(
  port: number,
  user: { id: string; home: string },
): Promise<void> {
  const res = await request(
    port,
    'POST',
    '/users',
    JSON.stringify({ user_id: user.id, home: user.home }),
  );
  if (res.status !== 200) {
    throw new Error(`ensureUser failed (${res.status}): ${res.body}`);
  }
}

/** POST /exec — execute a command, parse SSE response into ExecResult. */
export async function exec(
  port: number,
  userId: string,
  topic: string,
  cmd: string,
): Promise<ExecResult> {
  const res = await request(
    port,
    'POST',
    '/exec',
    JSON.stringify({ cmd, topic }),
    { 'X-User-Id': userId },
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

/** GET /health — daemon health with user/session counts. */
export async function health(port: number): Promise<{ ok: boolean; users: number; sessions: number }> {
  const res = await request(port, 'GET', '/health');
  if (res.status !== 200) {
    throw new Error(`health check failed (${res.status}): ${res.body}`);
  }
  return JSON.parse(res.body);
}
