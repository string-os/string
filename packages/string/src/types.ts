/**
 * String — Shared Types
 */

import type { Shortcut, MenuDirective, IncludeDirective, ActionDirective } from '@string-os/core';
export type { ActionDirective } from '@string-os/core';

// ─── Document ─────────────────────────────────────────────────────────────────

/** A fully resolved SFMD document ready for use by the browser session. */
export interface LoadedDocument {
  /** Canonical URI (file:// or https://) */
  uri: string;
  /** Raw source markdown */
  source: string;
  /** Original source before conversion (e.g. raw HTML before htmlToMarkdown) */
  rawSource?: string;
  /** Frontmatter fields (parsed from YAML --- block) */
  frontmatter: Record<string, unknown>;
  /** All addressable block IDs in this document (inline + file-based via include) */
  blockIds: string[];
  /** Page-level shortcuts: id → href (@-prefixed SFMD shortcuts) */
  shortcuts: Map<string, string>;
  /** Markdown reference definitions: name → URL (all [name]: url entries) */
  references: Map<string, string>;
  /** Menu/nav entries by menu name, with shortcuts namespaced as `menu_name.id` */
  menus: Map<string, ResolvedMenuEntry[]>;
  /** Resolved source URI for each menu/nav file. Used for session-scoped hints. */
  menuSources: Map<string, string>;
  /** Raw include directives found in this document */
  includes: IncludeDirective[];
  /** Action directives defined in this document */
  actions: ActionDirective[];
  /** Requirements/setup doc, if any. `path` is the doc-relative form (what
   *  to show in hints and pass to /open); `uri` is the resolved canonical URI.
   *  Populated by an explicit `[!requirements](path)` directive, or — for
   *  local file:// documents only — by auto-detecting a sibling
   *  `requirements.md`. Web docs must declare it explicitly. */
  requirements?: { path: string; uri: string };
  /** Warnings from resolution (e.g. unknown shortcut invocations) */
  warnings: string[];
}

export interface ResolvedMenuEntry {
  /** Namespaced shortcut id, e.g. "main.overview" */
  id: string;
  label: string;
  href: string;
}

// ─── Session ──────────────────────────────────────────────────────────────────

