/**
 * The OUTBOUND bridge send path (bridge-send-server). Proofs:
 *  - isLoopbackAddress classifies v4/v6/v4-mapped loopback vs remote;
 *  - a non-loopback caller is refused 403 and the hub send is never attempted (the real hazard —
 *    a local socket can never present a remote address, so this is driven with a fabricated req);
 *  - a `from` this bridge does not serve is refused 403, locally, before any hub send;
 *  - a served `from` reaches the hub and the hub's accepted verdict is returned (200 + messageId);
 *  - a hub REJECTION is surfaced truthfully as a non-2xx with the reason — never a fake success;
 *  - a transport failure (link down) is a 502, not a success;
 *  - bad input (missing field / wrong method / unknown path) is rejected without touching the hub.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { assert, section } from './runner.js';
import { createSendHandler, createSendServer, isLoopbackAddress } from '../messenger/hub/bridge-send-server.js';
import type { SendServerDeps } from '../messenger/hub/bridge-send-server.js';
import type { SendOutcome } from '../messenger/hub/bridge.js';
import type { OutboundMessage } from '../messenger/hub/protocol.js';

interface Call {
  from: string;
  to: string;
  body: string;
}

function makeDeps(opts: { agents: string[]; outcome?: SendOutcome; throwErr?: string }): {
  deps: SendServerDeps;
  calls: Call[];
} {
  const calls: Call[] = [];
  const deps: SendServerDeps = {
    agents: opts.agents,
    send: async (from: string, msg: OutboundMessage): Promise<SendOutcome> => {
      calls.push({ from, to: msg.to, body: msg.body });
      if (opts.throwErr) throw new Error(opts.throwErr);
      return opts.outcome ?? { state: 'accepted', messageId: 'msg_1' };
    },
  };
  return { deps, calls };
}

async function withServer(deps: SendServerDeps, fn: (port: number) => Promise<void>): Promise<void> {
  const server = createSendServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function post(
  port: number,
  pathUrl: string,
  body: unknown,
  method = 'POST',
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathUrl}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* leave json empty for non-JSON bodies */
  }
  return { status: res.status, json, text };
}

await section('bridge-send: isLoopbackAddress classifies peers', async () => {
  assert(isLoopbackAddress('127.0.0.1'), '127.0.0.1 is loopback');
  assert(isLoopbackAddress('127.5.6.7'), 'the whole 127/8 is loopback');
  assert(isLoopbackAddress('::1'), '::1 is loopback');
  assert(isLoopbackAddress('::ffff:127.0.0.1'), 'a v4-mapped loopback is loopback');
  assert(!isLoopbackAddress('10.0.0.5'), 'a LAN address is not loopback');
  assert(!isLoopbackAddress('203.0.113.7'), 'a public address is not loopback');
  assert(!isLoopbackAddress(undefined), 'a missing peer address is not trusted');
});

await section('bridge-send: a non-loopback caller is refused 403 and the hub send never runs', async () => {
  const { deps, calls } = makeDeps({ agents: ['nova'] });
  const handler = createSendHandler(deps);
  let status = 0;
  let body = '';
  const res = {
    writeHead(s: number) {
      status = s;
    },
    end(b?: string) {
      body = b ?? '';
    },
  } as unknown as http.ServerResponse;
  // A fabricated request with a public peer address — a real local socket can never produce this,
  // which is exactly why the refusal needs a unit test rather than a live connection.
  const req = {
    socket: { remoteAddress: '203.0.113.7' },
    method: 'POST',
    url: '/send',
  } as unknown as http.IncomingMessage;
  handler(req, res);
  assert(status === 403, 'a non-loopback caller gets 403');
  assert(/loopback/.test(body), 'the refusal names loopback');
  assert(calls.length === 0, 'the hub send is never attempted for a remote caller');
});

await section('bridge-send: a request carrying an Origin header is refused 403 (browser CSRF)', async () => {
  const { deps, calls } = makeDeps({ agents: ['nova'] });
  const handler = createSendHandler(deps);
  let status = 0;
  let body = '';
  const res = {
    writeHead(s: number) {
      status = s;
    },
    end(b?: string) {
      body = b ?? '';
    },
  } as unknown as http.ServerResponse;
  // A loopback POST that looks valid EXCEPT it carries an Origin — i.e. a browser on this box. A CLI
  // never sets Origin, so refusing it costs nothing and blocks a web page from speaking as an agent.
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    method: 'POST',
    url: '/send',
    headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
  } as unknown as http.IncomingMessage;
  handler(req, res);
  assert(status === 403, 'an Origin-bearing request gets 403');
  assert(/Origin/.test(body), 'the refusal names Origin');
  assert(calls.length === 0, 'the hub send is never attempted for a browser request');
});

