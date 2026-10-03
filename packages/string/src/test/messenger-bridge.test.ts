/**
 * S4b — the hub bridge (agent-box side). Proofs:
 *  - versioned hello handshake; helloOk resolves start, helloReject is fatal (no retry);
 *  - a `deliver` routes to the recipient's adapter and the adapter's delivered ack is relayed;
 *  - human sender => interrupt mode, agent sender => steer;
 *  - redelivery is idempotent — not dispatched twice, and a missed ack is re-asserted;
 *  - an unknown recipient yields an error frame, never a crash;
 *  - outbound send correlates its sendResult;
 *  - a dropped connection reconnects + re-hellos and keeps delivering;
 *  - acks produced while disconnected are flushed on reconnect.
 * Review fixes (Leo, blocking):
 *  - an in-flight delivery is NOT re-dispatched when the hub reconnects (dispatching is kept);
 *  - send() rejects instead of hanging when the link is down for good;
 *  - the delivered-dedup map expires after the TTL and buffered acks dedupe by id.
 * S6c — two-way liveness (the bridge side):
 *  - checkHubLiveness drops the link once the hub is silent past hubSilenceLimitMs, and reconnects;
 *  - any frame heard from the hub resets the silence clock;
 *  - a half-open socket (fake hub stops echoing without closing) is caught by the heartbeat timer,
 *    which drops + reconnects, and recovers when the hub answers again;
 *  - hubSilenceLimitMs = 0 disables the check.
 */
import { assert, section } from './runner.js';
import { Bridge } from '../messenger/hub/bridge.js';
import { FakeHub, FakeInboundAdapter, stamped } from './fake-hub.js';

const tick = (n = 5): Promise<void> => new Promise((r) => setTimeout(r, n));
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Poll `cond` until it holds or the timeout elapses, yielding the loop between checks so pending
 * timers can fire. Used for the heartbeat proofs: a fixed sleep is flaky under a loaded event loop
 * (setInterval ticks get starved), but a generous poll passes as soon as the beats land and only
 * fails if they never do.
 */
async function waitUntil(cond: () => boolean, timeoutMs = 2000, stepMs = 5): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await tick(stepMs);
  }
  return cond();
}

function setup(opts?: { baseBackoffMs?: number; heartbeatIntervalMs?: number; hubSilenceLimitMs?: number; now?: () => number }) {
  const hub = new FakeHub();
  const errors: string[] = [];
  const bridge = new Bridge({
    bridgeId: 'bridge-agentbox',
    machineId: 'agentbox',
    token: 'tok-fake-nova-0000', // obviously-fake fixture
    connect: hub.connect,
    hubSilenceLimitMs: opts?.hubSilenceLimitMs,
    baseBackoffMs: opts?.baseBackoffMs ?? 2,
    maxBackoffMs: 8,
    heartbeatIntervalMs: opts?.heartbeatIntervalMs ?? 0, // off by default in tests
    now: opts?.now,
    onError: (r) => errors.push(r),
  });
  const adapter = new FakeInboundAdapter((a) => bridge.reportAck(a));
  bridge.register('nova', adapter);
  return { hub, bridge, adapter, errors };
}

await section('bridge: versioned hello handshake resolves start', async () => {
  const { hub, bridge } = setup();
  await bridge.start();
  assert(hub.hellos.length === 1, 'sent exactly one hello');
  assert(hub.hellos[0]?.token === 'tok-fake-nova-0000', 'hello carried the capability token');
  assert(hub.hellos[0]?.protocolVersion === '0.4.0', 'hello carried protocol 0.4.0');
  await bridge.close();
});

