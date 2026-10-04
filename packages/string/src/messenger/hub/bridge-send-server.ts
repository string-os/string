import http from 'http';
import type { AgentName, OutboundMessage } from './protocol.js';
import type { SendOutcome } from './bridge.js';

/**
 * The OUTBOUND half of the agent-box bridge: a tiny HTTP listener, bound to LOOPBACK only, that lets
 * a local agent send a cross-machine message through this box's one bridge connection. The bridge
 * itself still dials OUT to the hub (no inbound network port); this listener is reachable only from
 * 127.0.0.1, so nothing off-box can speak through it.
 *
 * `POST /send` with `{ from, to, body }`:
 *  - the caller must be on loopback (defence-in-depth on top of the 127.0.0.1 bind);
 *  - `from` must be one of the agents THIS bridge serves — a name it does not serve is refused, never
 *    silently relayed. The hub additionally re-derives the real sender from the bridge's capability
 *    token, so `from` only selects which served identity to speak as; it cannot forge another bridge.
 *  - the response is the hub's own verdict (accepted + messageId, or rejected + reason). A rejection
 *    is surfaced truthfully with a non-2xx status — this never fabricates a success.
 */
export interface SendServerDeps {
  /** Submit an outbound message through the bridge; resolves the hub's verdict (never faked). */
  send: (from: AgentName, msg: OutboundMessage) => Promise<SendOutcome>;
  /** The agent names this bridge serves; a `from` outside this set is refused locally. */
  agents: readonly string[];
  /** Max accepted request body in bytes (defensive; a bridge send is tiny). Default 64 KiB. */
  maxBodyBytes?: number;
}

/** A loopback peer: IPv4 127.0.0.0/8, IPv6 ::1, or an IPv4-mapped ::ffff:127.x. Anything else is remote. */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false; // a socket with no remote address is not something we trust
  const a = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  if (a === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

/**
 * Build the `(req, res)` handler. Split out from {@link createSendServer} so a test can drive it with
 * a fabricated request — in particular a non-loopback `remoteAddress`, which a real local socket can
 * never produce.
 */
export function createSendHandler(
  deps: SendServerDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const maxBodyBytes = deps.maxBodyBytes ?? 64 * 1024;
  const served = new Set(deps.agents);
  return (req, res) => {
    // Loopback-only. The listener binds 127.0.0.1, but we also reject any caller whose socket peer is
    // not loopback, so a future mis-bind can never quietly expose outbound send to the network.
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendJson(res, 403, { error: 'refused: caller is not on loopback' });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: `use POST, not ${req.method}` });
      return;
    }
    const pathOnly = (req.url ?? '').split('?')[0];
    if (pathOnly !== '/send') {
      sendJson(res, 404, { error: `unknown path ${pathOnly}` });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > maxBodyBytes) {
        aborted = true;
        sendJson(res, 413, { error: 'request body too large' });
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('error', () => {
      if (aborted) return;
      aborted = true;
      try {
        sendJson(res, 400, { error: 'request stream error' });
      } catch {
        /* response already gone */
      }
    });
    req.on('end', () => {
      if (aborted) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const from = parsed.from;
      const to = parsed.to;
      const body = parsed.body;
      if (typeof from !== 'string' || !from.trim()) {
        sendJson(res, 400, { error: 'missing or empty "from"' });
        return;
      }
      if (typeof to !== 'string' || !to.trim()) {
        sendJson(res, 400, { error: 'missing or empty "to"' });
        return;
      }
      if (typeof body !== 'string' || body.length === 0) {
        sendJson(res, 400, { error: 'missing or empty "body"' });
        return;
      }
      if (!served.has(from)) {
        sendJson(res, 403, {
          error: `this bridge does not serve '${from}'; it serves: ${[...served].join(', ') || '(none)'}`,
        });
        return;
      }
      // Relay to the hub and return ITS verdict verbatim — accepted (2xx) or rejected (non-2xx with
      // the reason). A transport failure (link down) is a 502, never a fabricated success.
      deps
        .send(from, { to, body })
        .then((outcome) => {
          if (outcome.state === 'accepted') {
            sendJson(res, 200, { state: outcome.state, messageId: outcome.messageId ?? null });
          } else {
            sendJson(res, 409, { state: outcome.state, reason: outcome.reason ?? null });
          }
        })
        .catch((err: unknown) => {
          sendJson(res, 502, { error: `bridge send failed: ${(err as Error).message}` });
        });
    });
  };
}

/** An http.Server wrapping {@link createSendHandler}. The caller binds it to 127.0.0.1. */
export function createSendServer(deps: SendServerDeps): http.Server {
  return http.createServer(createSendHandler(deps));
}
