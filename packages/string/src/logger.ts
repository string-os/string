/**
 * stringd logger — structured file-based logging with rotation.
 *
 * Activation: STRINGD_LOG=1 env var or --log CLI flag.
 * Default: off (security-first).
 *
 * Format: grep-friendly structured text lines.
 * Rotation: single backup (.log.1) when file exceeds maxSize.
 */

import fs from 'fs';
import path from 'path';

export interface LoggerOptions {
  enabled: boolean;
  dir: string;
  maxSize?: number;   // bytes, default 10MB
  stdout?: boolean;   // also print to console, default true
}

type LogLevel = 'INFO' | 'ERROR';

function formatFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([k, v]) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return s.includes(' ') ? `${k}="${s}"` : `${k}=${s}`;
    })
    .filter(Boolean)
    .join(' ');
}

function formatLine(level: LogLevel, event: string, fields?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const pad = level === 'INFO' ? '  ' : ' ';
  const tail = fields ? ' ' + formatFields(fields) : '';
  return `[${ts}] ${level}${pad}${event}${tail}`;
}

class FileLogger {
  private stream: fs.WriteStream;
  private filePath: string;
  private maxSize: number;
  private toStdout: boolean;

  constructor(opts: LoggerOptions) {
    this.filePath = path.join(opts.dir, 'stringd.log');
    this.maxSize = opts.maxSize ?? 10 * 1024 * 1024;
    this.toStdout = opts.stdout ?? true;

    fs.mkdirSync(opts.dir, { recursive: true });
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
  }

  private rotate(): void {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size < this.maxSize) return;
    } catch {
      return; // file doesn't exist yet
    }

    this.stream.end();
    const backup = this.filePath + '.1';
    try { fs.unlinkSync(backup); } catch { /* ok */ }
    fs.renameSync(this.filePath, backup);
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.write('INFO', event, fields);
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.write('ERROR', event, fields);
  }

  private write(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    this.rotate();
    const line = formatLine(level, event, fields);
    this.stream.write(line + '\n');
    if (this.toStdout) {
      (level === 'ERROR' ? process.stderr : process.stdout).write(line + '\n');
    }
  }

  close(): void {
    this.stream.end();
  }
}

/** No-op logger when logging is disabled. */
const noopLogger = {
  info(_event: string, _fields?: Record<string, unknown>): void {},
  error(_event: string, _fields?: Record<string, unknown>): void {},
  close(): void {},
};

export type Logger = typeof noopLogger;

export function createLogger(opts: LoggerOptions): Logger {
  if (!opts.enabled) return noopLogger;
  return new FileLogger(opts);
}
