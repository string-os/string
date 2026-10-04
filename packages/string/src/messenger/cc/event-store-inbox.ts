import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { type AgentEventStatus } from '../../events.js';
import type { AgentEventInbox } from './inbox.js';

/**
 * The outcome of reading one event's status.
 *  - a concrete status (`pending`/`delivered`/`ack`) — the normal case;
 *  - `gone` — the event file is confirmed ABSENT (ENOENT). This alone does NOT mean delivered: the
 *    daemon's `sweep()` stale-purges events that were never read (the `maxAge` cap) and `clear()`
 *    removes pending ones, so a `gone` is only treated as delivered when we have RECORDED a read
 *    (delivered/ack) for it (see {@link MapEntry.acked}); otherwise it is a non-delivery and the hub
 *    must redeliver;
 *  - `unreadable` — the file could not be parsed (a torn read mid-write, e.g. during the daemon's
 *    non-atomic in-place `ack()` rewrite). This is TRANSIENT: never treat it as gone — keep
 *    watching and re-read next tick. Conflating it with `gone` would falsely prune a live event.
 */
type ReadResult = AgentEventStatus | 'gone' | 'unreadable';

/** Durable per-message state: the event it maps to, and whether we have ever observed its read. */
interface MapEntry {
  eventId: string;
  /**
   * True once a READ has been observed — the event reaching `status: 'delivered'` OR `'ack'`. (The
   * JSON field is named `acked` for backward compatibility with maps written before `delivered`
   * also counted; its meaning is "read-observed".) A later `gone` on such an entry = delivered.
   */
  acked: boolean;
}

/**
 * The production {@link AgentEventInbox}: it delivers a messenger message into a Claude Code agent
 * through String's EXISTING event path and never opens a second write path of its own.
 *
 *  - PUSH is a `POST /webhook/<token>` to the local stringd. The daemon stays the sole writer of
 *    the agent's event store (its per-file lock is in-process only, so a second writer would risk
 *    the lost-update the store warns about) and does the append + live-stream notify + first-emit
 *    stamp exactly as any other webhook event. The 202 carries the `event_id`.
 *  - The DELIVERED signal is the recipient session READING the event — it reaching `status:
 *    'delivered'` (the daemon flushed it to the live session stream) OR `status: 'ack'` — observed
 *    by a read-only poll of that one event. A Claude Code session is injected the event on the
 *    `delivered` flush and never acks, so `delivered` IS the read for a CC agent; a consumer that
 *    acks reaches `ack`. Either counts. A webhook 202 is transport-accepted, NOT received, so it is
 *    deliberately not treated as delivered; with no session attached the event stays `pending` and
 *    no `delivered` is ever emitted.
 *
 * IDEMPOTENT ON THE MESSAGE ID. `EventStore.append` mints a fresh event id per call, so to make a
 * repeat push (hub redelivery, or a bridge RESTART) re-attach instead of appending a duplicate, the
 * `messageId -> {eventId, acked}` mapping is persisted to a 0600 file outside any agent home. The
 * recorded read flag (the `acked` field — see {@link MapEntry}) is what makes a later disappearance
 * unambiguous:
 *   - a `gone` event we had ALREADY read (delivered/ack) = delivered-then-swept (normal retention):
 *     re-assert delivered so a missed ack recovers;
 *   - a `gone` event we had NOT read = stale-purged / cleared BEFORE any session read it: NOT
 *     delivered — drop the entry, log, emit no ack, and let the hub redeliver (a fresh push
 *     re-POSTs a new event). Firing delivered here would silently lose the message.
 *
 * KNOWN DUPLICATE WINDOW: the daemon assigns the event id, so the map entry can only be persisted
 * AFTER the 202. If the bridge crashes between the daemon's append and that persist, a restart has
 * no record of the message; the hub redelivers it and we POST a second event. The recipient then
 * sees the message twice. This is the single non-idempotent window and is accepted as rare (it
 * needs a crash in that millisecond gap); closing it would require the daemon to accept a
 * caller-supplied idempotency key on the webhook, which is out of scope for this change.
 */
export interface EventStoreInboxOptions {
  /** The recipient agent id (for the webhook target + diagnostics). */
  agentId: string;
  /** The agent's String home; the read-ack poll reads event status from `${home}/events`. */
  home: string;
  /** This agent's daemon webhook endpoint, e.g. `http://127.0.0.1:3923/webhook/<token>`. */
  webhookUrl: string;
  /**
   * Persistent `messageId -> {eventId, acked}` map file (0600, bridge-owned, OUTSIDE any agent
   * home). A bridge restart reloads it so a redelivered push re-attaches rather than duplicating
   * the event, and so a recorded ack survives the restart.
   */
  mapPath: string;
  /** How often an awaited event is polled for its read-ack. Default 1000ms; must be > 0. */
  pollIntervalMs?: number;
  /** Injectable fetch (tests / alt runtimes). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Injectable read of an event's status by id. Defaults to reading the agent's event file and
   * distinguishing a confirmed-absent file ({@link ReadResult} `gone`) from a torn/unparseable one
   * (`unreadable`) — so a mid-write read is retried, never mistaken for a sweep.
   */
  readStatus?: (eventId: string) => Promise<ReadResult>;
  /** Best-effort error log; defaults to `console.error`. Never thrown into the caller. */
  onError?: (msg: string) => void;
}