await section('bridge: deliver routes to the recipient adapter and relays the delivered ack', async () => {
  const { hub, bridge, adapter } = setup();
  await bridge.start();
  hub.deliver(stamped('m1', 'leo', 'nova', 'do the thing'));
  await tick();
  assert(adapter.delivered.length === 1 && adapter.delivered[0]?.id === 'm1', 'adapter got the message');
  assert(adapter.delivered[0]?.body === 'do the thing', 'body passed through');
  assert(hub.acks.some((a) => a.messageId === 'm1' && a.state === 'delivered'), 'delivered ack relayed to hub');
  await bridge.close();
});

await section('bridge: human sender gets interrupt mode, agent sender gets steer', async () => {
  const { hub, bridge, adapter } = setup();
  await bridge.start();
  hub.deliver(stamped('m1', 'leo', 'nova', 'agent msg'));
  hub.deliver(stamped('m2', 'founder', 'nova', 'human msg'));
  await tick();
  assert(adapter.modes[0] === 'steer', 'agent sender => steer');
  assert(adapter.modes[1] === 'interrupt', 'founder (human) => interrupt');
  await bridge.close();
});

await section('bridge: redelivery is idempotent — no second dispatch, ack re-asserted', async () => {
  const { hub, bridge, adapter } = setup();
  await bridge.start();
  hub.deliver(stamped('m1', 'leo', 'nova', 'once'));
  await tick();
  assert(adapter.delivered.length === 1, 'dispatched once');
  assert(hub.acks.filter((a) => a.messageId === 'm1').length === 1, 'acked once');

  hub.deliver(stamped('m1', 'leo', 'nova', 'once')); // hub redelivered (missed our ack)
  await tick();
  assert(adapter.delivered.length === 1, 'NOT dispatched a second time');
  assert(hub.acks.filter((a) => a.messageId === 'm1').length === 2, 're-asserted the delivered ack');
  await bridge.close();
});

await section('bridge: unknown recipient yields an error frame, not a crash', async () => {
  const { hub, bridge, adapter } = setup();
  await bridge.start();
  hub.deliver(stamped('m9', 'leo', 'ghost', 'nobody home'));
  await tick();
  assert(adapter.delivered.length === 0, 'nothing delivered to the registered adapter');
  assert(hub.errors.some((e) => e.ref === 'm9' && /no adapter/.test(e.reason)), 'hub told: no adapter for recipient');
  await bridge.close();
});

await section('bridge: outbound send correlates its sendResult', async () => {
  const { hub, bridge } = setup();
  await bridge.start();
  const outcome = await bridge.send('nova', { to: 'leo', body: 'reporting in' });
  assert(outcome.state === 'accepted' && typeof outcome.messageId === 'string', 'got the hub-assigned result');
  assert(hub.sends.some((s) => s.from === 'nova' && s.to === 'leo' && s.body === 'reporting in'), 'hub saw the send');
  await bridge.close();
});

await section('bridge: a dropped connection reconnects, re-hellos, and keeps delivering', async () => {
  const { hub, bridge, adapter } = setup();
  await bridge.start();
  hub.drop();
  await tick(20); // let the backoff reconnect + re-hello
  hub.deliver(stamped('m1', 'leo', 'nova', 'after reconnect'));
  await tick();
  assert(hub.hellos.length >= 2, 're-hello after reconnect');
  assert(adapter.delivered.some((m) => m.id === 'm1'), 'delivered after reconnect');
  await bridge.close();
});

await section('bridge: helloReject is fatal — start rejects and there is no retry', async () => {
  const { hub, bridge, errors } = setup();
  hub.rejectHello = 'unknown token';
  let threw = false;
  try {
    await bridge.start();
  } catch (e) {
    threw = true;
    assert(/unknown token/.test((e as Error).message), 'start rejected with the hub reason');
  }
  assert(threw, 'start did not silently succeed on a refused hello');
  await tick(20);
  assert(hub.hellos.length === 1, 'did not retry a refused hello');
  assert(errors.some((r) => /unknown token/.test(r)), 'surfaced the refusal via onError');
  await bridge.close();
});

