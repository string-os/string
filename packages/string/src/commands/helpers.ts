/**
 * Shared helpers for command modules.
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { toSlug } from '@string-os/core';
import type { ActionResult } from '../loader.js';
import type { Session } from '../session.js';
import type { CommandResult, StringErrorCode } from '../types.js';
import type { EnvScope } from '../env-store.js';
import type { Loader } from '../loader.js';

// ─── ok / err ─────────────────────────────────────────────────────────────────

export function ok(content: string): CommandResult {
  return { ok: true, content };
}

export function err(message: string, code?: StringErrorCode): CommandResult {
  return { ok: false, code, content: message };
}

// ─── POSIX Flag Parser ───────────────────────────────────────────────────────

/**
 * Parse POSIX-style flags from args string.
 * Handles: --key value, --key "quoted value", --flag (boolean)
 * Returns null if --help is present.
 */
export function parsePosixFlags(args: string): { flags: Record<string, string>; rest: string[] } | null {
  const tokens: string[] = [];
  let current = '';
  let inQuote: '"' | "'" | null = null;

  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);

  // Check for --help
  if (tokens.includes('--help')) return null;

  const flags: Record<string, string> = {};
  const rest: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('--') && tok.length > 2) {
      const key = tok.slice(2);
      // Peek next token — if it exists and is not a flag, treat as value
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
        flags[key] = tokens[++i];
      } else {
        flags[key] = 'true'; // boolean flag
      }
    } else {
      rest.push(tok);
    }
  }

  return { flags, rest };
}

// ─── Variable Substitution ───────────────────────────────────────────────────

/**
 * Replace {var} references with session variable values.
 * Rejects $var usage (security boundary — only allowed in action definitions).
 */
export function substituteVars(input: string, session: Session): { result: string; error: string | null } {
  // $var is for action definitions (document-level), not AI command arguments.
  // AI should reference {var} (session) in commands; $var is resolved in action URIs/headers.
  if (/\$[a-zA-Z_]\w*/.test(input)) {
    return { result: input, error: '$var cannot be used in command arguments. Use {var} for session variables, $var in action definitions.' };
  }

  const result = input.replace(/\{([a-zA-Z_]\w*)\}/g, (_match, name) => {
    const val = session.getVar(name);
    return val !== undefined ? val : `{${name}}`;
  });

  return { result, error: null };
}

// ─── Response Template Execution ─────────────────────────────────────────────

/**
 * Walk a JSON object by dot-separated path.
 * E.g. "body.location.name" on { body: { location: { name: "Seoul" } } } → "Seoul"
 */
