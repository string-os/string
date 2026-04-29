/**
 * String — Browser
 * Public API. Manages sessions and executes commands.
 */

import { Loader, type LoaderOptions } from './loader.js';
import { Session } from './session.js';
import { dispatch } from './commands/index.js';
import type { CommandResult, TopicType } from './types.js';

export type { CommandResult, LoadedDocument, StringError, ParsedTopic, TopicType } from './types.js';
export { parseTopic, topicToString } from './types.js';
export { Session } from './session.js';
export { BashSession } from './bash-session.js';
export { Loader } from './loader.js';
export type { AccessMode, HtmlToMarkdown } from './loader.js';
export { createHtmlToMarkdown } from './html-to-md.js';
export { UserRegistry, createUserRegistry } from './user.js';
export type { User } from './user.js';
export { formatDiff, formatLineNumbers } from './diff.js';
export type { DiffOptions } from './diff.js';
export { resolveConfig, DEFAULT_CONFIG } from './config.js';
export type { StringConfig } from './config.js';
export { EnvStore, deriveEnvScope } from './env-store.js';
export type { EnvScope } from './env-store.js';
export { installPackage } from './installer.js';
export type { InstallResult } from './installer.js';
export { ping, ensureUser, exec } from '@string-os/client';
export type { ExecResult } from '@string-os/client';

export interface BrowserOptions extends LoaderOptions {
  userId?: string;
  defaultSession?: string;
}

export class Browser {
  private readonly loader: Loader;
  private readonly sessions = new Map<string, Session>();
  private _activeSession: string;
  readonly userId: string | undefined;

  constructor(options: BrowserOptions = {}) {
    this.loader = new Loader(options);
    this._activeSession = options.defaultSession ?? 'main';
    this.userId = options.userId;
    // Sessions are created lazily via session()
  }

  // ── Session Management ─────────────────────────────────────────────────────

  /** Get or create a named session. */
  session(name: string): Session {
    if (!this.sessions.has(name)) {
      this.sessions.set(name, new Session(name));
    }
    return this.sessions.get(name)!;
  }

  get currentSession(): Session {
    return this.session(this._activeSession);
  }

  get activeSessionName(): string {
    return this._activeSession;
  }

  switchSession(name: string): Session {
    this._activeSession = name;
    return this.session(name);
  }

  closeSession(name: string): boolean {
    if (this.sessions.size <= 1) return false; // keep at least one
    const deleted = this.sessions.delete(name);
    if (deleted && this._activeSession === name) {
      this._activeSession = [...this.sessions.keys()][0];
    }
    return deleted;
  }

  listSessions(): string[] {
    return [...this.sessions.keys()];
  }

  // ── Command Execution ──────────────────────────────────────────────────────

  /**
   * Execute a command string against a session.
   * @param command      e.g. "/open string.md" or "/nav main"
   * @param sessionName  session name (default: active session)
   * @param topicType   topic scheme — bash topics use // for meta-commands
   */
  async exec(command: string, sessionName?: string, topicType?: TopicType): Promise<CommandResult> {
    const name = sessionName ?? this._activeSession;
    this.session(name); // ensure session exists (lazy creation)

    // Session management commands (browser-level)
    const sessionResult = this.handleSessionCommand(command.trim(), name);
    if (sessionResult) return sessionResult;

    const sess = this.session(name);
    return dispatch(command, sess, this.loader, topicType);
  }

  private handleSessionCommand(command: string, _current: string): CommandResult | null {
    if (!command.startsWith('/session')) return null;

    const parts = command.split(/\s+/);
    const sub = parts[1];

    if (!sub || sub === 'list') {
      const list = this.listSessions()
        .map(s => (s === _current ? `* ${s}` : `  ${s}`))
        .join('\n');
      return { ok: true, content: `sessions:\n${list}` };
    }

    if (sub === 'close') {
      const topic = parts[2] ?? _current;
      const ok = this.closeSession(topic);
      return ok
        ? { ok: true, content: `Closed session: ${topic}` }
        : { ok: false, content: `Cannot close last session.` };
    }

    return { ok: false, content: `Unknown session command: /session ${sub}` };
  }
}
