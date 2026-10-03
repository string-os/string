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
  /** Dial the app-server, yielding a fresh transport. Called again on reconnect. */
  connect: () => Promise<AppServerTransport>;
  /** Out-of-band delivery acks (delivered / answered). */
  onAck: (ack: DeliveryAck) => void;
  /** Gate for INTERRUPT: only human identities (founder/cso) may pre-empt a turn. */
  isHuman?: (from: string) => boolean;
}

/**
 * Delivers messages into one Codex agent over a single persistent app-server connection
 * (the per-connection trap: resume + run all turns on the same connection; on drop, reconnect
 * and resume before expecting completions). STEER by default; INTERRUPT only for founder/cso.
 * `delivered` is acked on the recorded userMessage item whose clientId echoes our id — never
 * on the agent's reply.
 */
export class CodexAppserverAdapter implements InboundAdapter {
  private readonly threadId: string;
  private readonly connectFn: () => Promise<AppServerTransport>;
  private readonly onAck: (ack: DeliveryAck) => void;
  private readonly isHuman: (from: string) => boolean;

  private transport: AppServerTransport | null = null;
  private ready: Promise<void> = Promise.resolve();
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  /** clientUserMessageId -> our messageId, awaiting its userMessage item (the delivered signal). */
  private readonly awaitingDelivery = new Map<string, string>();
  private activeTurnId: string | null = null;
  private closing = false;
  private reconnecting = false;

  constructor(opts: CodexAdapterOptions) {
    this.threadId = opts.threadId;
    this.connectFn = opts.connect;
    this.onAck = opts.onAck;
    this.isHuman = opts.isHuman ?? (() => false);
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
    // Resume the EXISTING thread. Never thread/start.
    await this.request(METHODS.threadResume, { threadId: this.threadId });
  }

  private handleClose(): void {
    this.transport = null;
    this.activeTurnId = null;
    // In-flight requests on the dead socket can never resolve.
    for (const { reject } of this.pending.values()) reject(new Error('app-server connection closed'));
    this.pending.clear();
    if (this.closing || this.reconnecting) return;
    this.reconnecting = true;
    this.ready = this.connectAndResume().finally(() => {
      this.reconnecting = false;
    });
    // Surface a reconnect failure without an unhandled rejection; the next deliver() awaits ready.
    this.ready.catch(() => {});
  }

  private request<R = unknown>(method: string, params: unknown): Promise<R> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new Error('no app-server connection'));
    const id = this.nextId++;
    const frame: RpcRequest = { id, method, params };
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      transport.send(frame);
    });
  }

  async deliver(msg: DeliverableMessage, opts?: { mode?: DeliveryMode }): Promise<void> {
    await this.ready; // wait out any in-progress (re)connect
    const mode: DeliveryMode = opts?.mode ?? 'steer';
    const cumid = msg.clientUserMessageId ?? msg.id;
    // Register BEFORE sending: the userMessage item can arrive before turn/start's response.
    this.awaitingDelivery.set(cumid, msg.id);

    // INTERRUPT is reserved for human identities; otherwise fall back to steer. It also needs
    // a known active turn id: right after a reconnect we don't have one (resume does not yet
    // report active-turn state — fast-follow), so interrupt degrades to steer until the next
    // turn/started is observed. You cannot turn/interrupt a turn whose id you don't hold.
    if (mode === 'interrupt' && this.isHuman(msg.from) && this.activeTurnId) {
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
          const messageId = this.awaitingDelivery.get(item.clientId);
          if (messageId) {
            this.awaitingDelivery.delete(item.clientId);
            this.onAck({ messageId, state: 'delivered', threadId: item.threadId, turnId: item.turnId });
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
    for (const { reject } of this.pending.values()) reject(new Error('adapter closing'));
    this.pending.clear();
    this.transport?.close();
    this.transport = null;
  }
}