await section('bridge-send: a non-JSON body is refused 415 (blocks the no-preflight CSRF POST)', async () => {
  const { deps, calls } = makeDeps({ agents: ['nova'] });
  await withServer(deps, async (port) => {
    // text/plain is a CORS "simple" request — no preflight. The 415 is what stops a web page from
    // smuggling a JSON crew message through under that guise.
    const res = await fetch(`http://127.0.0.1:${port}/send`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ from: 'nova', to: 'leo', body: 'csrf attempt' }),
    });
    assert(res.status === 415, 'a text/plain body is 415');
    assert(calls.length === 0, 'the body was never parsed or relayed to the hub');
  });
});

await section('bridge-send: a from this bridge does not serve is refused 403, before any hub send', async () => {
  const { deps, calls } = makeDeps({ agents: ['nova'] });
  await withServer(deps, async (port) => {
    const r = await post(port, '/send', { from: 'rook', to: 'leo', body: 'hi' });
    assert(r.status === 403, 'an unserved from gets 403');
    assert(/does not serve 'rook'/.test(String(r.json.error ?? '')), 'the error names the refused sender');
    assert(calls.length === 0, 'the hub send is never attempted for an unserved from');
  });
});

await section('bridge-send: a served from reaches the hub and the accepted verdict is returned', async () => {
  const { deps, calls } = makeDeps({ agents: ['nova'], outcome: { state: 'accepted', messageId: 'msg_42' } });
  await withServer(deps, async (port) => {
    const r = await post(port, '/send', { from: 'nova', to: 'leo', body: 'reporting in' });
    assert(r.status === 200, 'accepted is 200');
    assert(r.json.state === 'accepted' && r.json.messageId === 'msg_42', 'the hub verdict + id are returned');
    assert(calls.length === 1, 'the send reached the hub exactly once');
    assert(calls[0]?.from === 'nova' && calls[0]?.to === 'leo' && calls[0]?.body === 'reporting in', 'from/to/body passed through');
  });
});

await section('bridge-send: a hub REJECTION is surfaced truthfully (non-2xx + reason), never a fake success', async () => {
  const { deps } = makeDeps({ agents: ['nova'], outcome: { state: 'rejected', reason: 'unknown recipient' } });
  await withServer(deps, async (port) => {
    const r = await post(port, '/send', { from: 'nova', to: 'ghost', body: 'hello?' });
    assert(r.status === 409, 'a rejection is a non-2xx (409), not a 200');
    assert(r.json.state === 'rejected', 'the state is the hub rejection');
    assert(r.json.reason === 'unknown recipient', 'the hub reason is passed through');
  });
});

await section('bridge-send: a transport failure (link down) is a 502, not a success', async () => {
  const { deps } = makeDeps({ agents: ['nova'], throwErr: 'hub connection not ready (dropped before send)' });
  await withServer(deps, async (port) => {
    const r = await post(port, '/send', { from: 'nova', to: 'leo', body: 'are you there' });
    assert(r.status === 502, 'a send that throws is a 502');
    assert(/hub connection not ready/.test(String(r.json.error ?? '')), 'the transport error is reported');
  });
});

await section('bridge-send: bad input and wrong routes are rejected without touching the hub', async () => {
  const { deps, calls } = makeDeps({ agents: ['nova'] });
  await withServer(deps, async (port) => {
    const missing = await post(port, '/send', { from: 'nova', to: 'leo' });
    assert(missing.status === 400, 'a missing body field is 400');
    const notJson = await post(port, '/send', 'not json');
    assert(notJson.status === 400, 'a non-JSON body is 400');
    const wrongMethod = await post(port, '/send', {}, 'GET');
    assert(wrongMethod.status === 405, 'a non-POST is 405');
    const wrongPath = await post(port, '/nope', { from: 'nova', to: 'leo', body: 'x' });
    assert(wrongPath.status === 404, 'an unknown path is 404');
    assert(calls.length === 0, 'none of the malformed requests reached the hub');
  });
});
