import type { HubLink } from './link.js';
import {
  PROTOCOL_VERSION,
  checkProtocolVersion,
  isFrame,
  isHumanIdentity,
  type AgentName,
  type BridgeAckState,
  type Frame,
  type OutboundMessage,
  type StampedMessage,
} from './protocol.js';
import type { DeliverableMessage, DeliveryAck, InboundAdapter } from '../types.js';

export interface SendOutcome {
  /** The hub-owned delivery state the send landed in (e.g. accepted / rejected). */
  state: string;
  messageId?: string;
  reason?: string;
}

export interface BridgeOptions {
  bridgeId: string;
  machineId: string;
  /** The bridge's capability token; the hub derives the agents this connection may serve/speak-as. */
  token: string;
  /** Dial the hub, yielding a fresh link. Called again on every reconnect. */
  connect: () => Promise<HubLink>;
  /** Recipient agent name -> the local adapter that delivers to it. */
  adapters?: Map<AgentName, InboundAdapter>;
  protocolVersion?: string;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  onError?: (reason: string) => void;
}

/**
 * The agent-box side of the cross-machine messenger: one persistent client WebSocket the bridge
 * DIALS OUT to the hub (no inbound ports). It performs the versioned hello handshake, routes each
 * `deliver` to the right local InboundAdapter by recipient, relays the adapter's delivered/answered
 * acks back to the hub, and carries outbound `send` with sendResult correlation. A dropped
 * connection reconnects with capped backoff and re-hellos (heartbeat/liveness is S6).
 *
 * Delivery is deduped by message id: the hub redelivers on reconnect, so the same `deliver` can
 * arrive more than once — the bridge never dispatches an in-flight message twice and re-asserts
 * the ack for one already delivered (so a lost ack is recovered). The adapters are themselves
 * idempotent, so this is belt-and-suspenders.
 */
export class Bridge {
  private readonly bridgeId: string;
  private readonly machineId: string;
  private readonly token: string;
  private readonly connectFn: () => Promise<HubLink>;
  private readonly adapters: Map<AgentName, InboundAdapter>;
  private readonly protocolVersion: string;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly onError?: (reason: string) => void;

  private link: HubLink | null = null;
  private helloOk = false;
  private ready: Promise<void> = Promise.resolve();
  private helloSettlers: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private closing = false;
  private reconnecting = false;
  /** Set when the hub refuses the hello (bad token / version); no retry can fix it. */
  private fatal = false;

  private refCounter = 0;
  private readonly pendingSends = new Map<string, { resolve: (o: SendOutcome) => void; reject: (e: Error) => void }>();
  /** Messages confirmed delivered (so a redelivered `deliver` re-asserts the ack, not re-dispatches). */
  private readonly delivered = new Set<string>();
  /** Messages currently out at an adapter (so a duplicate `deliver` is not dispatched twice). */
  private readonly dispatching = new Set<string>();
  /** Acks produced while disconnected, flushed on reconnect. */
  private pendingAcks: Frame[] = [];
  private readonly backoffWaiters = new Set<() => void>();

  constructor(opts: BridgeOptions) {
    this.bridgeId = opts.bridgeId;
    this.machineId = opts.machineId;
    this.token = opts.token;
    this.connectFn = opts.connect;
    this.adapters = opts.adapters ?? new Map();
    this.protocolVersion = opts.protocolVersion ?? PROTOCOL_VERSION;
    this.baseBackoffMs = opts.baseBackoffMs ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.onError = opts.onError;
  }

  /** Register (or replace) the adapter serving a recipient agent. */
  register(agent: AgentName, adapter: InboundAdapter): void {
    this.adapters.set(agent, adapter);
  }

  async start(): Promise<void> {
    this.ready = this.connectAndHello();
    await this.ready;
  }

  private async connectAndHello(): Promise<void> {
    const link = await this.connectFn();
    this.link = link;
    this.helloOk = false;
    link.onFrame((f) => this.handleFrame(f));
    link.onClose(() => this.handleClose());
    await new Promise<void>((resolve, reject) => {
      this.helloSettlers = { resolve, reject };
      this.rawSend({
        t: 'hello',
        protocolVersion: this.protocolVersion,
        bridgeId: this.bridgeId,
        machineId: this.machineId,
        token: this.token,
      });
    });
    // helloOk received: flush any acks produced while we were disconnected.
    this.flushPendingAcks();
  }

  private handleClose(): void {
    this.link = null;
    this.helloOk = false;
    if (this.helloSettlers) {
      this.helloSettlers.reject(new Error('hub connection closed during handshake'));
      this.helloSettlers = null;
    }
    for (const { reject } of this.pendingSends.values()) reject(new Error('hub connection closed'));
    this.pendingSends.clear();
    // In-flight dispatches will be redelivered by the hub; let them re-dispatch on reconnect.
    this.dispatching.clear();
    if (this.closing || this.fatal || this.reconnecting) return;
    this.reconnecting = true;
    this.ready = this.reconnectLoop();
    this.ready.catch(() => {});
  }

