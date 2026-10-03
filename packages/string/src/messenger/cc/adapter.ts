import type { AgentEventInbox } from './inbox.js';
import type { DeliverableMessage, DeliveryAck, DeliveryMode, InboundAdapter } from '../types.js';

export interface CcAdapterOptions {
  /** The recipient agent's event inbox (idempotent push + read-ack, both keyed by message id). */
  inbox: AgentEventInbox;
  /** Out-of-band delivery acks. cc-channel only ever emits `delivered` (on the read-ack). */
  onAck: (ack: DeliveryAck) => void;
}

/**
 * Delivers messages into one Claude Code agent through its String event inbox. A message becomes
 * a local-webhook event keyed by its message id; `delivered` is acked when the attached CC
 * session READ-ACKS that event (the robust signal — not the composer pixels, not the webhook
 * 202). With no session attached the event stays `pending` in the inbox and no `delivered` is
 * emitted, so the hub keeps the message `dispatched` (queued) rather than falsely delivered.
 *
 * Delivery is idempotent on the message id: the hub redelivers on reconnect and a bridge can
 * restart, so `deliver` may be called more than once for the same message — the inbox push does
 * not duplicate the event, and the agent sees it exactly once.
 *
 * Unlike the codex adapter there is no steer/interrupt protocol here — every message is an inbox
 * event the session picks up in order — so `mode` is accepted for interface parity and ignored.
 */
export class CcChannelAdapter implements InboundAdapter {
  private readonly inbox: AgentEventInbox;
  private readonly onAck: (ack: DeliveryAck) => void;
  /** Message ids awaiting the recipient session's read-ack (the delivered signal). */
  private readonly awaiting = new Set<string>();
  private closed = false;

  constructor(opts: CcAdapterOptions) {
    this.inbox = opts.inbox;
    this.onAck = opts.onAck;
  }

  async start(): Promise<void> {
    this.inbox.onAck((key) => this.handleAck(key));
  }

  async deliver(msg: DeliverableMessage, _opts?: { mode?: DeliveryMode }): Promise<void> {
    if (this.closed) throw new Error('cc-channel adapter is closed');
    // Register BEFORE pushing and key on the message id, so a read-ack can never beat the record
    // (no buffering of foreign acks), and a redelivery re-attaches instead of duplicating.
    this.awaiting.add(msg.id);
    try {
      await this.inbox.push(msg.id, this.render(msg));
    } catch (err) {
      this.awaiting.delete(msg.id);
      throw err;
    }
  }

  /** The text the recipient CC session sees: sender attribution then the body verbatim. */
  private render(msg: DeliverableMessage): string {
    return `[from ${msg.from}] ${msg.body}`;
  }

  private handleAck(key: string): void {
    if (this.closed) return;
    // Only messages we are awaiting matter; an ack for anything else (unrelated inbox traffic, or
    // a message already acked) is dropped, never buffered — so nothing grows unbounded.
    if (!this.awaiting.delete(key)) return;
    this.onAck({ messageId: key, state: 'delivered' });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.awaiting.clear();
    this.inbox.close();
  }
}