await section('bridge: acks produced while disconnected are flushed on reconnect', async () => {
  const { hub, bridge, adapter } = setup();
  adapter.autoDeliver = false; // ack by hand
  await bridge.start();
  hub.deliver(stamped('m1', 'leo', 'nova', 'slow handling'));
  await tick();
  assert(hub.acks.length === 0, 'not acked yet (session still handling)');

  hub.drop();
  await tick(); // bridge observes the drop
  adapter.ack('m1'); // the read-ack lands while the bridge is reconnecting → buffered
  await tick(20); // reconnect + flush
  assert(hub.acks.some((a) => a.messageId === 'm1' && a.state === 'delivered'), 'buffered ack flushed after reconnect');
  await bridge.close();
});

await section('bridge/review: an in-flight delivery is not re-dispatched when the hub reconnects', async () => {
  const { hub, bridge, adapter } = setup();
  adapter.autoDeliver = false; // the adapter is still handling the turn when the link drops
  await bridge.start();
  hub.deliver(stamped('m1', 'leo', 'nova', 'long turn'));
  await tick();
  assert(adapter.delivered.length === 1, 'dispatched once');

  hub.drop(); // link dies mid-delivery
  await tick(20); // reconnect + re-hello
  hub.deliver(stamped('m1', 'leo', 'nova', 'long turn')); // hub redelivers the still-unacked message
  await tick();
  assert(adapter.delivered.length === 1, 'NOT dispatched again — dispatching kept across the reconnect');

  adapter.ack('m1'); // the original handling finally completes
  await tick();
  assert(adapter.delivered.length === 1, 'still a single dispatch after the ack lands');
  assert(hub.acks.filter((a) => a.messageId === 'm1').length === 1, 'acked exactly once');
  await bridge.close();
});

await section('bridge/review: send() rejects instead of hanging when the link is down for good', async () => {
  const { hub, bridge } = setup();
  await bridge.start();
  hub.rejectHello = 'revoked'; // the reconnect will be refused → fatal, link stays down
  hub.drop();
  await tick(20); // reconnect attempt → helloReject → fatal, no link
  let threw = false;
  try {
    await bridge.send('nova', { to: 'leo', body: 'into the void' });
  } catch {
    threw = true;
  }
  assert(threw, 'send rejected rather than hanging on a dead link');
  await bridge.close();
});

await section('bridge/review: the delivered-dedup map forgets ids after the TTL', async () => {
  let nowMs = 1_000_000;
  const { hub, bridge, adapter } = setup({ now: () => nowMs });
  await bridge.start();
  hub.deliver(stamped('m1', 'leo', 'nova', 'first'));
  await tick();
  assert(adapter.delivered.length === 1, 'dispatched once');

  hub.deliver(stamped('m1', 'leo', 'nova', 'first')); // redelivery within the TTL
  await tick();
  assert(adapter.delivered.length === 1, 'within TTL: re-asserted, not re-dispatched');

  nowMs += DAY_MS + 1; // a day and a tick later the id is forgotten
  hub.deliver(stamped('m1', 'leo', 'nova', 'first, a day later'));
  await tick();
  assert(adapter.delivered.length === 2, 'past TTL: treated as new (map pruned, so no unbounded growth)');
  await bridge.close();
});

await section('bridge/review: buffered acks dedupe by id — not one per re-assert', async () => {
  const { hub, bridge, adapter } = setup();
  adapter.autoDeliver = false;
  await bridge.start();
  hub.deliver(stamped('m1', 'leo', 'nova', 'handle me'));
  await tick();

  hub.pauseConnects(); // keep the bridge offline across the ack burst (reconnect is otherwise immediate)
  hub.drop();
  await tick(); // bridge observes the drop and is now held offline reconnecting
  adapter.ack('m1');
  adapter.ack('m1');
  adapter.ack('m1'); // three read-acks buffered while reconnecting
  hub.resumeConnects();
  await tick(20); // reconnect + flush
  assert(hub.acks.filter((a) => a.messageId === 'm1').length === 1, 'exactly one ack flushed, deduped by id');
  await bridge.close();
});

