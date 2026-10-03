/**
 * The clean interface the cross-machine messenger BRIDGE (S4) calls to deliver a message
 * into a running local agent, per that agent's registry adapter choice. S5 implements the
 * `codex-appserver` adapter against this interface; `cc-channel` (S4) implements the same one.
 *
 * Delivery is acked out-of-band via the `onAck` callback given to the adapter, never by the
 * return of `deliver` — a resolved `deliver` means "submitted to the runtime", NOT "received".
 * The only state that means received is `delivered` (see DeliveryAck).
 */

/** What the bridge hands an adapter to deliver. `from`/`to` are already hub-stamped. */
export interface DeliverableMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  /** Correlation id echoed back by the runtime on the input item; defaults to `id`. */
  clientUserMessageId?: string;
}

/**
 * STEER is the default (join the active turn; start a new one when idle). INTERRUPT is
 * reserved for human identities (founder/cso) and pre-empts the active turn. QUEUE (the
 * experimental codex queue) is fast-follow and not implemented in S5.
 */
export type DeliveryMode = 'steer' | 'interrupt';

/** A bridge ack state. `delivered` = the runtime recorded the input item; `answered` is later. */
export type AckState = 'delivered' | 'answered';

export interface DeliveryAck {
  messageId: string;
  state: AckState;
  threadId?: string;
  turnId?: string;
}

export interface InboundAdapter {
  /** Open the connection to the runtime and make it ready to deliver. */
  start(): Promise<void>;
  /** Submit a message to the runtime. Resolving means submitted, NOT received. */
  deliver(msg: DeliverableMessage, opts?: { mode?: DeliveryMode }): Promise<void>;
  /** Close the connection; no further acks after this resolves. */
  close(): Promise<void>;
}
