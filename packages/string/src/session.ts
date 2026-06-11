/**
 * String — Session (Tab)
 * One Session = one browser tab. Holds navigation history, shortcuts, menus, and actions.
 */

import type { LoadedDocument, ActionDirective } from './types.js';
import { BashSession } from './bash-session.js';

interface HistoryEntry {
  doc: LoadedDocument;
  blockId?: string;
}

export class Session {
  readonly name: string;
  private _current: HistoryEntry | null = null;
  private _history: HistoryEntry[] = [];
  private _variables: Map<string, string> = new Map();
  private _autoShortcuts: Map<string, string> = new Map();
  private _valueShortcuts: Map<string, string | string[]> = new Map();
  private _seenNavSources: Set<string> = new Set();
  private _seenFiles: Map<string, { mtimeMs: number; size: number }> = new Map();
  private _bash: BashSession | null = null;
  private _lastUndoRecordPath: string | null = null;
  private _cwdOverride: string | null = null;

  constructor(name: string) {
    this.name = name;
  }

  // ── Undo Tracking ──────────────────────────────────────────────────────────

  /** Record this topic's daemon-side undo record for /undo. */
  setLastUndoRecordPath(recordPath: string): void {
    this._lastUndoRecordPath = recordPath;
  }

  get lastUndoRecordPath(): string | null {
    return this._lastUndoRecordPath;
  }

  clearLastUndo(): void {
    this._lastUndoRecordPath = null;
  }

  // ── File Read Tracking ─────────────────────────────────────────────────────

  /** Record that this topic has seen a file's current disk state. */
  markFileSeen(resolvedPath: string, stat: { mtimeMs: number; size: number }): void {
    this._seenFiles.set(resolvedPath, { mtimeMs: stat.mtimeMs, size: stat.size });
  }

  /** Return the last disk state this topic saw for a file, if any. */
  seenFile(resolvedPath: string): { mtimeMs: number; size: number } | undefined {
    return this._seenFiles.get(resolvedPath);
  }

  // ── CWD Override ─────────────────────────────────────────────────────────────

  /** Set explicit cwd (e.g. when /open topics a directory). */
  setCwdOverride(dir: string | null): void {
    this._cwdOverride = dir;
  }

  get cwdOverride(): string | null {
    return this._cwdOverride;
  }

  // ── Bash Session ────────────────────────────────────────────────────────────

  get bashSession(): BashSession | null {
    return this._bash;
  }

  async getOrCreateBash(cwd: string): Promise<BashSession> {
    if (this._bash?.alive) return this._bash;
    this._bash = new BashSession(cwd);
    await this._bash.spawn();
    return this._bash;
  }

  closeBash(): void {
    if (this._bash) {
      this._bash.close();
      this._bash = null;
    }
  }

  // ── Variables ─────────────────────────────────────────────────────────────

  getVar(name: string): string | undefined {
    return this._variables.get(name);
  }

  setVar(name: string, value: string): void {
    this._variables.set(name, value);
  }

  setVars(record: Record<string, string>): void {
    for (const [k, v] of Object.entries(record)) {
      this._variables.set(k, v);
    }
  }

  getAllVars(): Map<string, string> {
    return new Map(this._variables);
  }

  clearVars(): void {
    this._variables.clear();
  }

  // ── State ──────────────────────────────────────────────────────────────────

  get currentDoc(): LoadedDocument | null {
    return this._current?.doc ?? null;
  }

  get currentBlockId(): string | undefined {
    return this._current?.blockId;
  }

  get currentUri(): string | null {
    return this._current?.doc.uri ?? null;
  }

