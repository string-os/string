import type { AppServerTransport } from './transport.js';
import type { DeliverableMessage, DeliveryAck, DeliveryMode, InboundAdapter } from '../types.js';
import {
  METHODS,
  NOTIFICATIONS,
  isNotification,
  isResponse,
  type ItemEventParams,
  type RpcFrame,
  type RpcRequest,
  type TurnStartedParams,
  type TurnCompletedParams,
} from './appserver-protocol.js';

export interface CodexAdapterOptions {
  /**
   * The agent's EXISTING thread id (recorded by crew-agent in crew-agents.json). The adapter
   * resumes this thread on every (re)connect and NEVER creates one — creating a thread is
   * spawn-agent's job; a new thread would be a context-less agent the founder cannot see.
   */
  threadId: string;
  /** Dial the app-server, yielding a fresh transport. Called again on every reconnect. */
  connect: () => Promise<AppServerTransport>;
  /** Out-of-band delivery acks (delivered / answered). */
  onAck: (ack: DeliveryAck) => void;
  /** Gate for INTERRUPT: only human identities (founder/cso) may pre-empt a turn. */
  isHuman?: (from: string) => boolean;
  /**
   * Reports the effective delivery mode when it differs from what was requested — today only
   * when an INTERRUPT degrades to STEER (non-human sender, or no active turn id yet after a
   * reconnect). Lets the caller log that a pre-emption did not actually happen.
   */
  onModeChange?: (info: { messageId: string; requested: DeliveryMode; effective: DeliveryMode }) => void;
  /** Per-request timeout; a hung app-server is treated as a dropped connection. Default 30s. */
  requestTimeoutMs?: number;
  /** Reconnect backoff bounds (capped exponential). Defaults 500ms → 30s. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** How long an unmatched pending-delivery entry lives before it is swept. Default 5min. */
  deliveryTtlMs?: number;
  /** Injectable clock (ms); defaults to Date.now. */
  now?: () => number;
}

interface PendingDelivery {
  messageId: string;
  at: number;
}

/**
 * Delivers messages into one Codex agent over a single persistent app-server connection
 * (the per-connection trap: resume + run all turns on the same connection; on drop, reconnect
 * and resume before expecting completions). App-server restarts are the normal case (launchd
 * KeepAlive), so a dropped connection retries with capped backoff until close(). STEER by
 * default; INTERRUPT only for founder/cso. `delivered` is acked on the recorded userMessage
 * item whose clientId echoes our id — never on the agent's reply.
 */
export class CodexAppserverAdapter implements InboundAdapter {
  private readonly threadId: string;
  private readonly connectFn: () => Promise<AppServerTransport>;
  private readonly onAck: (ack: DeliveryAck) => void;
  private readonly isHuman: (from: string) => boolean;
  private readonly onModeChange?: (info: { messageId: string; requested: DeliveryMode; effective: DeliveryMode }) => void;
  private readonly requestTimeoutMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly deliveryTtlMs: number;
  private readonly now: () => number;

  private transport: AppServerTransport | null = null;
  private ready: Promise<void> = Promise.resolve();
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  /** clientUserMessageId -> the message awaiting its userMessage item (the delivered signal). */
  private readonly awaitingDelivery = new Map<string, PendingDelivery>();
  private activeTurnId: string | null = null;
  private closing = false;
  private reconnecting = false;
  /** Cancellers for in-flight backoff waits, fired on close() so close never blocks on a sleep. */
  private readonly backoffWaiters = new Set<() => void>();

  constructor(opts: CodexAdapterOptions) {
    this.threadId = opts.threadId;
    this.connectFn = opts.connect;
    this.onAck = opts.onAck;
    this.isHuman = opts.isHuman ?? (() => false);
    this.onModeChange = opts.onModeChange;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.baseBackoffMs = opts.baseBackoffMs ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.deliveryTtlMs = opts.deliveryTtlMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async start(): Promise<void> {
    this.ready = this.connectAndResume();
    await this.ready;
  }

  private async connectAndResume(): Promise<void> {
    const transport = await this.connectFn();
    this.transport = transport;
    transport.onFrame((f) => this.handleFrame(f));
    transport.onClose(() => this.handleClose());
    try {
      // Resume the EXISTING thread. Never thread/start.
      await this.request(METHODS.threadResume, { threadId: this.threadId });
    } catch (err) {
      // A failed/timed-out resume leaves a half-open socket; tear it down so the retry is clean.
      transport.close();
      if (this.transport === transport) this.transport = null;
      throw err;
    }
  }

  private handleClose(): void {
    this.transport = null;
    this.activeTurnId = null;
    // In-flight requests on the dead socket can never resolve.
    for (const { reject } of this.pending.values()) reject(new Error('app-server connection closed'));
    this.pending.clear();
    if (this.closing || this.reconnecting) return;
    this.reconnecting = true;
    this.ready = this.reconnectLoop();
    // The next deliver() awaits ready; swallow here so a transient failure is not unhandled.
    this.ready.catch(() => {});
  }

  /** Retry connect+resume with capped exponential backoff until it succeeds or close() is called. */
  private async reconnectLoop(): Promise<void> {
    let attempt = 0;
    try {
      while (!this.closing) {
        try {
          await this.connectAndResume();
          return; // reconnected
        } catch {
          attempt += 1;
          const delay = Math.min(this.baseBackoffMs * 2 ** (attempt - 1), this.maxBackoffMs);
          await this.wait(delay);
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.backoffWaiters.delete(cancel);
        resolve();
      }, ms);
      const cancel = (): void => {
        clearTimeout(timer);
        this.backoffWaiters.delete(cancel);
        resolve();
      };
      this.backoffWaiters.add(cancel);
    });
  }