export interface SessionState {
  currentUri: string | null;
  historyLength: number;
  shortcuts: Record<string, string>;
  menus: string[];
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export interface CommandResult {
  ok: boolean;
  code?: string;
  content: string;
  meta?: Record<string, unknown>;
}

// ─── Topics ──────────────────────────────────────────────────────────────────

/**
 * Topic scheme. Three shapes:
 *
 *   - `tab`   — free-form session, bare name (`main`, `notes`, `research`).
 *               The default kind. Display: just the name, no prefix.
 *   - `app`   — canonical app session (`app:moltbook`, `app:weather:korea`).
 *               Always carries the `app:` prefix.
 *   - `bash`  — canonical bash session (`bash:dev`). Always `bash:` prefix.
 *               Each bash:<name> owns its own pty.
 *   - `hub`   — reserved bare aggregator name (`app`, `bash`, `tool`, `event`,
 *               `system`, `agent`). Manages instances of its kind. Display: just
 *               the name (e.g. `app`, not `hub:app`).
 *
 * Hub names are reserved — they cannot be used as free-form `tab` names.
 * `string app` always routes to the app hub.
 */
export type TopicType = 'tab' | 'app' | 'bash' | 'hub';

export interface ParsedTopic {
  /** The scheme portion of a topic. */
  type: TopicType;
  /**
   * The session name portion. For `hub`, this is the hub name itself
   * (`app`, `bash`, ...). For `tab`, the user-chosen label (`main`, ...).
   * For `app`/`bash`, the per-instance name (`moltbook`, `dev`, ...).
   */
  namespace: string;
}

/** Session names: alphanumeric, hyphens, underscores only (no dots). */
export const SESSION_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Topic schemes that can appear before the `:` in `<type>:<name>`. */
const CANONICAL_PREFIXES = new Set<string>(['app', 'bash']);

/**
 * Reserved bare names that route to hub topics rather than free-form
 * `tab` sessions.
 *
 *   `app`     — installed apps + currently open app sessions
 *   `bash`    — active bash sessions (list, spawn, kill)
 *   `tool`    — installed tools
 *   `event`   — agent-local event inbox
 *   `system`  — daemon status, env-store, /set, runtime controls
 *   `agent`   — registered agents and current-agent config
 *
 * Adding a new hub later = add to this set + register a hub doc generator.
 */
export const HUB_NAMES = new Set<string>(['app', 'bash', 'tool', 'event', 'system', 'agent']);

/** True if `name` is a reserved hub aggregator name. */
export function isHubName(name: string): boolean {
  return HUB_NAMES.has(name);
}

/**
 * Parse a raw topic string into a typed topic.
 *
 * Formats:
 *   ""  / undefined       → { type: "tab",  namespace: "main" }
 *   "main"                → { type: "tab",  namespace: "main" }
 *   "notes"               → { type: "tab",  namespace: "notes" }
 *   "app"                 → { type: "hub",  namespace: "app" }
 *   "bash"                → { type: "hub",  namespace: "bash" }
 *   "tool"                → { type: "hub",  namespace: "tool" }
 *   "system"              → { type: "hub",  namespace: "system" }
 *   "agent"               → { type: "hub",  namespace: "agent" }
 *   "app:moltbook"        → { type: "app",  namespace: "moltbook" }
 *   "app:weather:korea"   → { type: "app",  namespace: "weather:korea" }
 *   "bash:dev"            → { type: "bash", namespace: "dev" }
 *
 * Returns null if invalid (unknown prefix, missing namespace, bad chars).
 */
export function parseTopic(raw?: string): ParsedTopic | null {
  if (!raw || raw.trim() === '') {
    return { type: 'tab', namespace: 'main' };
  }

  const trimmed = raw.trim();
  const colonIdx = trimmed.indexOf(':');

  // No colon → bare name. Reserved hub name → hub topic; otherwise free-form.
  if (colonIdx === -1) {
    if (!SESSION_NAME_RE.test(trimmed)) return null;
    if (HUB_NAMES.has(trimmed)) {
      return { type: 'hub', namespace: trimmed };
    }
    return { type: 'tab', namespace: trimmed };
  }

  const typePart = trimmed.slice(0, colonIdx);
  const rest = trimmed.slice(colonIdx + 1);

  if (!CANONICAL_PREFIXES.has(typePart)) return null;
  if (!rest) return null;

  // For app type, namespace can contain colons (app:weather:korea)
  // but each segment must match SESSION_NAME_RE
  const segments = rest.split(':');
  for (const seg of segments) {
    if (!SESSION_NAME_RE.test(seg)) return null;
  }

  return { type: typePart as TopicType, namespace: rest };
}

/**
 * Serialize a ParsedTopic back to string form.
 *
 *   tab            → bare name              (`main`, `notes`)
 *   hub            → bare name              (`app`, `bash`)
 *   app / bash     → `<type>:<namespace>`   (`app:moltbook`, `bash:dev`)
 */
export function topicToString(topic: ParsedTopic): string {
  if (topic.type === 'tab' || topic.type === 'hub') return topic.namespace;
  return `${topic.type}:${topic.namespace}`;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export type StringErrorCode =
  | 'NOT_FOUND'
  | 'BLOCK_NOT_FOUND'
  | 'INVALID_TARGET'
  | 'INVALID_PATH'
  | 'INVALID_PAYLOAD'
  | 'FILE_NOT_ALLOWED'
  | 'COMMAND_UNSUPPORTED'
  | 'CONFLICT'
  | 'AUTH_REQUIRED'
  | 'INTERNAL_ERROR'
  | 'LOAD_ERROR'
  | 'CIRCULAR_REFERENCE';

export class StringError extends Error {
  constructor(
    public readonly code: StringErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StringError';
  }
}