  private async reconnectLoop(): Promise<void> {
    let attempt = 0;
    try {
      while (!this.closing && !this.fatal) {
        try {
          await this.connectAndHello();
          return;
        } catch {
          if (this.fatal) return; // helloReject — retrying cannot help
          attempt += 1;
          await this.wait(Math.min(this.baseBackoffMs * 2 ** (attempt - 1), this.maxBackoffMs));
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

  private rawSend(frame: Frame): void {
    this.link?.send(frame);
  }

  async send(from: AgentName, msg: OutboundMessage): Promise<SendOutcome> {
    await this.ready;
    const clientRef = `cr_${++this.refCounter}`;
    return new Promise<SendOutcome>((resolve, reject) => {
      this.pendingSends.set(clientRef, { resolve, reject });
      this.rawSend({ t: 'send', clientRef, from, msg });
    });
  }

  /** An adapter observed delivered/answered for a message; relay it to the hub (buffer if offline). */
  reportAck(ack: DeliveryAck): void {
    if (ack.state === 'delivered') {
      this.delivered.add(ack.messageId);
      this.dispatching.delete(ack.messageId);
    }
    this.sendAck(ack.messageId, ack.state);
  }

  private sendAck(messageId: string, state: BridgeAckState): void {
    const frame: Frame = { t: 'ack', messageId, state };
    if (this.link && this.helloOk) this.rawSend(frame);
    else this.pendingAcks.push(frame);
  }

  private flushPendingAcks(): void {
    const acks = this.pendingAcks;
    this.pendingAcks = [];
    for (const f of acks) this.rawSend(f);
  }

  private handleFrame(frame: Frame): void {
    if (isFrame(frame, 'helloOk')) {
      const check = checkProtocolVersion(frame.protocolVersion);
      if (!check.ok) {
        this.fatal = true;
        this.helloSettlers?.reject(new Error(check.reason));
        this.helloSettlers = null;
        this.onError?.(check.reason);
        this.link?.close();
        return;
      }
      this.helloOk = true;
      this.helloSettlers?.resolve();
      this.helloSettlers = null;
      return;
    }
    if (isFrame(frame, 'helloReject')) {
      this.fatal = true;
      this.helloSettlers?.reject(new Error(frame.reason));
      this.helloSettlers = null;
      this.onError?.(`hub refused hello: ${frame.reason}`);
      this.link?.close();
      return;
    }
    if (isFrame(frame, 'deliver')) {
      this.handleDeliver(frame.msg);
      return;
    }
    if (isFrame(frame, 'sendResult')) {
      const waiter = this.pendingSends.get(frame.clientRef);
      if (waiter) {
        this.pendingSends.delete(frame.clientRef);
        waiter.resolve({ state: frame.state, messageId: frame.messageId, reason: frame.reason });
      }
      return;
    }
    if (isFrame(frame, 'error')) {
      this.onError?.(frame.reason);
      if (frame.ref) {
        const waiter = this.pendingSends.get(frame.ref);
        if (waiter) {
          this.pendingSends.delete(frame.ref);
          waiter.reject(new Error(frame.reason));
        }
      }
      return;
    }
    // heartbeat and anything else: ignored here (liveness is S6).
  }

  private handleDeliver(msg: StampedMessage): void {
    if (this.delivered.has(msg.id)) {
      // Already delivered; the hub redelivered because it missed our ack. Re-assert it.
      this.sendAck(msg.id, 'delivered');
      return;
    }
    if (this.dispatching.has(msg.id)) return; // already working on it
    const adapter = this.adapters.get(msg.to);
    if (!adapter) {
      this.rawSend({ t: 'error', reason: `no adapter for recipient '${msg.to}'`, ref: msg.id });
      return;
    }
    this.dispatching.add(msg.id);
    // Human identities (founder/cso) may pre-empt; everyone else steers/queues per the adapter.
    const mode = isHumanIdentity(msg.from) ? 'interrupt' : 'steer';
    adapter.deliver(this.toDeliverable(msg), { mode }).catch((err: unknown) => {
      // The adapter could not submit (e.g. a hung runtime). Drop the in-flight mark so the hub's
      // redelivery re-dispatches; the bridge never asserts `failed` (that is hub-owned).
      this.dispatching.delete(msg.id);
      this.onError?.(`deliver failed for ${msg.id}: ${(err as Error).message}`);
    });
  }

  private toDeliverable(msg: StampedMessage): DeliverableMessage {
    return {
      id: msg.id,
      from: msg.from,
      to: msg.to,
      body: msg.body,
      clientUserMessageId: msg.clientUserMessageId,
    };
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const cancel of this.backoffWaiters) cancel();
    this.backoffWaiters.clear();
    for (const { reject } of this.pendingSends.values()) reject(new Error('bridge closing'));
    this.pendingSends.clear();
    this.link?.close();
    this.link = null;
  }
}