  private request<R = unknown>(method: string, params: unknown): Promise<R> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new Error('no app-server connection'));
    const id = this.nextId++;
    const frame: RpcRequest = { id, method, params };
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`app-server request ${method} timed out after ${this.requestTimeoutMs}ms`));
          // A hung app-server is treated as a dropped connection: close it so the hub sees a
          // failure now (deliver() rejects) and the reconnect loop takes over.
          this.transport?.close();
        }
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r as R);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      transport.send(frame);
    });
  }

  async deliver(msg: DeliverableMessage, opts?: { mode?: DeliveryMode }): Promise<void> {
    await this.ready; // wait out any in-progress (re)connect
    const requested: DeliveryMode = opts?.mode ?? 'steer';
    const cumid = msg.clientUserMessageId ?? msg.id;
    this.sweepStaleDeliveries();
    // Register BEFORE sending: the userMessage item can arrive before turn/start's response.
    this.awaitingDelivery.set(cumid, { messageId: msg.id, at: this.now() });

    // INTERRUPT is reserved for human identities and needs a known active turn id. Right after
    // a reconnect we hold no turn id yet (resume does not report active-turn state — fast-follow),
    // so interrupt degrades to steer until the next turn/started. Report the effective mode.
    let effective: DeliveryMode = 'steer';
    if (requested === 'interrupt' && this.isHuman(msg.from) && this.activeTurnId) {
      effective = 'interrupt';
    }
    if (requested !== effective) {
      this.onModeChange?.({ messageId: msg.id, requested, effective });
    }

    try {
      if (effective === 'interrupt' && this.activeTurnId) {
        await this.request(METHODS.turnInterrupt, { threadId: this.threadId, turnId: this.activeTurnId });
      }
      // A bare turn/start both STARTS (when idle) and STEERS (when a turn is active) — the
      // server decides, so the adapter's wire call is uniform.
      const result = await this.request<{ turnId?: string } | undefined>(METHODS.turnStart, {
        threadId: this.threadId,
        input: msg.body,
        clientUserMessageId: cumid,
      });
      if (result && typeof result.turnId === 'string') this.activeTurnId = result.turnId;
    } catch (err) {
      // The send failed (timeout / drop): drop the pending-delivery entry so a late item can't
      // fire a delivered for a message we are reporting as failed, and surface the failure.
      this.awaitingDelivery.delete(cumid);
      throw err;
    }
  }

  private sweepStaleDeliveries(): void {
    const cutoff = this.now() - this.deliveryTtlMs;
    for (const [clientId, entry] of this.awaitingDelivery) {
      if (entry.at < cutoff) this.awaitingDelivery.delete(clientId);
    }
  }

  private handleFrame(frame: RpcFrame): void {
    if (isResponse(frame)) {
      const waiter = this.pending.get(frame.id);
      if (!waiter) return;
      this.pending.delete(frame.id);
      if (frame.error) waiter.reject(new Error(frame.error.message));
      else waiter.resolve(frame.result);
      return;
    }
    if (!isNotification(frame)) return;
    switch (frame.method) {
      case NOTIFICATIONS.turnStarted: {
        const p = frame.params as TurnStartedParams | undefined;
        if (p?.turnId) this.activeTurnId = p.turnId;
        break;
      }
      case NOTIFICATIONS.itemStarted: {
        const p = frame.params as ItemEventParams | undefined;
        const item = p?.item;
        // The delivered observable: the userMessage input item echoing our clientId. NOT the reply.
        if (item && item.type === 'userMessage' && item.clientId) {
          const entry = this.awaitingDelivery.get(item.clientId);
          if (entry) {
            this.awaitingDelivery.delete(item.clientId);
            this.onAck({ messageId: entry.messageId, state: 'delivered', threadId: item.threadId, turnId: item.turnId });
          }
        }
        break;
      }
      case NOTIFICATIONS.turnCompleted: {
        const p = frame.params as TurnCompletedParams | undefined;
        if (p?.turnId && p.turnId === this.activeTurnId) this.activeTurnId = null;
        break;
      }
      default:
        break;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const cancel of this.backoffWaiters) cancel();
    this.backoffWaiters.clear();
    for (const { reject } of this.pending.values()) reject(new Error('adapter closing'));
    this.pending.clear();
    this.awaitingDelivery.clear();
    this.transport?.close();
    this.transport = null;
  }
}