await section('bridge/S6: heartbeats are sent periodically once connected and stop on close', async () => {
  const { hub, bridge } = setup({ heartbeatIntervalMs: 4, hubSilenceLimitMs: 0 }); // emission only; silence off
  await bridge.start();
  assert(await waitUntil(() => hub.heartbeats.length >= 3), 'several heartbeats sent while connected');
  assert(hub.heartbeats.every((h) => h.machineId === 'agentbox'), 'heartbeats carry the machine id');
  assert(hub.heartbeats.every((h) => typeof h.atMs === 'number'), 'heartbeats carry a timestamp');

  await bridge.close();
  const afterClose = hub.heartbeats.length;
  await tick(40); // close() clears the timer synchronously, so no further beat can land
  assert(hub.heartbeats.length === afterClose, 'heartbeats stop after close');
});

await section('bridge/S6: a dropped connection stops heartbeats, reconnect resumes them', async () => {
  const { hub, bridge } = setup({ heartbeatIntervalMs: 4, baseBackoffMs: 2, hubSilenceLimitMs: 0 }); // emission only
  await bridge.start();
  assert(await waitUntil(() => hub.heartbeats.length >= 1), 'beating before the drop');
  hub.drop();
  const atDrop = hub.heartbeats.length;
  assert(await waitUntil(() => hub.heartbeats.length > atDrop), 'heartbeats resume after the bridge reconnects');
  await bridge.close();
});

await section('bridge/S6: heartbeatIntervalMs = 0 disables heartbeats', async () => {
  const { hub, bridge } = setup({ heartbeatIntervalMs: 0 });
  await bridge.start();
  await tick(60); // a generous window; with the beat disabled none should ever land
  assert(hub.heartbeats.length === 0, 'no heartbeats when disabled');
  await bridge.close();
});

await section('bridge/S6c: checkHubLiveness drops a hub-silent link past the limit, then reconnects', async () => {
  // Deterministic: inject the clock and drive the check by hand (heartbeat timer off, so nothing
  // echoes to reset the silence clock behind our back). lastHeardMs is baselined at connect.
  let nowMs = 1_000_000;
  const { hub, bridge, errors } = setup({ hubSilenceLimitMs: 100, now: () => nowMs });
  await bridge.start();
  assert(hub.connected, 'connected after hello');

  nowMs += 99; // just under the limit since the hello was heard
  assert(bridge.checkHubLiveness() === false, 'under the limit: no drop');
  assert(hub.connected, 'still connected under the limit');

  hub.pauseConnects(); // hold the reconnect so we can observe the link actually down
  const hellosBefore = hub.hellos.length;
  nowMs += 2; // 101ms of silence ≥ the 100ms limit
  assert(bridge.checkHubLiveness() === true, 'past the limit: the silent link is dropped');
  await tick(); // detachAndReconnect runs; reconnectLoop is held at the gated connect
  assert(!hub.connected, 'link is down (reconnect is gated)');
  assert(errors.some((e) => /hub silent/.test(e)), 'surfaced the silence via onError');

  hub.resumeConnects();
  assert(await waitUntil(() => hub.hellos.length > hellosBefore), 'reconnected with a fresh hello');
  await bridge.close();
});

await section('bridge/S6c: a frame heard within the window resets the silence clock', async () => {
  let nowMs = 500_000;
  const { hub, bridge } = setup({ hubSilenceLimitMs: 100, now: () => nowMs });
  await bridge.start();

  nowMs += 90; // nearly silent...
  hub.deliver(stamped('m1', 'leo', 'nova', 'still here')); // ...then a frame arrives
  await tick(); // the deliver is processed → lastHeardMs reset to now
  nowMs += 90; // 90ms since that frame, < 100
  assert(bridge.checkHubLiveness() === false, 'a frame heard within the window keeps the link alive');

  nowMs += 100; // now 190ms since the last frame, ≥ the limit
  assert(bridge.checkHubLiveness() === true, 'genuine silence after the last frame still trips the drop');
  await bridge.close();
});

