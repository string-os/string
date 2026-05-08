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
/**
 * Parse POSIX-style flags from args string.
 * Handles: --key value, --key "quoted value", --flag (boolean), -x value (short alias)
 * Returns null if --help or -h is present.
 *
 * @param shortToLong  Optional map of short flag → long name (e.g. {c: 'city'})
 */
export function parsePosixFlags(
  args: string,
  shortToLong?: Record<string, string>,
): { flags: Record<string, string>; rest: string[]; bareFlags: Set<string> } | null {
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

  if (tokens.includes('--help') || tokens.includes('-h')) return null;

  const flags: Record<string, string> = {};
  const rest: string[] = [];
  const bareFlags = new Set<string>();
  const isFlag = (t: string) => t.startsWith('--') || (t.length === 2 && t.startsWith('-'));

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    // POSIX guideline 10: `--` ends option processing. Everything after
    // is an operand, even if it starts with `-`.
    if (tok === '--') {
      for (let j = i + 1; j < tokens.length; j++) rest.push(tokens[j]);
      break;
    }
    if (tok.startsWith('--') && tok.length > 2) {
      // GNU long-option form: `--key=value` (value embedded in same token)
      const eqIdx = tok.indexOf('=');
      if (eqIdx > 2) {
        const key = tok.slice(2, eqIdx);
        flags[key] = tok.slice(eqIdx + 1);
        continue;
      }
      const key = tok.slice(2);
      if (i + 1 < tokens.length && !isFlag(tokens[i + 1])) {
        flags[key] = tokens[++i];
      } else {
        flags[key] = 'true';
        bareFlags.add(key);
      }
    } else if (tok.length === 2 && tok.startsWith('-') && tok !== '--') {
      const shortChar = tok.slice(1);
      const key = shortToLong?.[shortChar] ?? shortChar;
      if (i + 1 < tokens.length && !isFlag(tokens[i + 1])) {
        flags[key] = tokens[++i];
      } else {
        flags[key] = 'true';
        bareFlags.add(key);
      }
    } else {
      rest.push(tok);
    }
  }

  return { flags, rest, bareFlags };
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
 * Walk a JSON value by a dotted path with optional array index segments.
 *
 * Supported syntax:
 *   `body.location.name`              — nested object property access
 *   `candidates[0].content`           — bracket array index
 *   `results.0.latitude`              — bare-digit array index (dot-separated)
 *   `parts[0].inlineData.data`        — chained array indices
 *   `$.candidates[0].content`         — leading `$.` (JSONPath convention) is allowed and ignored
 *
 * Returns `undefined` for any unresolved step (missing key, out-of-range
 * index, wrong type at a step). Not a full JSONPath implementation — this
 * is "extract one value from a known shape", not a query engine.
 */
