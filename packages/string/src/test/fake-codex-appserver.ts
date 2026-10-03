/**
 * An in-process Codex app-server faithful to the measured NDJSON protocol (design §4b), plus
 * an in-memory transport pair. Test-only (excluded from the build). It records every method it
 * receives (so a test can assert `thread/start` was NEVER sent) and emits the delivered
 * observable — a userMessage item/started whose clientId echoes the turn/start's
 * clientUserMessageId.
 */
import type { AppServerTransport } from '../messenger/codex/transport.js';
import {
  METHODS,
  NOTIFICATIONS,
  isRequest,
  type RpcFrame,
  type TurnItem,
  type TurnStartParams,
} from '../messenger/codex/appserver-protocol.js';

class MemoryTransport implements AppServerTransport {
  private frameCb: ((f: RpcFrame) => void) | null = null;
  private closeCb: (() => void) | null = null;
  peer!: MemoryTransport;
  closed = false;

  send(frame: RpcFrame): void {
    if (this.closed) return;
    const peer = this.peer;
    queueMicrotask(() => {
      if (!peer.closed) peer.frameCb?.(frame);
    });
  }
  onFrame(cb: (f: RpcFrame) => void): void {
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

export function createMemoryTransportPair(): { client: AppServerTransport; server: AppServerTransport } {
  const a = new MemoryTransport();
  const b = new MemoryTransport();
  a.peer = b;
  b.peer = a;
  return { client: a, server: b };
}

export class FakeCodexAppServer {
  readonly receivedMethods: string[] = [];
  readonly turnStarts: TurnStartParams[] = [];
  private transport: AppServerTransport | null = null;
  private turnCounter = 0;
  private itemCounter = 0;
  private activeTurnId: string | null = null;

  constructor(private readonly threadId: string) {}

  /** The connect factory handed to the adapter: a fresh pair per (re)connect, same server. */
  connect = (): Promise<AppServerTransport> => {
    const { client, server } = createMemoryTransportPair();
    this.attach(server);
    return Promise.resolve(client);
  };

  private attach(t: AppServerTransport): void {
    this.transport = t;
    t.onFrame((f) => this.onFrame(f));
    t.onClose(() => {
      this.transport = null;
    });
  }

  private send(f: RpcFrame): void {
    this.transport?.send(f);
  }

  private onFrame(f: RpcFrame): void {
    if (!isRequest(f)) return;
    this.receivedMethods.push(f.method);
    switch (f.method) {
      case METHODS.threadResume:
      case METHODS.threadStart: // responded to, but a test asserts it is never sent
        this.send({ id: f.id, result: { threadId: this.threadId } });
        break;
      case METHODS.turnInterrupt:
        this.activeTurnId = null;
        this.send({ id: f.id, result: {} });
        break;
      case METHODS.turnStart: {
        const p = f.params as TurnStartParams;
        this.turnStarts.push(p);
        const started = this.activeTurnId === null;
        if (started) this.activeTurnId = `turn-${++this.turnCounter}`;
        const turnId = this.activeTurnId as string;
        this.send({ id: f.id, result: { turnId } });
        if (started) this.send({ method: NOTIFICATIONS.turnStarted, params: { threadId: this.threadId, turnId } });
        // The delivered observable: the userMessage input item echoing our clientId.
        if (p.clientUserMessageId) {
          const item: TurnItem = {
            id: `item-${++this.itemCounter}`,
            type: 'userMessage',
            clientId: p.clientUserMessageId,
            text: p.input,
            threadId: this.threadId,
            turnId,
          };
          this.send({ method: NOTIFICATIONS.itemStarted, params: { threadId: this.threadId, turnId, item } });
        }
        break;
      }
      default:
        this.send({ id: f.id, result: {} });
    }
  }

  // --- test controls ---
  /** Emit a later agentMessage reply item — a candidate `answered`, NEVER the delivery signal. */
  reply(text: string): void {
    const turnId = this.activeTurnId ?? `turn-${this.turnCounter}`;
    const item: TurnItem = { id: `item-${++this.itemCounter}`, type: 'agentMessage', text, threadId: this.threadId, turnId };
    this.send({ method: NOTIFICATIONS.itemStarted, params: { threadId: this.threadId, turnId, item } });
    this.send({ method: NOTIFICATIONS.itemCompleted, params: { threadId: this.threadId, turnId, item } });
  }
  completeActiveTurn(): void {
    const turnId = this.activeTurnId;
    if (turnId) {
      this.activeTurnId = null;
      this.send({ method: NOTIFICATIONS.turnCompleted, params: { threadId: this.threadId, turnId } });
    }
  }
  /** Simulate a connection drop (crash / network blip). */
  dropConnection(): void {
    this.transport?.close();
  }
  get turnCount(): number {
    return this.turnCounter;
  }
  get activeTurn(): string | null {
    return this.activeTurnId;
  }
}
