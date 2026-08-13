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
  /**
   * ISO timestamp of the FIRST time this event was flushed to any stream.
   * Deliberately decoupled from the pending→delivered→ack status machine: it is
   * stamped once and never depends on (or advances) status or ack. That makes it
   * a reliable "has this event already been shown before" signal even in the
   * regime where nothing acks and `delivered` never engages — which is exactly
   * the data that caused the replay-flood incidents. Used to mark a re-emitted
   * event as a replay (see markEmitted / the daemon backfill).
   */
  firstEmittedAt?: string;
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

/**
 * Serialize read-modify-write on a single event file WITHIN this process.
 *
 * Each mutator (`markDelivered`, `ack`, `markEmitted`) is read-decide-write over
 * the same JSON file with no OS-level lock. Two of them running concurrently on
 * one event lost-update each other: e.g. a live-push `markDelivered` reads
 * `pending`, and before it writes, the consumer's auto-ack writes `ack` — then
 * `markDelivered` writes back its stale `delivered`, ERASING the ack. The event
 * is then stuck non-acked and gets replayed on the next resume/compact (the
 * exact replay-flood this surface is meant to stop). Keying an async lock on the
 * file path makes each mutator's read+write atomic against the others, so the
 * lifecycle only ever advances (pending → delivered → ack), never regresses.
 *
 * COVERAGE — what this lock does and does NOT serialize (named on purpose so the
 * limit stays written down, not rediscovered in three months):
 *
 *  - COVERS: mutator-against-mutator, in-process. `markDelivered`, `ack`, and
 *    (PR2) `markEmitted` racing each other on the same event file — the hot-path
 *    collision (a live push's markDelivered vs the consumer's autoAck) this fix
 *    exists for. Each mutator's read+write runs atomically w.r.t. the others, so
 *    the lifecycle only advances (pending → delivered → ack), never regresses.
 *    NOTE for PR2: a locked mutator must not call ANOTHER locked mutator from
 *    inside its critical section — same-key re-entry would self-deadlock. (read()
 *    is deliberately outside the lock, so today's mutators are re-entry-free.)
 *
 *  - NOT covered — DELETION racing a mutation, in-process (unbuilt leg). `sweep()`
 *    (its stale-past-maxAge branch, which rm's NON-acked events) and `clear()`
 *    delete files OUTSIDE this lock. A delete landing inside a locked mutator's
 *    read→write gap lets the mutator RECREATE the file it just deleted —
 *    resurrecting a purged event as delivered/non-acked, which then replays on the
 *    next resume/compact. Low severity: the window is one locked mutator's
 *    read→write gap, and the sweep branch additionally requires age > maxAgeMs
 *    (documented as >> retentionMs). To close it, route those deletes through this
 *    same lock.
 *
 *  - NOT covered — CROSS-PROCESS (unbuilt leg). A separate `string event ack` CLI
 *    process is not serialized by an in-process lock, and writes are in-place
 *    `fs.writeFile` (no temp+rename, no OS lock), so a cross-process interleave can
 *    produce the SAME lost update — far rarer, because that path is human-paced.
 *    Needs an atomic write + CAS, or flock. A torn read from a mid-write is already
 *    fail-safe: `read()` returns null on a JSON parse error rather than crashing.
 */
const eventMutationLocks = new Map<string, Promise<unknown>>();
function withEventLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = eventMutationLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run fn after the predecessor settles, success or failure
  const gate = run.then(() => undefined, () => undefined); // never let one failure poison the chain
  eventMutationLocks.set(key, gate);
  // Drop the entry once this is the tail, so the map doesn't grow per-event unbounded.
  void gate.then(() => { if (eventMutationLocks.get(key) === gate) eventMutationLocks.delete(key); });
  return run;
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
    return withEventLock(this.eventPath(id), async () => {
      const event = await this.read(id);
      if (!event) return null;
      if (event.status === 'pending') {
        event.status = 'delivered';
        event.deliveredAt = new Date().toISOString();
        await fs.writeFile(this.eventPath(id), JSON.stringify(event, null, 2) + '\n', { mode: 0o600 });
      }
      return event;
    });
  }

  /**
   * Record that this event is being flushed to a stream, and report whether it
   * had ALREADY been emitted before this call. Stamps `firstEmittedAt` exactly
   * once (on the first emission) and is otherwise a read; it never touches
   * `status`/`deliveredAt`/`ackedAt`, so "already emitted" is answerable even
   * when nothing acks and the event is still `pending`.
   *
   * `wasEmittedBefore === true` ⇔ this is a re-emission (a replay): the daemon
   * decorates such an event with a visible banner so a stale message can't read
   * as new. Compute it ONCE per event (not per stream) so a brand-new event
   * fanned out to several same-agent streams in one pass is not mislabeled a
   * replay on the second stream — see the daemon's live-push path.
   *
   * Runs under the same per-file lock as markDelivered/ack (its stamp is a
   * read-modify-write on the same file), and — per the lock's re-entry rule —
   * does its own read+write and never calls another locked mutator.
   */
  async markEmitted(id: string): Promise<{ event: AgentEvent | null; wasEmittedBefore: boolean }> {
    return withEventLock(this.eventPath(id), async () => {
      const event = await this.read(id);
      if (!event) return { event: null, wasEmittedBefore: false };
      if (event.firstEmittedAt) return { event, wasEmittedBefore: true };
      event.firstEmittedAt = new Date().toISOString();
      await fs.writeFile(this.eventPath(id), JSON.stringify(event, null, 2) + '\n', { mode: 0o600 });
      return { event, wasEmittedBefore: false };
    });
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
    return withEventLock(this.eventPath(id), async () => {
      const event = await this.read(id);
      if (!event) return null;
      if (event.status !== 'ack') {
        event.status = 'ack';
        event.ackedAt = new Date().toISOString();
        await fs.writeFile(this.eventPath(id), JSON.stringify(event, null, 2) + '\n', { mode: 0o600 });
      }
      return event;
    });
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