export function walkJsonPath(obj: unknown, pathStr: string): unknown {
  // Tokenize: keys (`name`), bracket indices (`[N]`), and bare-digit indices
  // (`results.0`) interleaved, optionally separated by `.`. Leading `$.` is
  // stripped. Bare-digit support exists because public docs and several
  // hub-published apps use the dot-N form (e.g. `results.0.latitude`).
  const cleaned = pathStr.replace(/^\$\.?/, '');
  const tokens: (string | number)[] = [];
  const re = /([a-zA-Z_][\w-]*)|\[(\d+)\]|(\d+)/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(parseInt(m[2], 10));
    else if (m[3] !== undefined) tokens.push(parseInt(m[3], 10));
  }
  let current: unknown = obj;
  for (const tok of tokens) {
    if (current == null) return undefined;
    if (typeof tok === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[tok];
    } else {
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[tok];
    }
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
 *
 * Line types (recognized in this order):
 *
 *   1. **Assignment:** `{var} = {Response.body.field}` — walks the response
 *      JSON, stringifies the value, sets a session var. No output.
 *
 *   2. **Save directive:** `save: <jsonpath>` — walks the response JSON
 *      body (no `Response.body.` prefix needed; both `$.foo.bar` and
 *      `foo.bar` work) and stores the resulting value as the *current
 *      buffer*. Used by subsequent `decode:` and `to:` lines. No output.
 *
 *   3. **Decode directive:** `decode: base64` — reinterprets the current
 *      buffer through the named decoder. Currently `base64` is the only
 *      supported decoder. No output.
 *
 *   4. **To directive:** `to: <path>` — writes the current buffer to the
 *      given path. The path supports `{var}` (session vars) and `{field}`
 *      (action payload fields) substitution. No output by default — the
 *      author should add an explicit text line for any user-visible
 *      "saved" message.
 *
 *   5. **Output text:** any line that doesn't match the above. Substitutes
 *      `{Response.body.X}` (walks the response JSON), `{var}` (session
 *      vars), and `{field}` (action payload fields). Appended to output.
 *
 * The function takes the action's `payload` so `{filename}` and similar
 * placeholders in `to:` and text lines can be substituted from the parsed
 * action flags.
 */
export function executeResponseTemplate(
  template: string,
  actionResult: ActionResult,
  session: Session,
  payload?: Record<string, unknown>,
): string {
  // For JSON responses, `{Response.body.field}` walks the parsed object.
  // For plain-text responses (wttr.in, prometheus, /etc/hosts...) `jsonBody`
  // is null — fall back to the raw source so `{Response.body}` returns the
  // text. This lets authors wrap text responses in a fenced code block to
  // preserve newlines (markdown collapses bare newlines to spaces).
  const body: unknown = actionResult.jsonBody !== null && actionResult.jsonBody !== undefined
    ? actionResult.jsonBody
    : actionResult.source;
  const responseObj: Record<string, unknown> = {
    status: actionResult.status,
    body,
  };

  // The "current buffer" for save → decode → to pipelines. Starts as a
  // string (whatever JSON path resolved to, stringified). `decode: base64`
  // turns it into a Buffer. `to:` writes whichever it currently is.
  let currentBuffer: string | Buffer | undefined;

  // Value-shortcut state: `{@name} = expr` directives register named action
  // outputs (scalar string or tuple string[]). Inside a `for:` loop the slug
  // auto-increments per iteration (@name-1, @name-2, ...); outside a loop
  // there is no suffix (@name). Inline `{@name}` (not on the LHS of `=`)
  // emits the most recently registered slug name for that base.
  const currentSlugs = new Map<string, string>();      // base → current slug
  const slugCounters = new Map<string, number>();      // base → last assigned N
  const seenSlugBases = new Set<string>();             // bases we've cleared this run

  /** Comma-split that respects {…} nesting (so {@card} = ({a}, {b}) works). */
  const splitTopLevelCommas = (s: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === ',' && depth === 0) {
        parts.push(s.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(s.slice(start).trim());
    return parts;
  };

  /** Strip leading `@` (used when an RHS expression yields a slug like `@feed-1`). */
  const stripLeadingAt = (s: string): string => (s.startsWith('@') ? s.slice(1) : s);

  /**
   * Register a value shortcut under base name `base`. In for-loop context
   * (inLoop=true) auto-increment a per-base counter and use slug `base-N`;
   * else use `base` directly. Records the current slug for inline `{@base}`
   * emission. Clears any pre-existing `base-*` shortcuts on first encounter
   * within this template run, so re-running an action with fewer items
   * doesn't leave stale slugs behind.
   */
  const registerValueShortcut = (base: string, value: string | string[], inLoop: boolean): string => {
    if (!seenSlugBases.has(base)) {
      seenSlugBases.add(base);
      // Drop stale `base` and `base-N` from any prior run of this template.
      const stalePrefix = `${base}-`;
      for (const key of [...session.valueShortcuts.keys()]) {
        if (key === base || key.startsWith(stalePrefix)) {
          session.valueShortcuts.delete(key);
        }
      }
    }
    let slug: string;
    if (inLoop) {
      const next = (slugCounters.get(base) ?? 0) + 1;
      slugCounters.set(base, next);
      slug = `${base}-${next}`;
    } else {
      slug = base;
    }
    session.setValueShortcut(slug, value);
    currentSlugs.set(base, slug);
    return slug;
  };

  /**
   * Substitute {var} (session) and {field} (payload) in arbitrary text.
   * Supports `{name[N]}` indexing when the field value is a tuple, mirroring
   * the URI/body template behavior so authors can reference tuple elements
   * uniformly across all substitution sites.
   */
  const substituteVarsAndFields = (input: string): string =>
    input.replace(/\{([a-zA-Z_]\w*)(?:\[(\d+)\])?\}/g, (_m: string, name: string, idxStr: string | undefined): string => {
      if (payload && payload[name] !== undefined) {
        const val = payload[name];
        if (idxStr !== undefined) {
          const idx = parseInt(idxStr, 10);
          const arr = Array.isArray(val) ? val : [String(val)];
          return idx < arr.length ? String(arr[idx]) : '';
        }
        return Array.isArray(val) ? val.map(String).join(',') : String(val);
      }
      const val = session.getVar(name);
      if (val !== undefined) return val;
      return idxStr !== undefined ? `{${name}[${idxStr}]}` : `{${name}}`;
    });

  /** Substitute {@name} (slug emission) — runs first so the literal "@slug" survives. */
  const substituteSlugRefs = (input: string): string =>
    input.replace(/\{@([a-zA-Z_]\w*)\}/g, (_m: string, name: string): string => {
      const slug = currentSlugs.get(name);
      return slug !== undefined ? `@${slug}` : `{@${name}}`;
    });

  /** Substitute {Response.*} and then {var}/{field} in a single text line. */
  const substituteLine = (line: string): string => {
    let out = substituteSlugRefs(line);
    out = out.replace(/\{Response\.([a-zA-Z_.[\]\d]+)\}/g, (_m: string, p: string): string => {
      const val = walkJsonPath(responseObj, p);
      return stringifyValue(val);
    });
    out = substituteVarsAndFields(out);
    return out;
  };

  /**
   * Resolve an RHS expression for `{@name} = expr` after all upstream
   * substitutions (item.field, Response.*, var/field) have run on the line.
   * Tuple form: `(a, b, c)` → string[]. Otherwise scalar string.
   */
  const parseSlugRhs = (rhs: string): string | string[] => {
    const trimmed = rhs.trim();
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
      const inner = trimmed.slice(1, -1).trim();
      if (inner === '') return [];
      const parts = splitTopLevelCommas(inner);
      // 1-element tuple normalizes to scalar — `(x)` is the same as `x`.
      if (parts.length === 1) return stripLeadingAt(parts[0]);
      return parts.map(stripLeadingAt);
    }
    return stripLeadingAt(trimmed);
  };

  const outputLines: string[] = [];
  const lines = template.split('\n');

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    // 1. Assignment: {var} = {Response.body.field}
    const assignMatch = line.match(/^\{([a-zA-Z_]\w*)\}\s*=\s*\{Response\.(.+)\}$/);
    if (assignMatch) {
      const varName = assignMatch[1];
      const pathStr = assignMatch[2];
      const value = walkJsonPath(responseObj, pathStr);
      session.setVar(varName, stringifyValue(value));
      continue;
    }

    // 1b. Value-shortcut assignment (top-level): {@name} = expr
    //     `expr` may be a tuple `(a, b, ...)` or a scalar. Substitute
    //     {Response.*} and {var}/{field} first, then parse.
    const slugAssignMatch = line.match(/^\{@([a-zA-Z_]\w*)\}\s*=\s*(.+)$/);
    if (slugAssignMatch) {
      const base = slugAssignMatch[1];
      const rhsRaw = slugAssignMatch[2];
      const rhsResolved = substituteVarsAndFields(
        rhsRaw.replace(/\{Response\.([a-zA-Z_.[\]\d]+)\}/g, (_m: string, p: string): string => {
          const val = walkJsonPath(responseObj, p);
          return stringifyValue(val);
        }),
      );
      registerValueShortcut(base, parseSlugRhs(rhsResolved), false);
      continue;
    }

    // 2. for: <item> in <jsonpath> ... end:
    const forMatch = line.match(/^\s*for:\s*([a-zA-Z_]\w*)\s+in\s+(.+)$/);
    if (forMatch) {
      const itemVar = forMatch[1];
      let arrayPath = forMatch[2].trim();
      if (arrayPath.startsWith('Response.')) arrayPath = arrayPath.slice('Response.'.length);
      const arr = walkJsonPath(responseObj, arrayPath);

      // Collect body lines until end:
      const bodyLines: string[] = [];
      li++;
      while (li < lines.length) {
        if (/^\s*end:\s*$/.test(lines[li])) break;
        bodyLines.push(lines[li]);
        li++;
      }
      // li now points at end: (or past the array)

      if (!Array.isArray(arr) || arr.length === 0) continue;

      for (const item of arr) {
        for (const bodyLine of bodyLines) {
          // Substitute {item.field} first — gives loop-item context to
          // everything downstream (including {@name} = expr RHS).
          const itemSubbed = bodyLine.replace(
            /\{([a-zA-Z_]\w*)\.([a-zA-Z_.[\]\d]+)\}/g,
            (_m: string, varRef: string, fieldPath: string): string => {
              if (varRef !== itemVar) return _m;
              const val = walkJsonPath(item, fieldPath);
              return stringifyValue(val);
            },
          );

          // Per-iteration value-shortcut assignment: {@name} = expr
          // Auto-enumerated (slug = name-1, name-2, ...).
          const slugLineMatch = itemSubbed.match(/^\{@([a-zA-Z_]\w*)\}\s*=\s*(.+)$/);
          if (slugLineMatch) {
            const base = slugLineMatch[1];
            const rhsRaw = slugLineMatch[2];
            const rhsResolved = substituteVarsAndFields(
              rhsRaw.replace(/\{Response\.([a-zA-Z_.[\]\d]+)\}/g, (_m: string, p: string): string => {
                const val = walkJsonPath(responseObj, p);
                return stringifyValue(val);
              }),
            );
            registerValueShortcut(base, parseSlugRhs(rhsResolved), true);
            continue; // directive — no output
          }

          // Normal output line — slug refs resolve to the current iteration's slug.
          outputLines.push(substituteLine(itemSubbed));
        }
      }
      continue;
    }

    // 3. save: <jsonpath>
    const saveMatch = line.match(/^\s*save:\s*(.+)$/);
    if (saveMatch) {
      const pathStr = saveMatch[1].trim();
      const value = walkJsonPath(actionResult.jsonBody, pathStr);
      if (value === undefined) {
        outputLines.push(`save: path returned no value: ${pathStr}`);
        currentBuffer = undefined;
        continue;
      }
      currentBuffer = stringifyValue(value);
      continue;
    }

    // 4. decode: <encoding>
    const decodeMatch = line.match(/^\s*decode:\s*(\S+)\s*$/);
    if (decodeMatch) {
      const encoding = decodeMatch[1];
      if (currentBuffer === undefined) {
        outputLines.push(`decode: no current buffer (was save: skipped or missing?)`);
        continue;
      }
      if (encoding === 'base64') {
        try {
          currentBuffer = Buffer.from(
            typeof currentBuffer === 'string' ? currentBuffer : currentBuffer.toString('utf-8'),
            'base64',
          );
        } catch (e) {
          outputLines.push(`decode: base64 failed: ${(e as Error).message}`);
        }
      } else if (encoding === 'none') {
        // Explicit no-op
      } else {
        outputLines.push(`decode: unknown encoding "${encoding}" (supported: base64, none)`);
      }
      continue;
    }

    // 5. to: <path>
    const toMatch = line.match(/^\s*to:\s*(.+)$/);
    if (toMatch) {
      if (currentBuffer === undefined) {
        outputLines.push(`to: no current buffer (was save: skipped or missing?)`);
        continue;
      }
      const rawPath = toMatch[1].trim();
      const resolvedPath = substituteVarsAndFields(rawPath);
      const absPath = path.isAbsolute(resolvedPath)
        ? resolvedPath
        : path.resolve(process.cwd(), resolvedPath);
      try {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        const bytes = typeof currentBuffer === 'string'
          ? Buffer.from(currentBuffer, 'utf-8')
          : currentBuffer;
        fs.writeFileSync(absPath, bytes);
      } catch (e) {
        outputLines.push(`to: write failed: ${(e as Error).message}`);
        continue;
      }
      continue;
    }

    // 6. Output text: substitute {Response.*}, then {var}/{field}.
    outputLines.push(substituteLine(line));
  }

  // Drop any all-blank trailing lines so the rendered viewport doesn't
  // gain phantom whitespace from template formatting.
  while (outputLines.length > 0 && outputLines[outputLines.length - 1].trim() === '') {
    outputLines.pop();
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
    // Resolution priority:
    //   1. Per-call extraEnv (tool context vars passed in by caller)
    //   2. SFMD env-store (per-user, /set values, encrypted on disk)
    //   3. Daemon process.env (fallback for things like API keys exported in
    //      the shell that started stringd — `export GEMINI_API_KEY=...`)
    //   4. Literal $name (unresolved, leave as-is so failures are visible)
    if (extraEnv && name in extraEnv) return extraEnv[name];
    const stored = loader.envStore.get(name, scope);
    if (stored !== undefined) return stored;
    const fromProcess = process.env[name];
    if (fromProcess !== undefined) return fromProcess;
    return `$${name}`;
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