  get historyLength(): number {
    return this._history.length;
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  open(doc: LoadedDocument, blockId?: string): void {
    if (this._current) {
      this._history.push(this._current);
    }
    this._current = { doc, blockId };
    this._cwdOverride = null; // document open resets cwd to document's directory
  }

  back(): HistoryEntry | null {
    if (this._history.length === 0) return null;
    this._current = this._history.pop()!;
    return this._current;
  }

  close(): void {
    this._current = null;
    this._cwdOverride = null;
    this._autoShortcuts = new Map();
    this._valueShortcuts = new Map();
    this.clearVars();
    this.closeBash();
  }

  refresh(doc: LoadedDocument): void {
    if (!this._current) return;
    this._current = { doc, blockId: this._current.blockId };
  }

  /**
   * Return menu names whose source files have not been shown in this session,
   * and mark them as seen. The key is the resolved nav/menu URI when available,
   * so the same shared nav only unfolds once across pages in a session.
   */
  markUnseenNavs(doc: LoadedDocument): Set<string> {
    const names = new Set<string>();
    for (const name of doc.menus.keys()) {
      const source = doc.menuSources.get(name) ?? `${doc.uri}#nav:${name}`;
      if (this._seenNavSources.has(source)) continue;
      this._seenNavSources.add(source);
      names.add(name);
    }
    return names;
  }

  // ── Auto Shortcuts ─────────────────────────────────────────────────────────

  /** Store auto-generated shortcuts from the last render pass. */
  setAutoShortcuts(map: Map<string, string>): void {
    this._autoShortcuts = map;
  }

  /** Get auto-generated shortcuts from the last render pass. */
  get autoShortcuts(): Map<string, string> {
    return this._autoShortcuts;
  }

  // ── Value Shortcuts (from {@var} = expr directives in response templates) ──

  /**
   * Set a value shortcut. Distinct from autoShortcuts (URL-based, navigable):
   * value shortcuts hold scalars or tuples produced by action response templates,
   * intended for substitution into action arguments (not navigation).
   */
  setValueShortcut(id: string, value: string | string[]): void {
    this._valueShortcuts.set(id, value);
  }

  get valueShortcuts(): Map<string, string | string[]> {
    return this._valueShortcuts;
  }

  // ── Shortcut Resolution ────────────────────────────────────────────────────

  /**
   * Resolve a shortcut id (without @). Returns a string href (page/auto/menu
   * shortcuts) or a string/string[] value (value shortcuts from `{@var}=`
   * directives). Callers that only handle navigable hrefs should reject array
   * results explicitly.
   */
  resolveShortcut(id: string): string | string[] | null {
    const doc = this._current?.doc;
    if (!doc) return null;

    // 1. Page-level shortcuts (author-defined)
    if (doc.shortcuts.has(id)) {
      return doc.shortcuts.get(id)!;
    }

    // 2. Value shortcuts (explicit producer outputs from {@var} = ...)
    if (this._valueShortcuts.has(id)) {
      return this._valueShortcuts.get(id)!;
    }

    // 3. Auto-generated shortcuts from last render (@slug, @slug-2, @link-1, etc.)
    if (this._autoShortcuts.has(id)) {
      return this._autoShortcuts.get(id)!;
    }

    // 4. Menu shortcuts (namespaced)
    for (const entries of doc.menus.values()) {
      for (const entry of entries) {
        if (entry.id === id) return entry.href;
      }
    }

    return null;
  }

  // ── Action Resolution ──────────────────────────────────────────────────────

  /** Find an action directive by id on the current document. */
  resolveAction(id: string): ActionDirective | null {
    const doc = this._current?.doc;
    if (!doc) return null;
    return doc.actions.find(a => a.id === id) ?? null;
  }

  // ── Info ───────────────────────────────────────────────────────────────────

  info(): string {
    const doc = this._current?.doc;
    if (!doc) return 'No document open.';

    const lines: string[] = [];
    const title = doc.frontmatter.title as string | undefined;

    lines.push(`uri:     ${doc.uri}`);
    if (title) lines.push(`title:   ${title}`);
    if (doc.blockIds.length > 0) {
      lines.push(`blocks:  ${doc.blockIds.join(', ')}`);
    }
    if (doc.menus.size > 0) {
      lines.push(`menus:   ${[...doc.menus.keys()].join(', ')}`);
    }
    if (doc.shortcuts.size > 0) {
      lines.push(`shortcuts: ${[...doc.shortcuts.keys()].map(k => `@${k}`).join(', ')}`);
    }
    if (doc.actions.length > 0) {
      lines.push(`actions: ${doc.actions.map(a => `${a.id}(${a.method.toUpperCase()})`).join(', ')}`);
    }
    if (this._current?.blockId) {
      lines.push(`block:   #${this._current.blockId}`);
    }
    if (this._variables.size > 0) {
      const vars = [...this._variables.entries()].map(([k, v]) => `{${k}}=${v}`).join(', ');
      lines.push(`vars:    ${vars}`);
    }

    return lines.join('\n');
  }
}
