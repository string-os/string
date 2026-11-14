/**
 * Unit tests for the SSE stall watchdog (event-stream-reaper.ts). The reaper tears down a
 * half-open stream — a peer still ACKing at the TCP layer but no longer reading — so later
 * events are not stamped `delivered` to a socket no one drains. That condition cannot be
 * reproduced over a real loopback socket (the peer's kernel keeps ACKing and autotunes its
 * receive buffer into the tens of MiB, so writableNeedDrain never stays set), so the logic
 * is proven here by driving a fake response's backpressure directly. See string-os/string#47.
 */
import { assert, section } from './runner.js';
import { stallDecision, reapTick, type StallState, type ReapTarget } from '../event-stream-reaper.js';

await section('reaper — stallDecision: a healthy (draining) stream never reaps and clears the onset', async () => {
  // Not backpressured: onset clears, no reap — even if an onset was previously armed.
  assert(JSON.stringify(stallDecision(null, false, 1000, 400)) === JSON.stringify({ stalledSince: null, reap: false }),
    'healthy with no prior onset → {null,false}');
  assert(JSON.stringify(stallDecision(500, false, 1000, 400)) === JSON.stringify({ stalledSince: null, reap: false }),
    'a prior onset is cleared the moment the stream drains (the blip resets)');
});

await section('reaper — stallDecision: backpressure arms the onset, then reaps once it outlives stallMs', async () => {
  // First backpressured tick arms the onset at `now`, does not reap yet.
  assert(JSON.stringify(stallDecision(null, true, 1000, 400)) === JSON.stringify({ stalledSince: 1000, reap: false }),
    'first stalled tick arms the onset, no reap yet');
  // Still within the window: keep the original onset, no reap.
  assert(JSON.stringify(stallDecision(1000, true, 1399, 400)) === JSON.stringify({ stalledSince: 1000, reap: false }),
    'within stallMs: onset held, no reap');
  // Exactly at the threshold reaps (>=).
  assert(JSON.stringify(stallDecision(1000, true, 1400, 400)) === JSON.stringify({ stalledSince: 1000, reap: true }),
    'at exactly stallMs: reap');
  // Past the threshold reaps.
  assert(JSON.stringify(stallDecision(1000, true, 5000, 400)) === JSON.stringify({ stalledSince: 1000, reap: true }),
    'past stallMs: reap');
});

await section('reaper — reapTick: a transient backpressure blip resets and never reaps', async () => {
  const res: ReapTarget = { writableEnded: false, destroyed: false, writableNeedDrain: false };
  const state: StallState = { stalledSince: null };
  let reapCount = 0;
  const onReap = () => { reapCount++; };

  // t=0 healthy
  assert(reapTick(res, state, 0, 400, onReap) === false && state.stalledSince === null, 'healthy tick: no onset');
  // t=100 backpressure begins (arms onset)
  res.writableNeedDrain = true;
  assert(reapTick(res, state, 100, 400, onReap) === false && state.stalledSince === 100, 'onset armed at 100');
  // t=200 still stalled, under window
  assert(reapTick(res, state, 200, 400, onReap) === false && state.stalledSince === 100, 'onset held at 100');
  // t=300 drains before the window elapses — the blip resets
  res.writableNeedDrain = false;
  assert(reapTick(res, state, 300, 400, onReap) === false && state.stalledSince === null, 'drain resets the onset');
  // t=1000 healthy throughout afterward
  assert(reapTick(res, state, 1000, 400, onReap) === false && state.stalledSince === null, 'stays healthy');
  assert(reapCount === 0, 'a stream that drained between ticks is never reaped');
});

await section('reaper — reapTick: a sustained stall makes the heartbeat unregister + destroy the stream once', async () => {
  // Model the daemon's exact onReap wiring: unregister the stream from the live set, then
  // destroy its socket. (In daemon.ts: close() deletes from eventStreams, then res.destroy().)
  let destroyCount = 0;
  const res = {
    writableEnded: false,
    destroyed: false,
    writableNeedDrain: true, // peer stopped reading: backpressured every tick
    destroy() { this.destroyed = true; destroyCount++; },
  };
  const streams = new Set<typeof res>([res]);
  const state: StallState = { stalledSince: null };
  const onReap = () => {
    streams.delete(res);   // unregister first — no further push targets this stream
    res.destroy();         // then tear the socket down
  };

  const STALL = 400;
  // Heartbeat samples every 100ms. Onset arms at t=0; reap fires at the first tick >= 400ms.
  assert(reapTick(res, state, 0, STALL, onReap) === false, 't=0 arms, no reap');
  assert(reapTick(res, state, 100, STALL, onReap) === false, 't=100 no reap');
  assert(reapTick(res, state, 200, STALL, onReap) === false, 't=200 no reap');
  assert(reapTick(res, state, 300, STALL, onReap) === false, 't=300 no reap');
  assert(streams.has(res) && !res.destroyed, 'before the window elapses the stream is still registered and live');

  const reaped = reapTick(res, state, 400, STALL, onReap); // window elapsed
  assert(reaped === true, 't=400 reaps');
  // (a) unregistered and (b) socket destroyed — the two effects the heartbeat must produce.
  assert(!streams.has(res), 'reaped stream was unregistered from the live set');
  assert(res.destroyed && destroyCount === 1, 'reaped stream socket was destroyed exactly once');

  // A later tick is a no-op: reapTick skips an already-destroyed stream (no double destroy).
  assert(reapTick(res, state, 500, STALL, onReap) === false, 'destroyed stream: subsequent tick is a no-op');
  assert(destroyCount === 1, 'no double destroy');
});

await section('reaper — reapTick: an already-ended stream is skipped (no onset, no reap)', async () => {
  const res: ReapTarget = { writableEnded: true, destroyed: false, writableNeedDrain: true };
  const state: StallState = { stalledSince: null };
  let reapCount = 0;
  assert(reapTick(res, state, 1000, 400, () => { reapCount++; }) === false, 'ended stream: no reap');
  assert(state.stalledSince === null && reapCount === 0, 'ended stream: untouched');
});
