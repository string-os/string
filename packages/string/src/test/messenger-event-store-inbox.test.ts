/**
 * S7 — production cc-channel inbox (EventStoreInbox). Proofs:
 *  - PUSH goes through the daemon webhook (one POST) and creates exactly one event; delivered is
 *    NOT emitted on the 202 — only when the event reaches `status: 'ack'` (the read-ack);
 *  - idempotent across a BRIDGE RESTART: a fresh inbox over the same persisted map re-attaches to
 *    the existing event on a repeat push — no second POST, no duplicate event;
 *  - a lost ack is recovered: a repeat push of an already-acked key re-asserts delivered (no POST);
 *  - a swept event (status gone) is treated as handled — the stale map entry is pruned;
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

await section('inbox: a swept (gone) event is treated as handled and the map entry is pruned', async () => {
  const home = await tempHome();
  const mapPath = path.join(home, 'map.json');
  const { fetchImpl } = fakeDaemon(home, 'nova');
  const acks: string[] = [];
  const inbox = new EventStoreInbox({ agentId: 'nova', home, webhookUrl: 'http://d/webhook/tok', mapPath, pollIntervalMs: 10, fetchImpl });
  inbox.onAck((k) => acks.push(k));

  await inbox.push('m1', '[from leo] hi');
  const ev = (await new EventStore(home).list())[0]!;
  // The daemon's retention sweep removed the event after it was handled.
  await fs.rm(path.join(home, 'events', `${ev.id}.json`), { force: true });

  await inbox.push('m1', '[from leo] hi'); // hub redelivery after the sweep
  assert(await waitFor(() => acks.length >= 1), 'a gone event re-asserts delivered (assumed handled)');
  const persisted = JSON.parse(await fs.readFile(mapPath, 'utf-8')) as Record<string, string>;
  assert(!('m1' in persisted), 'the stale map entry is pruned');
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
