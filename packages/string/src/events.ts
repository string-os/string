import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

// Lifecycle: pending → delivered → ack.
//  - pending:   appended, never yet flushed to any live stream (missed work).
//  - delivered: flushed to ≥1 stream at least once; deliveredAt set. Awaiting ack.
//  - ack:       consumer confirmed handled. Only these are retention-purgeable.
export type AgentEventStatus = 'pending' | 'delivered' | 'ack';

export interface AgentEvent {
  id: string;
  agentId: string;
  receivedAt: string;
  source: 'local-webhook';
  text: string;
  status: AgentEventStatus;
  deliveredAt?: string;
  ackedAt?: string;
}

export interface EventSummary {
  id: string;
  receivedAt: string;
  source: string;
  status: AgentEventStatus;
  preview: string;
}

const EVENT_ID_PREFIX = 'evt_';
const EVENT_DIR = 'events';

export function createWebhookToken(): string {
  return `wh_${randomBytes(24).toString('base64url')}`;
}

export class EventStore {
  private readonly dir: string;

  constructor(private readonly home: string) {
    this.dir = path.join(home, EVENT_DIR);
  }

  async append(agentId: string, text: string, source: AgentEvent['source'] = 'local-webhook'): Promise<AgentEvent> {
    const trimmed = text.trimEnd();
    const event: AgentEvent = {
      id: `${EVENT_ID_PREFIX}${Date.now().toString(36)}_${randomBytes(5).toString('base64url')}`,
      agentId,
      receivedAt: new Date().toISOString(),
      source,
      text: trimmed,
      status: 'pending',
    };
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.eventPath(event.id), JSON.stringify(event, null, 2) + '\n', { mode: 0o600 });
    return event;
  }

  async list(opts: { includeAck?: boolean; limit?: number } = {}): Promise<EventSummary[]> {
    const events = await this.readAll();
    // Default view is "unacked" — both pending and delivered are still open work
    // for the agent; only ack hides an event.
    const filtered = opts.includeAck ? events : events.filter(e => e.status !== 'ack');
    const limit = opts.limit ?? 50;
    return filtered
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, limit)
      .map(e => ({
        id: e.id,
        receivedAt: e.receivedAt,
        source: e.source,
        status: e.status,
        preview: previewText(e.text),
      }));
  }

  /**
   * Backlog snapshot for the visibility surface (`GET /events/count`). Powers the
   * consumer's channel-init "N unread since <ts>" summary — the mechanism that
   * makes a hidden backlog impossible to miss (the Vera case: 9 days of unseen
   * webhooks). `unacked = pending + delivered` is the "open work" count (mirrors
   * `list()`'s default view, which hides only `ack`); `oldestUnackedAt` is the
   * `receivedAt` of the oldest still-open event (the "<ts>" in the summary), or
   * null when the inbox is clear.
   */
  async count(): Promise<{ pending: number; delivered: number; ack: number; unacked: number; oldestUnackedAt: string | null }> {
    const events = await this.readAll();
    let pending = 0;
    let delivered = 0;
    let ack = 0;
    let oldestUnackedAt: string | null = null;
    for (const e of events) {
      if (e.status === 'pending') pending++;
      else if (e.status === 'delivered') delivered++;
      else if (e.status === 'ack') { ack++; continue; }
      if (oldestUnackedAt === null || e.receivedAt < oldestUnackedAt) oldestUnackedAt = e.receivedAt;
    }
    return { pending, delivered, ack, unacked: pending + delivered, oldestUnackedAt };
  }

  /**
   * Events to replay to a (re)connecting stream, oldest-first. Live push
   * (`notifyEventStreams`) only reaches streams connected at fire time; the
   * backfill catches a consumer up on what it missed. The set is:
   *
   *   - every `pending` event (never flushed to any stream — genuinely missed,
   *     e.g. a cron tick during downtime); always replayed → at-least-once.
   *   - `delivered` events still within `graceMs` of their first delivery — a
   *     crash-mid-turn redelivery window. Delivered events OLDER than the grace
   *     are assumed handled and NOT replayed, so a later resume / compact / second
   *     session does not re-flood the agent with its whole history.
   *
   * `graceMs = 0` degenerates to "deliver each event exactly once, never redeliver
   * a delivered event"; a large grace approaches "redeliver until acked".
   * `nowMs` is injectable for deterministic tests.
   */
  async deliverable(graceMs: number, nowMs: number = Date.now()): Promise<AgentEvent[]> {
    const events = await this.readAll();
    return events
      .filter(e => {
        if (e.status === 'pending') return true;
        if (e.status !== 'delivered') return false; // ack → never
        if (!e.deliveredAt) return true; // delivered but unstamped → replay (safe)
        return nowMs - Date.parse(e.deliveredAt) < graceMs;
      })
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  /**
   * Mark an event delivered (idempotent): pending → delivered, stamping
   * `deliveredAt` once. A no-op for already-delivered or acked events, so the
   * grace window is measured from FIRST delivery and never slides forward on
   * reconnect churn.
   */
  async markDelivered(id: string): Promise<AgentEvent | null> {
    const event = await this.read(id);
    if (!event) return null;
    if (event.status === 'pending') {
      event.status = 'delivered';
      event.deliveredAt = new Date().toISOString();
      await fs.writeFile(this.eventPath(id), JSON.stringify(event, null, 2) + '\n', { mode: 0o600 });
    }
    return event;
  }

  async read(id: string): Promise<AgentEvent | null> {
    if (!validEventId(id)) return null;
    try {
      const raw = await fs.readFile(this.eventPath(id), 'utf-8');
      return JSON.parse(raw) as AgentEvent;
    } catch {
      return null;
    }
  }

  async ack(id: string): Promise<AgentEvent | null> {
    const event = await this.read(id);
    if (!event) return null;
    if (event.status !== 'ack') {
      event.status = 'ack';
      event.ackedAt = new Date().toISOString();
      await fs.writeFile(this.eventPath(id), JSON.stringify(event, null, 2) + '\n', { mode: 0o600 });
    }
    return event;
  }

  async clear(opts: { all?: boolean } = {}): Promise<number> {
    const events = await this.readAll();
    let count = 0;
    for (const event of events) {
      if (!opts.all && event.status !== 'ack') continue;
      await fs.rm(this.eventPath(event.id), { force: true });
      count++;
    }
    return count;
  }

  /**
   * Retention sweep. Removes:
   *   - `ack`ed events older than `retentionMs` (aged from ackedAt) — the normal
   *     path; handled events don't need to live forever.
   *   - any non-acked event older than `maxAgeMs` (aged from receivedAt) — a hard
   *     safety cap so an un-acked backlog can't grow without bound if no consumer
   *     ever acks. `maxAgeMs` should be >> `retentionMs`; stale purges are surfaced
   *     by the caller, never silent.
   *
   * `now` is injectable for deterministic tests.
   */
  async sweep(opts: { retentionMs: number; maxAgeMs: number; now?: number }): Promise<{ purgedAcked: number; purgedStale: number }> {
    const now = opts.now ?? Date.now();
    const events = await this.readAll();
    let purgedAcked = 0;
    let purgedStale = 0;
    for (const e of events) {
      if (e.status === 'ack') {
        const acked = Date.parse(e.ackedAt ?? e.receivedAt);
        if (now - acked >= opts.retentionMs) {
          await fs.rm(this.eventPath(e.id), { force: true });
          purgedAcked++;
        }
      } else if (now - Date.parse(e.receivedAt) >= opts.maxAgeMs) {
        await fs.rm(this.eventPath(e.id), { force: true });
        purgedStale++;
      }
    }
    return { purgedAcked, purgedStale };
  }

  private eventPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private async readAll(): Promise<AgentEvent[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const events: AgentEvent[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const event = await this.read(id);
      if (event) events.push(event);
    }
    return events;
  }
}

function validEventId(id: string): boolean {
  return /^evt_[a-z0-9]+_[a-zA-Z0-9_-]+$/.test(id);
}

function previewText(text: string): string {
  const line = text.split('\n').find(l => l.trim()) ?? '';
  const compact = line.trim().replace(/\s+/g, ' ');
  return compact.length > 80 ? compact.slice(0, 77) + '...' : compact;
}
