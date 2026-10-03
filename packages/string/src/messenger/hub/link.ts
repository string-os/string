import type { Frame } from './protocol.js';

/**
 * A duplex Frame channel to the crew-messenger hub. In production this wraps a persistent
 * client WebSocket the bridge DIALS OUT to the hub (no inbound ports on the agent box); in tests
 * it is an in-memory pair. The bridge depends only on this interface, so it carries no socket
 * dependency itself — the production wrapper lives in link-websocket.ts.
 */
export interface HubLink {
  /** Send one frame to the hub. */
  send(frame: Frame): void;
  /** Register the handler for frames arriving from the hub (called once). */
  onFrame(cb: (frame: Frame) => void): void;
  /** Register the handler for the connection closing (called once). */
  onClose(cb: () => void): void;
  /** Close the connection. */
  close(): void;
}
