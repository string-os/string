/**
 * String — Browser
 * Public API. Manages sessions and executes commands.
 */

import { Loader, type LoaderOptions } from './loader.js';
import { Session } from './session.js';
import { dispatch } from './commands/index.js';
import { parseTopic, type CommandResult, type TopicType } from './types.js';

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

    // Let package commands (e.g. /uninstall) destroy zombie sessions pointing
    // at a soon-to-be-deleted package without giving them a Browser reference.
    //
    // We *delete* the entry instead of just calling session.close(): a closed
    // session keeps its slot in the Map and shows up in /topics as a doc-less
    // shell that the user has no clean way to remove (/close rejects "no
    // document open"). Garbage-collecting the whole topic is what users
    // expect after /uninstall.
    //
    // Re-using the same name later is fine — session() creates lazily.
    // closeSession's "keep at least one" guard does NOT apply here: this
    // cleanup is package-driven, not user-driven. If the user happens to
    // uninstall the only-active session's package, they get an empty Map
    // and the next exec() lazily re-creates whatever session it needs.
    this.loader.sessionCleanup = (predicate) => {
      const closed: string[] = [];
      for (const [name, session] of this.sessions) {
        const uri = session.currentUri;
        if (uri && predicate(uri)) {
          session.close();          // releases bash subprocess, vars, etc.
          this.sessions.delete(name);
          closed.push(name);
        }
      }
      // If we deleted the active session, fall back to any remaining one,
      // or stay pointed at the original name (will be lazy-created next exec).
      if (closed.includes(this._activeSession)) {
        const remaining = [...this.sessions.keys()];
        if (remaining.length > 0) this._activeSession = remaining[0];
      }
      return closed;
    };
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
    const parts = command.split(/\s+/);
    const verb = parts[0];

    // Three entry points all route here:
    //   /topics  — canonical name in docs (every session = a "topic")
    //   /sessions — plural alias, lower-friction for new agents
    //   /session  — legacy verb with sub-commands (list/close)
    // For the first two, `parts[1]` (if present) is a TYPE FILTER, not a sub-cmd.
    // For /session, parts[1] is a sub-command (list, close, ...).
    const isTopicsForm = verb === '/topics' || verb === '/sessions';
    const isSessionForm = verb === '/session';
    if (!isTopicsForm && !isSessionForm) return null;

    if (isTopicsForm) {
      const filter = parts[1]?.trim();
      return this.listTopics(_current, filter);
    }

    // /session <sub>...
    const sub = parts[1];
    if (!sub || sub === 'list') {
      return this.listTopics(_current);
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

  /**
   * Format the active-topics view shown by /topics, /sessions, /session list.
   * `filter` (when set) selects by topic type (tab/app/bash/hub). Unknown
   * type strings are rejected with a clear message rather than silently
   * returning an empty list — that misleads agents into thinking there are
   * zero topics open.
   */
  private listTopics(current: string, filter?: string): CommandResult {
    const validTypes: TopicType[] = ['tab', 'app', 'bash', 'hub'];
    if (filter && !validTypes.includes(filter as TopicType)) {
      return {
        ok: false,
        content:
          `Unknown topic type: ${filter}\n` +
          `Valid types: ${validTypes.join(', ')}`,
      };
    }

    const rows: { name: string; type: TopicType; detail: string; isCurrent: boolean }[] = [];
    for (const name of this.listSessions()) {
      const parsed = parseTopic(name) ?? { type: 'tab' as TopicType, namespace: name };
      if (filter && parsed.type !== filter) continue;
      const session = this.session(name);
      rows.push({
        name,
        type: parsed.type,
        detail: this.topicDetail(session, parsed.type),
        isCurrent: name === current,
      });
    }

    if (rows.length === 0) {
      return {
        ok: true,
        content: filter
          ? `No ${filter} topics open.`
          : 'No topics open.',
      };
    }

    const nameWidth = Math.max(...rows.map(r => r.name.length));
    const typeWidth = Math.max(...rows.map(r => r.type.length));
    const lines = rows.map(r => {
      const marker = r.isCurrent ? '*' : ' ';
      const namePad = r.name.padEnd(nameWidth);
      const typePad = r.type.padEnd(typeWidth);
      return `${marker} ${namePad}  ${typePad}  ${r.detail}`;
    });

    const header = filter ? `${filter} topics:` : 'Active topics:';
    const count = filter
      ? `${rows.length} ${filter} topic${rows.length === 1 ? '' : 's'} open.`
      : `${rows.length} topic${rows.length === 1 ? '' : 's'} open.`;
    return { ok: true, content: `${header}\n\n${lines.join('\n')}\n\n${count}` };
  }

  /** One-line "current state" for a topic — what's open or where the shell sits. */
  private topicDetail(session: Session, type: TopicType): string {
    if (type === 'bash') {
      // bash topics don't have a doc — show the shell's cwd if alive.
      const bash = session.bashSession;
      if (bash?.alive) return `cwd: ${bash.cwd}`;
      return '(no shell)';
    }
    const uri = session.currentUri;
    if (!uri) return '(no doc)';
    if (uri.startsWith('http://') || uri.startsWith('https://')) {
      return `current: ${uri}`;
    }
    if (uri.startsWith('file://')) {
      return `current: ${new URL(uri).pathname}`;
    }
    return `current: ${uri}`;
  }
}
