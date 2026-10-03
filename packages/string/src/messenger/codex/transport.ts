import type { RpcFrame } from './appserver-protocol.js';

/**
 * A duplex JSON frame channel to a Codex app-server. In production this wraps a ws:// remote
 * connection or a stdio child process speaking NDJSON; in tests it is an in-memory pair. The
 * adapter depends only on this interface, so it never carries a socket dependency itself.
 */
export interface AppServerTransport {
  /** Send one frame to the app-server. */
  send(frame: RpcFrame): void;
  /** Register the handler for frames arriving from the app-server (called once). */
  onFrame(cb: (frame: RpcFrame) => void): void;
  /** Register the handler for the connection closing (called once). */
  onClose(cb: () => void): void;
  /** Close the connection. */
  close(): void;
}
