/**
 * S7 — production cc-channel inbox (EventStoreInbox). Proofs:
 *  - PUSH goes through the daemon webhook (one POST) and creates exactly one event; delivered is
 *    NOT emitted on the 202 — only when the recipient READS the event, i.e. it reaches
 *    `status: 'delivered'` (the daemon flushed it to a live CC session) OR `status: 'ack'`;
 *  - idempotent across a BRIDGE RESTART: a fresh inbox over the same persisted map re-attaches to
 *    the existing event on a repeat push — no second POST, no duplicate event;
 *  - a lost ack is recovered: a repeat push of an already-acked key re-asserts delivered (no POST);
 *  - `gone` is disambiguated by the recorded ack: a stale-purged / never-acked event is NOT
 *    delivered (dropped, logged, left for the hub to redeliver), while a gone-but-acked event
 *    re-asserts delivered — so a swept pending message is never silently lost;
 *  - a failed webhook push throws (so the hub keeps the message queued) and records nothing;
 *  - close() stops the poller and rejects further pushes.
 *
 * The read-ack poll runs against a REAL EventStore on a temp home (production read path); the
 * daemon webhook is a fake fetch that appends to that same store and returns its event_id.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { assert, section } from './runner.js';
import { EventStore } from '../events.js';
import { EventStoreInbox } from '../messenger/cc/event-store-inbox.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Generous backstop: we wait on the FACT (the ack landed), not a tight window. The read-ack poll
// is a 10ms background interval; in the full suite other files' detached timers contend for the
// event loop, so a tight budget loses the race (pure flake). Standalone this returns in ~ms.
async function waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(5);
  }
  return pred();
}

async function tempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'inbox-home-'));
}

/** A fake daemon webhook: appends the POST body to the agent's real EventStore, returns event_id. */
function fakeDaemon(home: string, agentId: string) {
  const state = { posts: 0 };
  const fetchImpl = (async (_url: string | URL, init?: { body?: unknown }) => {
    state.posts++;
    const body = String(init?.body ?? '');
    const ev = await new EventStore(home).append(agentId, body, 'local-webhook');
    return {
      ok: true,
      status: 202,
      json: async () => ({ ok: true, agent_id: agentId, event_id: ev.id }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, state };
}

await section('inbox: one POST, delivered only on the read-ack', async () => {
  const home = await tempHome();
  const { fetchImpl, state } = fakeDaemon(home, 'nova');
  const acks: string[] = [];
  const inbox = new EventStoreInbox({
    agentId: 'nova',
    home,
    webhookUrl: 'http://d/webhook/tok',
    mapPath: path.join(home, 'map.json'),
    pollIntervalMs: 10,
    fetchImpl,
  });
  inbox.onAck((k) => acks.push(k));

  await inbox.push('m1', '[from leo] hi');
  assert(state.posts === 1, 'exactly one webhook POST');
  await sleep(40);
  assert(acks.length === 0, 'the 202 is not receipt — no delivered yet');

  // The recipient session reads + acks the event → delivered fires once.
  const store = new EventStore(home);
  const open = (await store.list()).find((e) => true)!;
  await store.ack(open.id);
  assert(await waitFor(() => acks.length === 1), 'delivered fires on the read-ack');
  assert(acks[0] === 'm1', 'the ack is correlated to the message id');
  inbox.close();
});

await section('inbox: delivered (not just ack) is a read for a CC agent — fires without an ack', async () => {
  // A Claude Code session never acks: the daemon flushes the event to the live stream (→ `delivered`)
  // and that injection IS the read. The inbox must fire delivered on `delivered`, so delivery never
  // stalls waiting for an ack that will not come — which otherwise left the event un-reported and,
  // after a stale sweep, re-POSTed as a duplicate (the bug this fixes). Driven through a REAL
  // EventStore going pending → delivered.
  const home = await tempHome();
  const mapPath = path.join(home, 'map.json');
  const { fetchImpl, state } = fakeDaemon(home, 'nova');
  const acks: string[] = [];
  const inbox = new EventStoreInbox({ agentId: 'nova', home, webhookUrl: 'http://d/webhook/tok', mapPath, pollIntervalMs: 10, fetchImpl });
  inbox.onAck((k) => acks.push(k));

  await inbox.push('m1', '[from leo] hi');
  const ev = (await new EventStore(home).list())[0]!;
  assert(ev.status === 'pending', 'event starts pending (the 202 is not a read)');

  // The daemon flushes the event to the CC session stream: pending → delivered. No ack is ever sent.
  await new EventStore(home).markDelivered(ev.id);
  assert(await waitFor(() => acks.length === 1 && acks[0] === 'm1'), 'delivered fires on the pending→delivered read (no ack)');

  // The read is recorded durably, so a later retention sweep (gone) re-asserts delivered instead of
  // reading as a non-delivery and re-POSTing a duplicate — the exact duplicate path this closes.
  const persisted = JSON.parse(await fs.readFile(mapPath, 'utf-8')) as Record<string, { acked?: boolean }>;
  assert(persisted.m1?.acked === true, 'a delivered-observed read is persisted (so a gone re-asserts, not re-delivers)');

  await fs.rm(path.join(home, 'events', `${ev.id}.json`), { force: true }); // retention sweep after the read
  await inbox.push('m1', '[from leo] hi'); // hub redelivery
  assert(state.posts === 1, 'a read-then-swept message is NOT re-POSTed as a duplicate');
  assert(await waitFor(() => acks.length === 2), 'the gone-but-read event re-asserts delivered');
  inbox.close();
});

await section('inbox: restart re-attaches via the persisted map — no duplicate event', async () => {
  const home = await tempHome();
  const mapPath = path.join(home, 'map.json');
  const d1 = fakeDaemon(home, 'nova');
  const first = new EventStoreInbox({ agentId: 'nova', home, webhookUrl: 'http://d/webhook/tok', mapPath, pollIntervalMs: 10, fetchImpl: d1.fetchImpl });
  first.onAck(() => {});
  await first.push('m1', '[from leo] hi');
  assert(d1.state.posts === 1, 'first push POSTs once');
  first.close();

  // Simulate a bridge restart: a brand-new inbox over the SAME map + home. The hub redelivers m1.
  const d2 = fakeDaemon(home, 'nova');
  const acks: string[] = [];
  const second = new EventStoreInbox({ agentId: 'nova', home, webhookUrl: 'http://d/webhook/tok', mapPath, pollIntervalMs: 10, fetchImpl: d2.fetchImpl });
  second.onAck((k) => acks.push(k));
  await second.push('m1', '[from leo] hi');
  assert(d2.state.posts === 0, 'restart does NOT re-POST a known message');
  const events = await new EventStore(home).list({ includeAck: true });
  assert(events.length === 1, 'still exactly one event — no duplicate across restart');

  // Still pending → acking it now delivers through the restarted inbox.
  await new EventStore(home).ack(events[0]!.id);
  assert(await waitFor(() => acks.length === 1 && acks[0] === 'm1'), 'delivered after restart on read-ack');
  second.close();
});

await section('inbox: a lost ack is recovered — repeat push of an acked key re-asserts delivered', async () => {
  const home = await tempHome();
  const mapPath = path.join(home, 'map.json');
  const { fetchImpl, state } = fakeDaemon(home, 'nova');
  const acks: string[] = [];
  const inbox = new EventStoreInbox({ agentId: 'nova', home, webhookUrl: 'http://d/webhook/tok', mapPath, pollIntervalMs: 10, fetchImpl });
  inbox.onAck((k) => acks.push(k));

  await inbox.push('m1', '[from leo] hi');
  const ev = (await new EventStore(home).list())[0]!;
  await new EventStore(home).ack(ev.id); // the consumer read-acked; the event is now `ack`.

  // The hub missed our delivered and redelivers m1. The inbox sees the key already acked and
  // re-asserts delivered WITHOUT a second POST. This path is synchronous — it reads the status
  // directly and fires on a microtask — so it never depends on the background poll's cadence.
  await inbox.push('m1', '[from leo] hi');
  assert(state.posts === 1, 'no new POST for an already-known key');
  assert(await waitFor(() => acks.length >= 1), 'a repeat push of an acked key re-asserts delivered (lost-ack recovery)');
  inbox.close();
});

await section('inbox: a stale-purged (gone, never acked) event is NOT delivered — hub redelivers', async () => {
  // The daemon's sweep() removes a NON-acked event once it passes the maxAge cap. That is a message
  // no session ever read — firing delivered on it would silently lose it. The inbox must instead
  // drop the entry, emit no ack, and let the next push (hub redelivery) re-POST a fresh event.
  const home = await tempHome();
  const mapPath = path.join(home, 'map.json');
  const d1 = fakeDaemon(home, 'nova');
  const acks: string[] = [];
  const logs: string[] = [];
  const inbox = new EventStoreInbox({
    agentId: 'nova',
    home,
    webhookUrl: 'http://d/webhook/tok',
    mapPath,
    pollIntervalMs: 10,
    fetchImpl: d1.fetchImpl,
    onError: (m) => logs.push(m),
  });
  inbox.onAck((k) => acks.push(k));

  await inbox.push('m1', '[from leo] hi');
  // Real stale purge: the event is still pending (never acked), so the maxAge cap removes it.
  const swept = await new EventStore(home).sweep({ retentionMs: 60_000, maxAgeMs: 0 });
  assert(swept.purgedStale === 1 && swept.purgedAcked === 0, 'the pending event is stale-purged, not retention-purged');

  await inbox.push('m1', '[from leo] hi'); // hub redelivery sees the event gone
  await sleep(40);
  assert(acks.length === 0, 'a never-acked gone event does NOT fire delivered');
  assert(logs.some((l) => l.includes('NOT delivered')), 'the non-delivery is logged');
  const persisted = JSON.parse(await fs.readFile(mapPath, 'utf-8')) as Record<string, unknown>;
  assert(!('m1' in persisted), 'the undelivered entry is dropped so a fresh push can re-POST');

  // The hub keeps redelivering; the next push is treated as new and re-POSTs a fresh event.
  await inbox.push('m1', '[from leo] hi');
  assert(d1.state.posts === 2, 'redelivery after a stale purge re-POSTs (the message is not lost)');
  inbox.close();
});

await section('inbox: a gone event that WAS acked re-asserts delivered (retention sweep after read)', async () => {
  // The realistic sweep: the session read-acked, then retention removed the event. We recorded the
  // ack, so a later disappearance is delivered-then-swept — re-assert it (recovering a missed ack).
  const home = await tempHome();
  const mapPath = path.join(home, 'map.json');
  const { fetchImpl, state } = fakeDaemon(home, 'nova');
  const acks: string[] = [];
  const inbox = new EventStoreInbox({ agentId: 'nova', home, webhookUrl: 'http://d/webhook/tok', mapPath, pollIntervalMs: 10, fetchImpl });
  inbox.onAck((k) => acks.push(k));

  await inbox.push('m1', '[from leo] hi');
  const ev = (await new EventStore(home).list())[0]!;
  await new EventStore(home).ack(ev.id);
  assert(await waitFor(() => acks.length === 1), 'delivered on the first read-ack');

  // Retention removed the acked event; the hub (having missed our ack) redelivers it.
  await fs.rm(path.join(home, 'events', `${ev.id}.json`), { force: true });
  await inbox.push('m1', '[from leo] hi');
  assert(state.posts === 1, 'no re-POST for a message we already delivered');
  assert(await waitFor(() => acks.length === 2), 'a gone-but-acked event re-asserts delivered');
  const persisted = JSON.parse(await fs.readFile(mapPath, 'utf-8')) as Record<string, { acked?: boolean }>;
  assert(persisted.m1?.acked === true, 'the recorded ack persists so the delivered fact survives');
  inbox.close();
});

await section('inbox: a torn read (unreadable, not ENOENT) does NOT prune — it re-reads', async () => {
  // Regression: the daemon rewrites the event file in place on ack, so a concurrent read can catch
  // a partial file. That is transient `unreadable`, NOT a sweep — the map entry must survive and
  // the poll must re-read, or a redelivery would wrongly re-POST a live message.
  const home = await tempHome();
  const mapPath = path.join(home, 'map.json');
  const { fetchImpl, state } = fakeDaemon(home, 'nova');
  const acks: string[] = [];
  let reads = 0;
  const inbox = new EventStoreInbox({
    agentId: 'nova',
    home,
    webhookUrl: 'http://d/webhook/tok',
    mapPath,
    pollIntervalMs: 10,
    fetchImpl,
    // First observation is a torn read; then the ack is visible.
    readStatus: async () => (++reads <= 1 ? 'unreadable' : 'ack'),
  });
  inbox.onAck((k) => acks.push(k));

  await inbox.push('m1', '[from leo] hi');
  assert(await waitFor(() => acks.length === 1), 'delivered once the torn read clears to ack');
  const persisted = JSON.parse(await fs.readFile(mapPath, 'utf-8')) as Record<string, string>;
  assert('m1' in persisted, 'a torn read did NOT prune the live map entry');

  // A redelivery still re-attaches (no second POST) because the entry survived.
  await inbox.push('m1', '[from leo] hi');
  assert(state.posts === 1, 'no re-POST after a torn read — the message is not duplicated');
  inbox.close();
});

await section('inbox: a read slower than the poll interval does not double-fire the ack', async () => {
  // Regression: if a read outlasts the interval, the next tick must not run concurrently and fire
  // the same key's ack again. Each read here takes ~30ms against a 5ms interval, so several ticks
  // would overlap without the re-entrancy guard.
  const home = await tempHome();
  const { fetchImpl } = fakeDaemon(home, 'nova');
  const acks: string[] = [];
  const inbox = new EventStoreInbox({
    agentId: 'nova',
    home,
    webhookUrl: 'http://d/webhook/tok',
    mapPath: path.join(home, 'map.json'),
    pollIntervalMs: 5,
    fetchImpl,
    readStatus: async () => {
      await sleep(30);
      return 'ack';
    },
  });
  inbox.onAck((k) => acks.push(k));
  await inbox.push('m1', 'x');
  await sleep(200); // several interval ticks elapse during the slow reads
  assert(acks.filter((k) => k === 'm1').length === 1, 'the ack fires exactly once despite overlapping ticks');
  inbox.close();
});

await section('inbox: a failed webhook push throws and records nothing', async () => {
  const home = await tempHome();
  const mapPath = path.join(home, 'map.json');
  const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
  const inbox = new EventStoreInbox({ agentId: 'nova', home, webhookUrl: 'http://d/webhook/tok', mapPath, pollIntervalMs: 10, fetchImpl });
  inbox.onAck(() => {});

  let threw = false;
  try {
    await inbox.push('m1', 'x');
  } catch {
    threw = true;
  }
  assert(threw, 'a non-2xx webhook response throws so the hub keeps the message queued');
  let mapExists = true;
  try {
    await fs.access(mapPath);
  } catch {
    mapExists = false;
  }
  assert(!mapExists, 'nothing is persisted for a failed push');
  inbox.close();
});

await section('inbox: two un-awaited persists do not race on the temp file (concurrent deliveries)', async () => {
  // The bridge bug: a hello and a brief landed ~0.3s apart, so two persists overlapped. With one
  // shared `<file>.tmp`, the first rename moved it and the second hit ENOENT — a lost persist. Fire
  // two pushes WITHOUT awaiting the first, so their persists overlap, and prove both writes land.
  const home = await tempHome();
  const mapPath = path.join(home, 'map.json');
  const { fetchImpl } = fakeDaemon(home, 'nova');
  const errors: string[] = [];
  const inbox = new EventStoreInbox({
    agentId: 'nova',
    home,
    webhookUrl: 'http://d/webhook/tok',
    mapPath,
    pollIntervalMs: 10,
    fetchImpl,
    onError: (m) => errors.push(m),
  });
  inbox.onAck(() => {});

  const p1 = inbox.push('m1', '[from leo] hello');
  const p2 = inbox.push('m2', '[from leo] brief');
  await Promise.all([p1, p2]);

  const persisted = JSON.parse(await fs.readFile(mapPath, 'utf-8')) as Record<string, unknown>;
  assert(persisted.m1 !== undefined && persisted.m2 !== undefined, 'both concurrent writes landed — no lost persist');
  assert(!errors.some((e) => /could not persist/.test(e)), 'neither persist raced on the temp file (no ENOENT)');
  const strays = (await fs.readdir(home)).filter((f) => f.includes('.tmp'));
  assert(strays.length === 0, 'no orphan .tmp files are left behind');
  inbox.close();
});

await section('inbox: close stops the poller and rejects further pushes', async () => {
  const home = await tempHome();
  const { fetchImpl } = fakeDaemon(home, 'nova');
  const inbox = new EventStoreInbox({ agentId: 'nova', home, webhookUrl: 'http://d/webhook/tok', mapPath: path.join(home, 'map.json'), pollIntervalMs: 10, fetchImpl });
  inbox.onAck(() => {});
  inbox.close();
  let threw = false;
  try {
    await inbox.push('m1', 'x');
  } catch {
    threw = true;
  }
  assert(threw, 'push after close rejects');
});
