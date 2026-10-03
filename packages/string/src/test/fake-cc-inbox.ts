/**
 * In-memory AgentEventInbox for cc-channel tests. Everything is keyed by the message id. Models:
 *  - idempotent push: a repeat push for a known key creates NO second event (the agent sees it
 *    once); if that key was already acked, the ack is re-reported (re-attach to the delivered fact);
 *  - a push with no attached session stays `pending` (the offline guard);
 *  - attaching a session drains + read-acks the pending backlog (the delivered signal);
 *  - acks reported by key, only for keys this inbox pushed.
 * Test-only (excluded from the build).
 */
import type { AgentEventInbox } from '../messenger/cc/inbox.js';

interface InboxEvent {
  body: string;
  acked: boolean;
}

export class FakeAgentInbox implements AgentEventInbox {
  /** One entry per DISTINCT key — proves pushes do not duplicate events. */
  readonly pushed: Array<{ key: string; body: string }> = [];
  private readonly byKey = new Map<string, InboxEvent>();
  private ackCb: ((key: string) => void) | null = null;
  private attached = false;
  private readonly autoAck: boolean;

  constructor(opts?: { autoAck?: boolean }) {
    this.autoAck = opts?.autoAck ?? true;
  }

  push(key: string, body: string): Promise<void> {
    const existing = this.byKey.get(key);
    if (existing) {
      // Idempotent: no duplicate event. If already read-acked, re-attach to the delivered fact.
      if (existing.acked) queueMicrotask(() => this.ackCb?.(key));
      return Promise.resolve();
    }
    this.byKey.set(key, { body, acked: false });
    this.pushed.push({ key, body });
    if (this.attached) this.flushKey(key);
    return Promise.resolve();
  }

  onAck(cb: (key: string) => void): void {
    this.ackCb = cb;
  }

  close(): void {
    this.ackCb = null;
  }

  // --- test controls ---
  /** A CC session attaches: it drains and read-acks the whole pending backlog. */
  attach(): void {
    this.attached = true;
    if (this.autoAck) for (const key of this.byKey.keys()) this.flushKey(key);
  }
  detach(): void {
    this.attached = false;
  }
  /** Read-ack one specific pending event by hand (for autoAck:false tests). */
  readAck(key: string): void {
    const ev = this.byKey.get(key);
    if (ev) ev.acked = true;
    this.ackCb?.(key);
  }
  /** Emit an ack for a key this inbox never pushed (unrelated inbox traffic). */
  emitForeignAck(key: string): void {
    this.ackCb?.(key);
  }
  pendingKeys(): string[] {
    return [...this.byKey.entries()].filter(([, ev]) => !ev.acked).map(([k]) => k);
  }

  private flushKey(key: string): void {
    if (!this.attached || !this.autoAck) return;
    const ev = this.byKey.get(key);
    if (!ev || ev.acked) return;
    ev.acked = true;
    queueMicrotask(() => this.ackCb?.(key));
  }
}