export function walkJsonPath(obj: unknown, pathStr: string): unknown {
  const parts = pathStr.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Stringify a value for template output.
 */
export function stringifyValue(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

/**
 * Execute a response template against an action result.
 * - Assignment lines: `{var} = {Response.body.field}` → extract, store, no output
 * - Output lines: substitute {Response.*} and {var} refs
 */
export function executeResponseTemplate(
  template: string,
  actionResult: ActionResult,
  session: Session,
): string {
  const responseObj: Record<string, unknown> = {
    status: actionResult.status,
    body: actionResult.jsonBody,
  };

  const outputLines: string[] = [];

  for (const line of template.split('\n')) {
    // Assignment line: {var} = {Response.body.field}
    const assignMatch = line.match(/^\{([a-zA-Z_]\w*)\}\s*=\s*\{Response\.(.+)\}$/);
    if (assignMatch) {
      const varName = assignMatch[1];
      const pathStr = assignMatch[2];
      const value = walkJsonPath(responseObj, pathStr);
      session.setVar(varName, stringifyValue(value));
      continue; // no output for assignment lines
    }

    // Output line: substitute {Response.*} and {var}
    let outputLine = line.replace(/\{Response\.([a-zA-Z_.]+)\}/g, (_m, p) => {
      const val = walkJsonPath(responseObj, p);
      return stringifyValue(val);
    });

    outputLine = outputLine.replace(/\{([a-zA-Z_]\w*)\}/g, (_m, name) => {
      const val = session.getVar(name);
      return val !== undefined ? val : `{${name}}`;
    });

    outputLines.push(outputLine);
  }

  return outputLines.join('\n');
}

// ─── Env Var Resolution ──────────────────────────────────────────────────────

/**
 * Resolve $var in a string using extraEnv (context vars) → EnvStore (file-backed) → leave as-is.
 * No process.env fallback — String manages its own vars.
 */
export function resolveEnvVars(
  input: string,
  loader: Loader,
  scope: EnvScope,
  extraEnv?: Record<string, string>,
): string {
  return input.replace(/\$([a-zA-Z_]\w*)/g, (_m, name) => {
    if (extraEnv && name in extraEnv) return extraEnv[name];
    const val = loader.envStore.get(name, scope);
    return val !== undefined ? val : `$${name}`;
  });
}

// ─── File Path Helpers ───────────────────────────────────────────────────────

/**
 * Save .undo backup before writing a file.
 * Overwrites any previous .undo for the same path (one-level undo).
 * If the file doesn't exist yet, writes an empty .undo marker.
 * Records the path on the session so /undo knows which file to revert.
 */
export async function saveUndoBackup(resolvedPath: string, session: Session): Promise<string> {
  const undoPath = resolvedPath + '.undo';
  let oldContent = '';
  try {
    oldContent = await fsPromises.readFile(resolvedPath, 'utf-8');
    await fsPromises.writeFile(undoPath, oldContent, 'utf-8');
  } catch {
    // File doesn't exist yet — write empty marker so /undo can delete it
    await fsPromises.writeFile(undoPath, '', 'utf-8');
  }
  session.setLastUndoPath(resolvedPath);
  return oldContent;
}

/**
 * Convert absolute path to workspace-relative path for display.
 * Ensures all user-facing paths are shown in canonical workspace-relative form.
 */
export function toWorkspacePath(absolutePath: string, home: string): string {
  if (!absolutePath.startsWith(home)) return absolutePath;
  const rel = path.relative(home, absolutePath);
  return rel || '.';
}

/**
 * Resolve file path:
 * - Absolute paths (/...): use as-is
 * - Relative paths: resolve from cwd (current document's directory if open, else home)
 */
export function resolveFilePath(
  filePath: string,
  home: string,
  currentUri?: string | null,
  cwdOverride?: string | null,
): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  // cwd priority: cwdOverride > current document's directory > home
  const cwd = cwdOverride
    ?? (currentUri?.startsWith('file://') ? path.dirname(new URL(currentUri).pathname) : null)
    ?? home;

  return path.resolve(cwd, filePath);
}

/**
 * Validate that resolved path is within workspace boundary.
 * Skipped when accessMode is 'full'.
 */
export function validateWorkspaceBoundary(
  resolved: string,
  home: string,
  userInput: string,
  accessMode: import('../loader.js').AccessMode = 'full',
): CommandResult | null {
  if (accessMode === 'full') return null;

  const normalizedResolved = path.resolve(resolved);
  const normalizedHome = path.resolve(home);

  const rel = path.relative(normalizedHome, normalizedResolved);

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return err(`Path outside workspace: ${userInput}`, 'FILE_NOT_ALLOWED');
  }

  return null;
}

// ─── Block Editing Helpers ───────────────────────────────────────────────────

/**
 * Extract explicit ID from heading text.
 * Supports: {#id} and []{#id} syntax
 * Returns null if no explicit ID found.
 */
export function extractExplicitId(headingText: string): string | null {
  // Match {#id} syntax: ## Heading {#custom-id}
  const braceMatch = headingText.match(/\{#([a-z0-9-_]+)\}/i);
  if (braceMatch) return braceMatch[1];

  // Match []{#id} syntax: ## Heading []{#custom-id}
  const anchorMatch = headingText.match(/\[\]\{#([a-z0-9-_]+)\}/i);
  if (anchorMatch) return anchorMatch[1];

  return null;
}

/**
 * Find heading-derived block boundaries for editing.
 * Priority: explicit ID → heading slug
 * Returns line indices where:
 * - startLine is the heading line (preserved during edit)
 * - endLine is exclusive (first line NOT included in block)
 * Returns null if block not found.
 */
export function findHeadingBlockRange(
  source: string,
  blockId: string,
): { startLine: number; endLine: number; headingLevel: number } | null {
  const lines = source.split('\n');
  const HEADING_RE = /^(#{1,6})\s+(.+)$/;

  let targetLevel = 0;
  let startLine = -1;

  // Find the heading that matches blockId (explicit ID first, then slug)
  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].match(HEADING_RE);
    if (!headingMatch) continue;

    const level = headingMatch[1].length;
    const headingText = headingMatch[2];

    // Priority 1: Check for explicit ID
    const explicitId = extractExplicitId(headingText);
    if (explicitId === blockId) {
      targetLevel = level;
      startLine = i;
      break;
    }

    // Priority 2: Check heading slug
    const slug = toSlug(headingText);
    if (slug === blockId) {
      targetLevel = level;
      startLine = i;
      break;
    }
  }

  if (startLine === -1) return null;

  // Find the end of this block (next heading of same or higher level, or EOF)
  let endLine = lines.length; // Default to end of file

  for (let i = startLine + 1; i < lines.length; i++) {
    const headingMatch = lines[i].match(HEADING_RE);
    if (!headingMatch) continue;

    const level = headingMatch[1].length;
    if (level <= targetLevel) {
      endLine = i;
      break;
    }
  }

  return { startLine, endLine, headingLevel: targetLevel };
}
