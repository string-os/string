/**
 * Stall watchdog for live SSE event streams — decision logic isolated from the daemon
 * so it can be unit-tested deterministically.
 *
 * A half-open peer that keeps ACKing at the TCP layer but has stopped READING leaves the
 * daemon's write buffer above its highWaterMark with no drain: `res.writableNeedDrain`
 * stays set. Once that persists past the stall threshold the stream is reaped (unregister
 * + destroy) so later events are not stamped `delivered` to a socket no one is reading.
 *
 * NOTE on testing: this cannot be reproduced faithfully over a loopback socket. On a real
 * network a vanished peer stops ACKing, so the kernel send buffer fills and
 * `writableNeedDrain` stays set. On localhost the peer's kernel keeps ACKing and autotunes
 * its receive buffer into the tens of MiB (this box: tcp_rmem max 32 MiB), so even a peer
 * whose application never reads absorbs enough that `writableNeedDrain` only blips and
 * drains again — the stall never sustains. So the logic is proven here with a fake
 * response whose backpressure we drive directly, and the real-socket backstop is TCP
 * keepalive (see daemon.ts). See string-os/string#47.
 */

/** Carried across heartbeat ticks for one stream. */
export interface StallState {
  /** epoch-ms when the send buffer last went un-drained, or null while the stream is healthy. */
  stalledSince: number | null;
}

/** An http.ServerResponse narrowed to what the watchdog reads. */
export interface ReapTarget {
  writableEnded: boolean;
  destroyed: boolean;
  /** true while the socket's write buffer is above highWaterMark and not draining. */
  writableNeedDrain: boolean;
}

/**
 * Pure stall decision. Given the prior stall onset, whether the stream is backpressured
 * right now, the clock, and the threshold, return the next stall onset and whether to reap.
 *
 *   - not backpressured  → clear the onset, never reap (a healthy stream, even one that
 *                          just sent a big chunk, drains between ticks).
 *   - backpressured, no onset yet → record the onset, hold off.
 *   - backpressured for ≥ stallMs → reap.
 */
export function stallDecision(
  prevStalledSince: number | null,
  backpressured: boolean,
  now: number,
  stallMs: number,
): { stalledSince: number | null; reap: boolean } {
  if (!backpressured) return { stalledSince: null, reap: false };
  const stalledSince = prevStalledSince ?? now;
  return { stalledSince, reap: now - stalledSince >= stallMs };
}

/**
 * One watchdog tick against a live stream. Skips a stream already ended/destroyed,
 * otherwise advances `state` by the stall decision and, when it says reap, runs `onReap`
 * exactly once (in the daemon, onReap unregisters the stream then destroys its socket).
 * Returns true iff it reaped this tick.
 */
export function reapTick(
  res: ReapTarget,
  state: StallState,
  now: number,
  stallMs: number,
  onReap: () => void,
): boolean {
  if (res.writableEnded || res.destroyed) return false;
  const { stalledSince, reap } = stallDecision(state.stalledSince, res.writableNeedDrain, now, stallMs);
  state.stalledSince = stalledSince;
  if (reap) {
    onReap();
    return true;
  }
  return false;
}
