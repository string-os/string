/**
 * In-memory AgentEventInbox for cc-channel tests. Models the behaviour that matters:
 *  - a push while no session is attached stays `pending` (unacked) — the offline guard;
 *  - attaching a session drains the backlog and read-acks each event (the delivered signal);
 *  - acks are delivered out-of-band via the registered callback.
 * Test-only (excluded from the build).
 */
import type { AgentEventInbox } from '../messenger/cc/inbox.js';

export class FakeAgentInbox implements AgentEventInbox {
  readonly pushed: Array<{ eventId: string; body: string }> = [];
  private ackCb: ((eventId: string) => void) | null = null;
  private attached = false;
  private counter = 0;
  /** Event ids pushed but not yet acked (pending in the inbox). */
  private readonly unacked: string[] = [];
  /** When true (default), an attached session drains+acks automatically; false = drive acks by hand. */
  private readonly autoAck: boolean;

  constructor(opts?: { autoAck?: boolean }) {
    this.autoAck = opts?.autoAck ?? true;
  }

  push(body: string): Promise<string> {
    const eventId = `evt_fake_${++this.counter}`;
    this.pushed.push({ eventId, body });
    this.unacked.push(eventId);
    if (this.attached) this.flush();
    return Promise.resolve(eventId);
  }

  onAck(cb: (eventId: string) => void): void {
    this.ackCb = cb;
  }

  close(): void {
    this.ackCb = null;
  }

  // --- test controls ---
  /** A CC session attaches: it drains and read-acks the whole pending backlog. */
  attach(): void {
    this.attached = true;
    this.flush();
  }
  /** The session detaches: later pushes stay pending until a session attaches again. */
  detach(): void {
    this.attached = false;
  }
  /** Emit an ack for an arbitrary event id (e.g. an unknown/duplicate id). */
  emitAck(eventId: string): void {
    this.ackCb?.(eventId);
  }
  /** Read-ack one specific pending event by hand (for autoAck:false tests). */
  readAck(eventId: string): void {
    const i = this.unacked.indexOf(eventId);
    if (i >= 0) this.unacked.splice(i, 1);
    this.ackCb?.(eventId);
  }
  get pendingCount(): number {
    return this.unacked.length;
  }

  private flush(): void {
    if (!this.attached || !this.autoAck) return;
    const ids = this.unacked.splice(0);
    for (const id of ids) queueMicrotask(() => this.ackCb?.(id));
  }
}
