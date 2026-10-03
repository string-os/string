/**
 * In-memory hub + link pair for bridge tests. The FakeHub speaks the vendored wire protocol
 * (hello/helloOk|helloReject, send/sendResult, deliver, ack, error) and records what it receives,
 * so a test can assert the bridge handshakes, routes, relays acks, and correlates sends. Plus a
 * controllable FakeInboundAdapter. Test-only (excluded from the build).
 */
import type { HubLink } from '../messenger/hub/link.js';
import {
  PROTOCOL_VERSION,
  isFrame,
  type BridgeAckState,
  type Frame,
  type StampedMessage,
} from '../messenger/hub/protocol.js';
import type { DeliverableMessage, DeliveryAck, DeliveryMode, InboundAdapter } from '../messenger/types.js';

class MemoryLink implements HubLink {
  private frameCb: ((f: Frame) => void) | null = null;
  private closeCb: (() => void) | null = null;
  peer!: MemoryLink;
  closed = false;

  send(frame: Frame): void {
    if (this.closed) return;
    const peer = this.peer;
    queueMicrotask(() => {
      if (!peer.closed) peer.frameCb?.(frame);
    });
  }
  onFrame(cb: (f: Frame) => void): void {
    this.frameCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.closeCb?.());
    const peer = this.peer;
    if (!peer.closed) {
      peer.closed = true;
      queueMicrotask(() => peer.closeCb?.());
    }
  }
}

export function createLinkPair(): { client: HubLink; server: HubLink } {
  const a = new MemoryLink();
  const b = new MemoryLink();
  a.peer = b;
  b.peer = a;
  return { client: a, server: b };
}

export class FakeHub {
  readonly hellos: Array<{ bridgeId: string; token: string; protocolVersion: string }> = [];
  readonly sends: Array<{ clientRef: string; from: string; to: string; body: string }> = [];
  readonly acks: Array<{ messageId: string; state: BridgeAckState }> = [];
  readonly errors: Array<{ reason: string; ref?: string }> = [];
  /** Set a reason to refuse the hello handshake. */
  rejectHello: string | null = null;
  /** The version the hub advertises in helloOk (override to force a mismatch). */
  advertisedVersion = PROTOCOL_VERSION;
  hubId = 'hub-test';
  private link: HubLink | null = null;
  private msgCounter = 0;

  connect = (): Promise<HubLink> => {
    const { client, server } = createLinkPair();
    this.attach(server);
    return Promise.resolve(client);
  };

  private attach(l: HubLink): void {
    this.link = l;
    l.onFrame((f) => this.onFrame(f));
    l.onClose(() => {
      this.link = null;
    });
  }

  private send(f: Frame): void {
    this.link?.send(f);
  }

  private onFrame(f: Frame): void {
    if (isFrame(f, 'hello')) {
      this.hellos.push({ bridgeId: f.bridgeId, token: f.token, protocolVersion: f.protocolVersion });
      if (this.rejectHello) this.send({ t: 'helloReject', reason: this.rejectHello });
      else this.send({ t: 'helloOk', protocolVersion: this.advertisedVersion, hubId: this.hubId });
      return;
    }
    if (isFrame(f, 'send')) {
      this.sends.push({ clientRef: f.clientRef, from: f.from, to: f.msg.to, body: f.msg.body });
      this.send({ t: 'sendResult', clientRef: f.clientRef, state: 'accepted', messageId: `msg_${++this.msgCounter}` });
      return;
    }
    if (isFrame(f, 'ack')) {
      this.acks.push({ messageId: f.messageId, state: f.state });
      return;
    }
    if (isFrame(f, 'error')) {
      this.errors.push({ reason: f.reason, ref: f.ref });
      return;
    }
  }

  // --- test controls ---
  deliver(msg: StampedMessage): void {
    this.send({ t: 'deliver', msg });
  }
  drop(): void {
    this.link?.close();
  }
  get connected(): boolean {
    return this.link !== null;
  }
}

/** Build a StampedMessage (hub-stamped) for a deliver frame. */
export function stamped(id: string, from: string, to: string, body: string): StampedMessage {
  return { id, from, to, body, createdAtMs: 0 };
}

export class FakeInboundAdapter implements InboundAdapter {
  readonly delivered: DeliverableMessage[] = [];
  readonly modes: Array<DeliveryMode | undefined> = [];
  /** When true, deliver() immediately reports `delivered`; otherwise ack by hand. */
  autoDeliver = true;
  /** When set, the next deliver() throws (a hung runtime). */
  failNext = false;
  private readonly ackFn: (ack: DeliveryAck) => void;

  constructor(onAck: (ack: DeliveryAck) => void) {
    this.ackFn = onAck;
  }

  async start(): Promise<void> {}

  async deliver(msg: DeliverableMessage, opts?: { mode?: DeliveryMode }): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('runtime hung');
    }
    this.delivered.push(msg);
    this.modes.push(opts?.mode);
    if (this.autoDeliver) this.ackFn({ messageId: msg.id, state: 'delivered' });
  }

  async close(): Promise<void> {}

  /** Report an ack by hand (autoDeliver:false). */
  ack(messageId: string, state: BridgeAckState = 'delivered'): void {
    this.ackFn({ messageId, state });
  }
}