export class EventStoreInbox implements AgentEventInbox {
  private readonly agentId: string;
  private readonly webhookUrl: string;
  private readonly mapPath: string;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly readStatus: (eventId: string) => Promise<ReadResult>;
  private readonly onError: (msg: string) => void;

  /** Durable `messageId -> {eventId, acked}` (loaded from {@link mapPath}); the dedup/re-attach key. */
  private readonly map = new Map<string, MapEntry>();
  /** Keys whose event we are still polling for its read-ack: `messageId -> eventId`. */
  private readonly watching = new Map<string, string>();
  private ackCb: ((key: string) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlapping poll passes: a slow read must not let the next tick double-fire. */
  private polling = false;
  private loaded: Promise<void> | null = null;
  private closed = false;
  /** Serializes {@link persist} writes so two un-awaited persists never race on the temp file. */
  private persistChain: Promise<void> = Promise.resolve();

  constructor(opts: EventStoreInboxOptions) {
    this.agentId = opts.agentId;
    this.webhookUrl = opts.webhookUrl;
    this.mapPath = opts.mapPath;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onError = opts.onError ?? ((m) => console.error(m));
    const home = opts.home;
    this.readStatus = opts.readStatus ?? ((eventId: string) => readEventStatus(home, eventId));
  }

  async push(key: string, body: string): Promise<void> {
    if (this.closed) throw new Error('event-store inbox is closed');
    await this.ensureLoaded();

    const known = this.map.get(key);
    if (known) {
      // Already pushed (this process or a prior one) — never re-POST. Re-attach to the fact.
      const status = await this.readStatus(known.eventId);
      await this.reconcile(key, known, status);
      return;
    }

    // New key: push through the daemon's existing webhook path (it is the sole writer).
    const eventId = await this.postWebhook(body);
    this.map.set(key, { eventId, acked: false });
    await this.persist();
    this.watch(key, eventId);
  }

  onAck(cb: (key: string) => void): void {
    this.ackCb = cb;
    if (this.watching.size > 0) this.ensureTimer();
  }

  close(): void {
    this.closed = true;
    this.ackCb = null;
    this.watching.clear();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Act on one observed status for a known key — shared by `push` (a redelivery) and `poll`.
   *  - `delivered` or `ack` → a READ: record it (durably) and emit delivered. For a Claude Code
   *               agent the daemon flushes the event to the live session stream (→ `delivered`) but
   *               the session never acks, so `delivered` IS the read; a daemon consumer that acks
   *               reaches `ack`. Either counts, so delivery no longer stalls on an ack that a CC
   *               session will never send (which otherwise left the event un-reported and, after a
   *               stale sweep, re-POSTed as a duplicate).
   *  - `gone`   → delivered ONLY if we had recorded a read (delivered/ack); otherwise a non-delivery
   *               (drop + log, no ack) so the hub redelivers;
   *  - else     → still pending, or a transient torn read (`unreadable`): keep watching and re-read.
   *               Never prune here.
   */
  private async reconcile(key: string, entry: MapEntry, status: ReadResult): Promise<void> {
    if (status === 'delivered' || status === 'ack') {
      this.watching.delete(key);
      if (!entry.acked) {
        entry.acked = true;
        await this.persist(); // record the read BEFORE firing, so a later `gone` is unambiguous
      }
      this.fireAck(key);
    } else if (status === 'gone') {
      this.watching.delete(key);
      if (entry.acked) {
        // Read earlier (delivered/ack), then swept by retention — re-assert so a missed ack recovers.
        this.fireAck(key);
      } else {
        // Vanished before any read (stale cap / clear): NOT delivered. Drop it and stay silent;
        // the hub still holds the message and will redeliver it as a fresh push.
        this.map.delete(key);
        await this.persist();
        this.onError(
          `[inbox ${this.agentId}] event ${entry.eventId} for ${key} disappeared before a read; treating as NOT delivered and awaiting hub redelivery`,
        );
      }
    } else {
      // pending / unreadable → keep watching and re-read next tick (never prune here).
      this.watch(key, entry.eventId);
    }
  }

  private async postWebhook(body: string): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body,
      });
    } catch (err) {
      throw new Error(`webhook push to ${this.agentId} failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new Error(`webhook push to ${this.agentId} returned ${res.status}`);
    }
    const json = (await res.json()) as { event_id?: string };
    if (!json.event_id) throw new Error(`webhook push to ${this.agentId} returned no event_id`);
    return json.event_id;
  }

  private watch(key: string, eventId: string): void {
    if (this.closed) return;
    this.watching.set(key, eventId);
    this.ensureTimer();
  }

  private ensureTimer(): void {
    if (this.timer || this.closed || this.pollIntervalMs <= 0) return;
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    // Never keep the process alive just to poll.
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    if (this.closed || this.watching.size === 0) {
      // Nothing to watch: drop the timer so it doesn't spin; a later push restarts it.
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return;
    }
    // One pass at a time: a read slower than the interval would otherwise let the next tick run
    // concurrently and fire the same key's ack twice (the contract is at-most-once per key).
    if (this.polling) return;
    this.polling = true;
    try {
      // Snapshot so mutation during the await doesn't disturb iteration.
      for (const [key, eventId] of [...this.watching]) {
        const entry = this.map.get(key);
        if (!entry) {
          this.watching.delete(key);
          continue;
        }
        let status: ReadResult;
        try {
          status = await this.readStatus(eventId);
        } catch (err) {
          this.onError(`[inbox ${this.agentId}] read-ack poll failed for ${eventId}: ${(err as Error).message}`);
          continue;
        }
        await this.reconcile(key, entry, status);
      }
    } finally {
      this.polling = false;
    }
  }

  private fireAck(key: string): void {
    const cb = this.ackCb;
    if (cb) queueMicrotask(() => cb(key));
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          const raw = await fs.readFile(this.mapPath, 'utf-8');
          const obj = JSON.parse(raw) as Record<string, { eventId?: unknown; acked?: unknown }>;
          for (const [k, v] of Object.entries(obj)) {
            if (v && typeof v.eventId === 'string') {
              this.map.set(k, { eventId: v.eventId, acked: v.acked === true });
            }
          }
        } catch {
          // No map yet (first run) or unreadable — start empty; it is rebuilt by subsequent pushes.
        }
      })();
    }
    return this.loaded;
  }

  /**
   * Atomically persist the map (temp + rename) so a crash never leaves a half-written file.
   *
   * Writes are SERIALIZED per inbox: two persists that fire close together (e.g. a bridge's hello and
   * a brief landing ~0.3s apart) must not overlap. The old code shared one `<file>.tmp`, so two
   * concurrent writes raced — the first rename moved the temp, the second found nothing (ENOENT) and
   * that persist was lost. Each queued write also uses a UNIQUE temp name, so even an out-of-process
   * writer on the same path cannot collide, and it snapshots the map WHEN IT RUNS, so the last write
   * wins with the freshest state. A failed write never wedges the chain (the next persist still runs).
   */
  private persist(): Promise<void> {
    const run = this.persistChain.then(() => this.writeMapSnapshot());
    this.persistChain = run.catch(() => {}); // a rejection must not break the chain for later writes
    return run;
  }

  private async writeMapSnapshot(): Promise<void> {
    const obj: Record<string, MapEntry> = {};
    for (const [k, v] of this.map) obj[k] = v; // snapshot at write time → freshest state wins
    const tmp = `${this.mapPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.mapPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(tmp, JSON.stringify(obj) + '\n', { mode: 0o600 });
      await fs.rename(tmp, this.mapPath);
    } catch (err) {
      // A failed persist is not fatal to delivery (the event was already pushed); it only weakens
      // restart dedup, so surface it rather than throw into the hub's delivery path.
      this.onError(`[inbox ${this.agentId}] could not persist dedup map ${this.mapPath}: ${(err as Error).message}`);
      await fs.rm(tmp, { force: true }).catch(() => {}); // don't leave an orphan temp behind
    }
  }
}

/**
 * Read one event's status directly from the agent's event store, distinguishing a confirmed-absent
 * file from a torn one. The daemon's `ack()` rewrites the event file in place (no temp+rename), so
 * a concurrent read can catch a partial/empty file — that is `unreadable` (retry), NOT `gone`. Only
 * `ENOENT` means the event was actually removed (swept or cleared).
 */
async function readEventStatus(home: string, eventId: string): Promise<ReadResult> {
  const file = path.join(home, 'events', `${eventId}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unreadable';
  }
  try {
    const ev = JSON.parse(raw) as { status?: AgentEventStatus };
    return ev.status ?? 'unreadable';
  } catch {
    return 'unreadable'; // torn/partial write — re-read next tick
  }
}
