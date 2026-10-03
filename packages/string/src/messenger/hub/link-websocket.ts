import type { Frame } from './protocol.js';
import type { HubLink } from './link.js';

/**
 * Minimal structural view of the client WebSocket the bridge dials with. Node 22+ ships a global
 * `WebSocket` (undici), so the bridge needs no `ws` dependency; this type lets the wrapper compile
 * without pulling in the DOM lib, and lets a test or a different runtime inject its own impl.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close', cb: () => void): void;
  addEventListener(type: 'error', cb: (ev: unknown) => void): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const defaultFactory: WebSocketFactory = (url) =>
  // The built-in global; cast through unknown since we deliberately avoid the DOM lib types.
  new (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(url);

/**
 * Dial the hub over a client WebSocket and adapt it to {@link HubLink}. Resolves once the socket
 * is open (so the bridge can send its hello); frames are newline-free JSON. A connect error before
 * open rejects — the bridge's reconnect loop retries with backoff.
 */
export function connectWebSocket(url: string, factory: WebSocketFactory = defaultFactory): Promise<HubLink> {
  return new Promise<HubLink>((resolve, reject) => {
    const ws = factory(url);
    let frameCb: ((f: Frame) => void) | null = null;
    let closeCb: (() => void) | null = null;
    let opened = false;

    ws.addEventListener('message', (ev: { data: unknown }) => {
      if (!frameCb) return;
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      let frame: Frame;
      try {
        frame = JSON.parse(raw) as Frame;
      } catch {
        return; // drop a malformed frame rather than throw in the socket callback
      }
      frameCb(frame);
    });
    ws.addEventListener('close', () => closeCb?.());
    ws.addEventListener('error', () => {
      if (!opened) reject(new Error(`websocket connect failed: ${url}`));
    });
    ws.addEventListener('open', () => {
      opened = true;
      resolve({
        send: (frame: Frame) => ws.send(JSON.stringify(frame)),
        onFrame: (cb) => {
          frameCb = cb;
        },
        onClose: (cb) => {
          closeCb = cb;
        },
        close: () => ws.close(),
      });
    });
  });
}
