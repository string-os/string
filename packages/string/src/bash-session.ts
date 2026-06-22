/**
 * String — Persistent Bash Session (PTY-based)
 *
 * Spawns a long-lived bash process via node-pty. Commands are sent to stdin
 * and delimited by a unique marker to capture output per-turn.
 *
 * Output format returned to AI:
 *   exit: <code> | cwd: <path>
 *   ---
 *   <stdout content>
 */

import crypto from 'crypto';

// ─── PTY dynamic import types ────────────────────────────────────────────────

interface PtyHandle {
  pid: number;
  write: (data: string) => void;
  onData: (cb: (data: string) => void) => { dispose: () => void } | void;
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => { dispose: () => void } | void;
  kill: (signal?: string) => void;
  resize: (cols: number, rows: number) => void;
}

interface PtyModule {
  spawn?: (file: string, args: string[], opts: Record<string, unknown>) => PtyHandle;
  default?: {
    spawn?: (file: string, args: string[], opts: Record<string, unknown>) => PtyHandle;
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MARKER_PREFIX = '__STRING_END_';
const CMD_TIMEOUT_MS = 120_000;
const COLS = 200;
const ROWS = 24;

// ─── BashSession ─────────────────────────────────────────────────────────────

export class BashSession {
  private _pty: PtyHandle | null = null;
  private _alive = false;
  private _cwd: string;
  private readonly _initialCwd: string;

  // Pending command state
  private _buffer = '';
  private _pendingResolve: ((output: string) => void) | null = null;
  private _pendingMarker: string | null = null;
  private _pendingTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(cwd: string) {
    this._cwd = cwd;
    this._initialCwd = cwd;
  }

  get alive(): boolean {
    return this._alive;
  }

  get cwd(): string {
    return this._cwd;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async spawn(): Promise<void> {
    if (this._alive) return;

    const mod = (await import('@lydell/node-pty')) as unknown as PtyModule;
    const ptySpawn = mod.spawn ?? mod.default?.spawn;
    if (!ptySpawn) {
      throw new Error('PTY unavailable: @lydell/node-pty spawn not found.');
    }

    this._pty = ptySpawn('/bin/bash', ['--norc', '--noprofile'], {
      cwd: this._initialCwd,
      env: {
        ...process.env,
        HOME: this._initialCwd,
        TERM: 'dumb',
        PS1: '',
        PS2: '',
        PROMPT_COMMAND: '',
        HISTFILE: '',
        BASH_SILENCE_DEPRECATION_WARNING: '1',
      },
      cols: COLS,
      rows: ROWS,
      name: 'dumb',
    });

    this._alive = true;

    this._pty.onData((data: string) => {
      this._onData(data);
    });

    this._pty.onExit(() => {
      this._alive = false;
      // Resolve any pending command
      if (this._pendingResolve) {
        this._pendingResolve(this._buffer);
        this._pendingResolve = null;
        this._pendingMarker = null;
        this._clearTimeout();
      }
    });

    // Disable PTY echo + wait for shell to be ready
    await this._probe();
  }

  close(): void {
    if (this._pty) {
      this._alive = false;
      try { this._pty.kill(); } catch { /* ignore */ }
      this._pty = null;
    }
    this._clearTimeout();
    if (this._pendingResolve) {
      this._pendingResolve(this._buffer);
      this._pendingResolve = null;
    }
  }

  // ── Command execution ─────────────────────────────────────────────────────

  async exec(command: string, timeoutMs = CMD_TIMEOUT_MS): Promise<{
    ok: boolean;
    exitCode: number;
    cwd: string;
    output: string;
  }> {
    if (!this._alive || !this._pty) {
      throw new Error('Bash session is not running.');
    }

    const nonce = crypto.randomBytes(8).toString('hex');
    const marker = `${MARKER_PREFIX}${nonce}`;

    // Build the command sequence:
    // 1. Run the user command
    // 2. Capture exit code in __string_ec
    // 3. Print marker line: MARKER|exitcode|cwd
    const wrappedCmd =
      `${command}\n` +
      `__string_ec=$?\n` +
      `echo ""\n` +
      `echo "${marker}|$__string_ec|$(pwd)"\n`;

    const raw = await this._sendAndWait(wrappedCmd, marker, timeoutMs);

    // Parse marker line: __STRING_END_<nonce>|<exitcode>|<cwd>
    const markerIdx = raw.lastIndexOf(marker);
    let exitCode = 0;
    let cwd = this._cwd;

    if (markerIdx !== -1) {
      const markerLine = raw.slice(markerIdx).split('\n')[0].trim();
      // Format: __STRING_END_<nonce>|<exitcode>|<cwd>
      const parts = markerLine.split('|');
      if (parts.length >= 3) {
        exitCode = parseInt(parts[1], 10) || 0;
        cwd = parts.slice(2).join('|').trim();
        if (cwd) this._cwd = cwd;
      }
    }

    // Extract output: everything before the marker, minus the echoed command
    let output = markerIdx !== -1 ? raw.slice(0, markerIdx) : raw;
    output = this._cleanOutput(output, wrappedCmd);

    return {
      ok: exitCode === 0,
      exitCode,
      cwd: this._cwd,
      output: output.trimEnd(),
    };
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _onData(data: string): void {
    this._buffer += data;

    // Check if marker has arrived (only when we're waiting for one)
    if (this._pendingResolve && this._pendingMarker) {
      // Need the full marker line (marker + data after it + newline)
      const markerIdx = this._buffer.indexOf(this._pendingMarker);
      if (markerIdx !== -1) {
        // Wait for newline after marker to ensure we get the full line
        const afterMarker = this._buffer.indexOf('\n', markerIdx);
        if (afterMarker !== -1) {
          const output = this._buffer.slice(0, afterMarker);
          this._buffer = this._buffer.slice(afterMarker + 1);
          this._clearTimeout();
          const resolve = this._pendingResolve;
          this._pendingResolve = null;
          this._pendingMarker = null;
          resolve(output);
        }
      }
    }
  }

  private _sendAndWait(cmd: string, marker: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve) => {
      // Drain any leftover buffer from previous commands
      this._buffer = '';
      this._pendingMarker = marker;
      this._pendingResolve = resolve;

      this._pendingTimeout = setTimeout(() => {
        const partial = this._buffer;
        this._buffer = '';
        this._pendingResolve = null;
        this._pendingMarker = null;
        resolve(partial); // resolve with partial output on timeout
      }, timeoutMs);

      this._pty!.write(cmd);
    });
  }

  private async _probe(): Promise<void> {
    // Disable echo and wait for confirmation marker.
    // Use && to guarantee stty completes before echo.
    const nonce = crypto.randomBytes(4).toString('hex');
    const marker = `${MARKER_PREFIX}${nonce}`;
    await this._sendAndWait(`stty -echo && echo "${marker}"\n`, marker, 5000);
    this._buffer = '';
    // Small delay to let the terminal driver fully apply stty settings
    await new Promise(r => setTimeout(r, 50));
    this._buffer = '';
  }

  private _clearTimeout(): void {
    if (this._pendingTimeout) {
      clearTimeout(this._pendingTimeout);
      this._pendingTimeout = null;
    }
  }

  /**
   * Clean PTY output artifacts:
   * - Strip ANSI escape sequences and carriage returns
   * - Remove echoed command lines (PTY echoes stdin)
   * - Remove our wrapper lines (__string_ec, echo marker, etc.)
   */
  private _cleanOutput(raw: string, userCmd: string): string {
    // Strip ANSI escapes + carriage returns
    let cleaned = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    cleaned = cleaned.replace(/\r/g, '');

    const lines = cleaned.split('\n');
    const result: string[] = [];

    for (const line of lines) {
      const trimLine = line.trim();

      // Skip our internal marker/wrapper lines
      if (trimLine.startsWith(MARKER_PREFIX)) continue;
      if (trimLine.startsWith('__string_ec=')) continue;
      if (trimLine.startsWith('echo "' + MARKER_PREFIX)) continue;

      result.push(line);
    }

    return result.join('\n');
  }
}
