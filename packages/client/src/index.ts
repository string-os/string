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
export async function health(port: number): Promise<{ ok: boolean; agents: number; sessions: number }> {
  const res = await request(port, 'GET', '/health');
  if (res.status !== 200) {
    throw new Error(`health check failed (${res.status}): ${res.body}`);
  }
  return JSON.parse(res.body);
}
