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
  /** How often to send a heartbeat once connected. Default 15s; 0 disables (S6 liveness). */
  heartbeatIntervalMs?: number;
  /** Injectable clock (ms); defaults to Date.now. Stamps heartbeats and expires the dedup map. */
  now?: () => number;
  onError?: (reason: string) => void;
}

/** How long a delivered message id is remembered for redelivery dedup before it is forgotten. */
const DELIVERED_TTL_MS = 24 * 60 * 60 * 1000;

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
  private readonly heartbeatIntervalMs: number;
  private readonly now: () => number;
  private readonly onError?: (reason: string) => void;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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
  /**
   * Messages confirmed delivered -> the ms they were confirmed, so a redelivered `deliver`
   * re-asserts the ack instead of re-dispatching. Entries older than DELIVERED_TTL_MS are
   * forgotten so this never grows without bound (a redelivery that old is not realistic).
   */
  private readonly delivered = new Map<string, number>();
  /** Messages currently out at an adapter (so a duplicate `deliver` is not dispatched twice). */
  private readonly dispatching = new Set<string>();
  /** Acks produced while disconnected, flushed on reconnect; keyed by message id so a re-asserted
   * ack collapses onto one entry (bounded by distinct messages, not by redelivery count). */
  private pendingAcks = new Map<string, Frame>();
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
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 15_000;
    this.now = opts.now ?? Date.now;
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
    // helloOk received: flush any acks produced while we were disconnected, then start the
    // heartbeat so the hub can tell this bridge is alive (silence must look like silence, not calm).
    this.flushPendingAcks();
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.heartbeatIntervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.link && this.helloOk) this.rawSend({ t: 'heartbeat', machineId: this.machineId, atMs: this.now() });
    }, this.heartbeatIntervalMs);
    // Don't keep the process alive just for heartbeats.
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private handleClose(): void {
    this.link = null;
    this.helloOk = false;
    this.stopHeartbeat();
    if (this.helloSettlers) {
      this.helloSettlers.reject(new Error('hub connection closed during handshake'));
      this.helloSettlers = null;
    }
    for (const { reject } of this.pendingSends.values()) reject(new Error('hub connection closed'));
    this.pendingSends.clear();
    // KEEP `dispatching` across the reconnect: the adapter delivery is local and outlives the hub
    // link, so a message still being handled is NOT finished. If we cleared it and the hub
    // redelivered on reconnect, handleDeliver would dispatch it a second time (e.g. the codex
    // adapter would fire a second turn/start). The in-flight deliver() resolves to an ack or
    // rejects (hung → its catch clears dispatching), and only then does redelivery re-dispatch.
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
      // `ready` resolving does not guarantee the link is still up — it may have dropped in the
      // microtask gap since. Check before registering so send() rejects instead of hanging forever
      // (a drop AFTER we register is caught by handleClose, which rejects every pending send).
      if (!this.link || !this.helloOk) {
        reject(new Error('hub connection not ready (dropped before send)'));
        return;
      }
      this.pendingSends.set(clientRef, { resolve, reject });
      this.rawSend({ t: 'send', clientRef, from, msg });
    });
  }

  /** An adapter observed delivered/answered for a message; relay it to the hub (buffer if offline). */
  reportAck(ack: DeliveryAck): void {
    if (ack.state === 'delivered') {
      this.delivered.set(ack.messageId, this.now());
      this.dispatching.delete(ack.messageId);
    }
    this.pruneDelivered();
    this.sendAck(ack.messageId, ack.state);
  }

  /** Forget delivered ids older than the TTL so the dedup map cannot grow without bound. */
  private pruneDelivered(): void {
    const cutoff = this.now() - DELIVERED_TTL_MS;
    for (const [id, at] of this.delivered) {
      if (at < cutoff) this.delivered.delete(id);
    }
  }

  private sendAck(messageId: string, state: BridgeAckState): void {
    const frame: Frame = { t: 'ack', messageId, state };
    if (this.link && this.helloOk) this.rawSend(frame);
    else this.pendingAcks.set(messageId, frame); // keyed by id: a re-assert overwrites, not appends
  }

  private flushPendingAcks(): void {
    const acks = this.pendingAcks;
    this.pendingAcks = new Map();
    for (const f of acks.values()) this.rawSend(f);
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
    this.pruneDelivered();
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
    this.stopHeartbeat();
    for (const cancel of this.backoffWaiters) cancel();
    this.backoffWaiters.clear();
    for (const { reject } of this.pendingSends.values()) reject(new Error('bridge closing'));
    this.pendingSends.clear();
    this.link?.close();
    this.link = null;
  }
}
