/**
 * Shared test harness for starting a String daemon.
 *
 * Two problems this centralizes (previously copy-pasted, subtly, into several test files):
 *
 *  1. PORT COLLISION (#91). Each file picked a random port in a shared range, so across the suite's
 *     many daemon sections — and daemons leaked by a failed teardown — two sections could collide on
 *     a port, and a blind readiness `ping` then SUCCEEDED against a FOREIGN daemon (wrong data dir /
 *     wrong agents), tripping asserts intermittently. This fixes it on two axes:
 *       - the port is a kernel-confirmed FREE port (`listen(0)` on a throwaway socket, then closed),
 *         so a fresh one is almost never already taken; and
 *       - readiness is gated on OUR child daemon's OWN stdout ("stringd listening on …:<port>"),
 *         never a blind ping. A squatter that wins the close→bind race makes our child fail to bind
 *         (EADDRINUSE) and exit — which we detect and RETRY on a new free port — and can never make
 *         *our* child print that line. So "up" provably means our own daemon is up on our own port.
 *     The daemon is started on that EXPLICIT port (not port 0): the daemon trusts its own STRING_PORT
 *     for self-referential work (e.g. the webhook URLs it hands back when an agent is created), so
 *     its STRING_PORT must equal the port it actually bound — which an OS-assigned port 0 could not
 *     guarantee without a daemon code change.
 *
 *  2. LEAKED DAEMONS. A test's own `finally { daemon.stop() }` does not run if the test process is
 *     killed or crashes mid-section, so strays accumulate across runs and squat ports. Every live
 *     daemon registers its killer in a process-exit/signal reaper, so an abnormal exit still reaps
 *     it; a clean stop() deregisters first so the reaper never double-kills.
 */
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../cli.ts');

/** Attempts to find a port a daemon can bind before giving up (each lost to a bind race). */
const MAX_ATTEMPTS = 5;
/** How long to wait for one daemon start to report its listening port before abandoning it. */
const START_TIMEOUT_MS = 30_000;

/**
 * A valid, non-live placeholder port for a freshly-built test Env, before startDaemon() replaces it
 * with a verified free port. It must NOT be 0/unset: `resolveDaemonPort` treats an invalid STRING_PORT
 * as a hard error, and a CLI child in a no-daemon section would otherwise have no port. It must NOT
 * be a live shared port. This value is never bound — startDaemon overwrites it for any real daemon,
 * and no-daemon CLI grammar checks never dial it.
 */
export const HARNESS_PLACEHOLDER_PORT = 59999;

/** The live shared daemon ports on this box. A test must NEVER target them (2026-10-03 incident). */
const LIVE_PORTS = new Set([3923, 3100, 3931]);

/**
 * Throw unless `base` is safe to run a test daemon / CLI child against. This is the backstop for the
 * whole 3923-fallback class: `resolveDaemonPort` already turns an invalid STRING_PORT into a hard
 * error, and this additionally refuses the LIVE ports and any env that would resolve the real
 * ~/.string. Call it before spawning any daemon or CLI child.
 */
export function assertIsolatedEnv(base: NodeJS.ProcessEnv): void {
  const raw = base.STRING_PORT;
  const n = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(
      `test env not isolated: STRING_PORT=${JSON.stringify(raw)} is unset/invalid and would resolve ` +
        `to the live default 3923. A test must set an explicit free port (use the harness).`,
    );
  }
  if (LIVE_PORTS.has(n)) {
    throw new Error(`test env not isolated: STRING_PORT=${n} is a LIVE shared daemon port; tests must never target it.`);
  }
  // State: the daemon/CLI must resolve a sandbox, never the real ~/.string. If STRING_ROOT or
  // STRING_DATA_DIR is set, it is the sandbox base (must be outside ~/.string); if NEITHER is set,
  // resolution falls back to HOME/.string, so HOME must be a sandbox, not the real home.
  const realString = path.join(os.homedir(), '.string');
  const underRealString = (p?: string): boolean => {
    if (!p || !p.trim()) return false;
    const rel = path.relative(realString, path.resolve(p.trim()));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const root = base.STRING_ROOT?.trim();
  const dataDir = base.STRING_DATA_DIR?.trim();
  if (underRealString(root) || underRealString(dataDir)) {
    throw new Error(`test env not isolated: STRING_ROOT/STRING_DATA_DIR resolves inside the real ${realString}.`);
  }
  if (!root && !dataDir) {
    const home = base.HOME?.trim();
    if (!home || path.resolve(home) === path.resolve(os.homedir())) {
      throw new Error(
        `test env not isolated: no STRING_ROOT/STRING_DATA_DIR set and HOME is the real home, ` +
          `so the daemon would use the real ${realString}.`,
      );
    }
  }
}

