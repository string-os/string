import type { AgentEventInbox } from './inbox.js';
import type { DeliverableMessage, DeliveryAck, DeliveryMode, InboundAdapter } from '../types.js';

export interface CcAdapterOptions {
  /** The recipient agent's event inbox (push + read-ack). */
  inbox: AgentEventInbox;
  /** Out-of-band delivery acks. cc-channel only ever emits `delivered` (on the read-ack). */
  onAck: (ack: DeliveryAck) => void;
}

/**
 * Delivers messages into one Claude Code agent through its String event inbox. A message becomes
 * a local-webhook event; `delivered` is acked when the attached CC session READ-ACKS that event
 * (the robust signal — not the composer pixels, not the webhook 202). With no session attached
 * the event stays `pending` in the inbox and no `delivered` is emitted, so the hub keeps the
 * message `dispatched` (queued) rather than falsely delivered.
 *
 * Unlike the codex adapter there is no steer/interrupt protocol here — every message is an inbox
 * event the session picks up in order — so `mode` is accepted for interface parity and ignored.
 */
export class CcChannelAdapter implements InboundAdapter {
  private readonly inbox: AgentEventInbox;
  private readonly onAck: (ack: DeliveryAck) => void;
  /** eventId -> our messageId, awaiting the recipient session's read-ack (the delivered signal). */
  private readonly awaitingAck = new Map<string, string>();
  /**
   * Event ids whose read-ack arrived before `deliver` recorded the correlation. A fast local
   * inbox can report the ack before `push()`'s promise continuation runs; the matching deliver
   * drains this. `onAck` is edge-triggered (at-most-once per event), so entries that never match
   * a deliver are only pathological duplicate/unknown ids and stay bounded.
   */
  private readonly earlyAcks = new Set<string>();
  private closed = false;

  constructor(opts: CcAdapterOptions) {
    this.inbox = opts.inbox;
    this.onAck = opts.onAck;
  }

  async start(): Promise<void> {
    this.inbox.onAck((eventId) => this.handleAck(eventId));
  }

  async deliver(msg: DeliverableMessage, _opts?: { mode?: DeliveryMode }): Promise<void> {
    if (this.closed) throw new Error('cc-channel adapter is closed');
    const eventId = await this.inbox.push(this.render(msg));
    // Resolving push means the event is stored (accepted), NOT received. We hold the correlation
    // until the session read-acks that event id, which is when we emit `delivered` — unless the
    // ack already raced ahead of this point.
    if (this.earlyAcks.delete(eventId)) {
      this.onAck({ messageId: msg.id, state: 'delivered' });
      return;
    }
    this.awaitingAck.set(eventId, msg.id);
  }

  /** The text the recipient CC session sees: sender attribution then the body verbatim. */
  private render(msg: DeliverableMessage): string {
    return `[from ${msg.from}] ${msg.body}`;
  }

  private handleAck(eventId: string): void {
    if (this.closed) return;
    const messageId = this.awaitingAck.get(eventId);
    if (messageId) {
      this.awaitingAck.delete(eventId);
      this.onAck({ messageId, state: 'delivered' });
      return;
    }
    // The ack beat the deliver that will record this event id; the matching deliver drains it.
    this.earlyAcks.add(eventId);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.awaitingAck.clear();
    this.earlyAcks.clear();
    this.inbox.close();
  }
}