await section('bridge/S6c: a half-open socket (hub stops echoing, no close) is dropped + reconnected', async () => {
  // End-to-end through the real heartbeat timer: prove a fake hub that goes silent WITHOUT closing
  // is detected and recovered from. The limit is widened well past 3× the interval so a loaded event
  // loop cannot false-trip while the hub is still answering (the exact 3× default is pinned by the
  // injected-clock section above).
  const { hub, bridge } = setup({ heartbeatIntervalMs: 15, hubSilenceLimitMs: 200, baseBackoffMs: 2 });
  await bridge.start();
  assert(await waitUntil(() => hub.heartbeats.length >= 2), 'beating with a responsive (echoing) hub');

  const hellosBefore = hub.hellos.length;
  hub.goSilent(); // half-open: stop answering heartbeats, keep the socket open
  assert(await waitUntil(() => hub.hellos.length > hellosBefore, 3000), 'silence detected → link dropped and re-helloed');

  hub.goLoud(); // the hub answers again
  const beatsAtRecovery = hub.heartbeats.length;
  assert(await waitUntil(() => hub.heartbeats.length > beatsAtRecovery, 3000), 'heartbeats resume once the hub answers again');
  await bridge.close();
});

await section('bridge/S6c: a half-open socket whose close() never fires onClose still reconnects', async () => {
  // The real hazard: on a half-open socket close() may not fire onClose until a TCP timeout. The
  // silence path must detach LOCALLY (not wait on the close handshake), so reconnect proceeds even
  // though the dead link's onClose never arrives.
  let nowMs = 2_000_000;
  const { hub, bridge } = setup({ hubSilenceLimitMs: 100, now: () => nowMs });
  hub.swallowClientClose = true; // client links mark closed but never invoke onClose
  await bridge.start();
  const hellosBefore = hub.hellos.length;

  nowMs += 101; // silent past the limit
  assert(bridge.checkHubLiveness() === true, 'silence tripped the drop');
  assert(await waitUntil(() => hub.hellos.length > hellosBefore), 'reconnected without waiting on the (never-firing) close handshake');
  await bridge.close();
});

await section('bridge/S6c: a stale link closing late does not tear down the reconnected link', async () => {
  // After a local detach + reconnect, the OLD link's onClose can still fire. The bridge guards each
  // link's onClose by identity, so that late callback is a no-op and the fresh link survives.
  let nowMs = 3_000_000;
  const { hub, bridge, adapter } = setup({ hubSilenceLimitMs: 100, now: () => nowMs });
  await bridge.start();
  const hellosBefore = hub.hellos.length;

  nowMs += 101;
  assert(bridge.checkHubLiveness() === true, 'silence tripped the drop');
  assert(await waitUntil(() => hub.hellos.length > hellosBefore), 'reconnected on a fresh link');
  // The dead link's onClose fired (best-effort close above); the fresh link must still deliver.
  await tick();
  hub.deliver(stamped('mx', 'leo', 'nova', 'after a late stale close'));
  assert(await waitUntil(() => adapter.delivered.some((m) => m.id === 'mx')), 'fresh link still delivers (stale onClose ignored)');
  await bridge.close();
});

await section('bridge/S6c: hubSilenceLimitMs = 0 disables the silence check', async () => {
  let nowMs = 0;
  const { hub, bridge } = setup({ hubSilenceLimitMs: 0, now: () => nowMs });
  await bridge.start();
  nowMs += 10_000_000; // an eternity of silence
  assert(bridge.checkHubLiveness() === false, 'never trips when disabled');
  assert(hub.connected, 'link left untouched');
  await bridge.close();
});
