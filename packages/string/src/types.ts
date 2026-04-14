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
  /** Raw include directives found in this document */
  includes: IncludeDirective[];
  /** Action directives defined in this document */
  actions: ActionDirective[];
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

/** Topic scheme: file, web, app, bash. In `file:main`, "file" is the scheme. */
export type TopicType = 'file' | 'web' | 'app' | 'bash';

export interface ParsedTopic {
  /** The scheme portion of a topic (e.g. "file" in "file:main"). */
  type: TopicType;
  /** The session name portion (e.g. "main" in "file:main"). */
  namespace: string;
}

/** Session names: alphanumeric, hyphens, underscores only (no dots). */
export const SESSION_NAME_RE = /^[a-zA-Z0-9_-]+$/;

const VALID_TYPES = new Set<string>(['file', 'web', 'app', 'bash']);

/**
 * Parse a raw topic string into a typed topic.
 *
 * Formats:
 *   ""  / undefined       → { type: "file", namespace: "main" }
 *   "main"                → { type: "file", namespace: "main" }
 *   "file:docs"           → { type: "file", namespace: "docs" }
 *   "web:search"          → { type: "web", namespace: "search" }
 *   "app:weather:korea"   → { type: "app", namespace: "weather:korea" }
 *   "bash:dev"            → { type: "bash", namespace: "dev" }
 *
 * Returns null if invalid (dots in session name, unknown type, etc.)
 */
export function parseTopic(raw?: string): ParsedTopic | null {
  if (!raw || raw.trim() === '') {
    return { type: 'file', namespace: 'main' };
  }

  const trimmed = raw.trim();
  const colonIdx = trimmed.indexOf(':');

  // No colon → bare session name → file:<name>
  if (colonIdx === -1) {
    if (!SESSION_NAME_RE.test(trimmed)) return null;
    return { type: 'file', namespace: trimmed };
  }

  const typePart = trimmed.slice(0, colonIdx);
  const rest = trimmed.slice(colonIdx + 1);

  if (!VALID_TYPES.has(typePart)) return null;
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
 * e.g. { type: "file", namespace: "main" } → "file:main"
 */
export function topicToString(topic: ParsedTopic): string {
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