/** The slice of a test's Env that starting a daemon needs: a port slot and the child's spawn env. */
export interface DaemonEnv {
  port: number;
  base: NodeJS.ProcessEnv;
}

export interface DaemonHandle {
  /** Kill the daemon's whole process group; idempotent and safe to call from a `finally`. */
  stop: () => void;
}

/** An OS-assigned free TCP port: the kernel confirms it is unbound, so it is almost never taken. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('could not resolve a free port'))));
    });
  });
}

// Every live test daemon registers its killer here so a crash or signal that skips the test's own
// finally still reaps it — strays cannot accumulate across runs. A clean stop() removes its entry.
const liveDaemons = new Set<() => void>();
let reaperInstalled = false;
function installReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;
  const reap = (): void => {
    for (const kill of liveDaemons) {
      try {
        kill();
      } catch {
        /* already gone */
      }
    }
  };
  process.once('exit', reap);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(sig, () => {
      reap();
      process.exit(1);
    });
  }
}

/**
 * Start a String daemon for a test on a fresh free port, retrying on a lost bind race. Readiness is
 * confirmed from the daemon's own stdout, so it can only ever mean OUR daemon on OUR port (see the
 * file header). Mutates `env.port` and `env.base.STRING_PORT` to the chosen port, so both in-process
 * client calls (via `env.port`) and spawned CLI invocations (which read `STRING_PORT` from
 * `env.base`) target this exact daemon. Throws only if no attempt comes up — a broken environment.
 */
export async function startDaemon(env: DaemonEnv, extraEnv: NodeJS.ProcessEnv = {}): Promise<DaemonHandle> {
  installReaper();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const port = await freePort();
    env.port = port;
    env.base.STRING_PORT = String(port);
    const spawnEnv = { ...env.base, ...extraEnv };
    assertIsolatedEnv(spawnEnv); // never start a daemon against a live port or the real ~/.string
    const child = spawn('npx', ['tsx', CLI, '--daemon', 'foreground', String(port)], {
      env: spawnEnv,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const killer = (): void => {
      try {
        process.kill(-child.pid!);
      } catch {
        /* already gone */
      }
    };
    const stop = (): void => {
      liveDaemons.delete(killer);
      killer();
    };
    liveDaemons.add(killer);

    // Resolve true only when OUR child prints that it bound OUR port; false if it exits first (a
    // lost bind race → retry on a fresh port) or never reports in time.
    const listening = `stringd listening on http://127.0.0.1:${port}`;
    const up = await new Promise<boolean>((resolve) => {
      let out = '';
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout?.removeListener('data', onData);
        child.removeListener('exit', onExit);
        // Keep draining both streams so the daemon's later writes never fill a pipe and block it.
        child.stdout?.resume();
        child.stderr?.resume();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), START_TIMEOUT_MS);
      const onData = (chunk: Buffer): void => {
        out += chunk.toString('utf-8');
        if (out.includes(listening)) finish(true);
      };
      const onExit = (): void => finish(false);
      child.stdout?.on('data', onData);
      child.stderr?.resume();
      child.once('exit', onExit);
    });

    if (up) {
      child.unref();
      return { stop };
    }
    stop(); // tear down the failed attempt before retrying so it can't leak and squat the port
  }
  throw new Error(`daemon did not come up after ${MAX_ATTEMPTS} attempts on fresh free ports`);
}
