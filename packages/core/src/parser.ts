/**
 * SFMD Parser — Core parsing utilities
 * Parses SFMD syntax elements from Markdown source.
 */

export interface Block {
  id: string;
  content: string;
  startLine: number;
  endLine: number;
}

export interface IncludeDirective {
  id: string;
  path: string;
  line: number;
}

export interface MenuDirective {
  name: string;
  path: string;
  line: number;
}

export interface Shortcut {
  id: string;
  label: string;
  href: string;
  line: number;
}

// ─── Action types ─────────────────────────────────────────────────────────────

export type HttpMethod = 'get' | 'post' | 'put' | 'delete' | 'patch' | 'cli';

export interface ActionField {
  name: string;
  type: string;
  required: boolean;
  constraints: string;
  description: string;
  defaultValue?: string;
}

export interface ActionHeader {
  key: string;
  value: string;
}

export interface ActionDirective {
  id: string;
  method: HttpMethod;
  uri: string;
  headers: ActionHeader[];
  description: string;
  fields: ActionField[];
  responseTemplate: string | null;
  line: number;
}

// ─── Result types ─────────────────────────────────────────────────────────────

export interface ParseResult {
  blocks: Block[];
  includes: IncludeDirective[];
  menus: MenuDirective[];
  shortcuts: Shortcut[];
  /** Markdown reference definitions: name → URL (includes both standard and @-prefixed) */
  references: Map<string, string>;
  actions: ActionDirective[];
  errors: ParseError[];
}

export interface ParseError {
  line: number;
  message: string;
}

// ─── Regex patterns ───────────────────────────────────────────────────────────

// <!-- #block_id -->
const BLOCK_OPEN_RE = /^<!-- #([a-zA-Z0-9_-]+) -->$/;
// <!-- /block_id -->
const BLOCK_CLOSE_RE = /^<!-- \/([a-zA-Z0-9_-]+) -->$/;
// [!include:id](path) or [!include:id]()  — empty path = auto-convention
const INCLUDE_RE = /^\[!include:([a-zA-Z0-9_-]+)\]\(([^)]*)\)$/;
// [!menu:name](path)  — kept for backwards compat
const MENU_RE = /^\[!menu:([a-zA-Z0-9_-]+)\]\(([^)]+)\)$/;
// [!nav:name](path)   — preferred alias
const NAV_RE = /^\[!nav:([a-zA-Z0-9_-]+)\]\(([^)]+)\)$/;
// [!include](path) or [!menu](path) — invalid, missing identifier
const DIRECTIVE_NO_ID_RE = /^\[!(include|menu|nav)\]\(([^)]+)\)$/;
// [@shortcut_id Label](href)
const SHORTCUT_RE = /\[(@[a-zA-Z0-9_-]+)\s+([^\]]+)\]\(([^)]+)\)/g;
// [name]: url — Markdown reference definition (standard + @-prefixed)
const REF_DEF_RE = /^\[([^\]]+)\]:\s+<?([^\s>]+)>?/;

// ─── Parser ───────────────────────────────────────────────────────────────────

export function parse(source: string): ParseResult {
  const lines = source.split('\n');
  const errors: ParseError[] = [];
  const blocks: Block[] = [];
  const includes: IncludeDirective[] = [];
  const menus: MenuDirective[] = [];
  const shortcuts: Shortcut[] = [];
  const references = new Map<string, string>();
  const actions: ActionDirective[] = [];

  const blockIdsSeen = new Set<string>();
  const shortcutIdsSeen = new Set<string>();

  let openBlock: { id: string; startLine: number; contentLines: string[] } | null = null;
  /** Track if we're inside a fenced code block (```). */
  let inFencedBlock = false;
  /** Track action code block state: 'action' | 'response' */
  let pendingActionBlock: { kind: 'action' | 'response'; id: string; lines: string[]; startLine: number } | null = null;
  /** Collected response templates keyed by action ID (for post-pass matching). */
  const responseTemplates = new Map<string, string>();

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i].trim();

    // ── Track fenced code blocks (```) ────────────────────────────────────────
    if (line.startsWith('```') || line.startsWith('~~~')) {
      if (inFencedBlock) {
        // Closing fence
        if (pendingActionBlock) {
          // Finalize the action block
          if (pendingActionBlock.kind === 'action') {
            const parsed = parseActionBlock(pendingActionBlock.id, pendingActionBlock.lines, pendingActionBlock.startLine);
            if (parsed) {
              actions.push(parsed);
            } else {
              errors.push({ line: pendingActionBlock.startLine, message: `INVALID_ACTION_BLOCK: could not parse action definition for "${pendingActionBlock.id}"` });
            }
          } else {
            // Response template
            responseTemplates.set(pendingActionBlock.id, pendingActionBlock.lines.join('\n'));
          }
          pendingActionBlock = null;
        }
        inFencedBlock = false;
      } else {
        // Opening fence — check info string
        const info = line.slice(3).trim();
        const actMatch = info.match(/^act\.([a-zA-Z0-9_-]+)\.response$/);
        const actDefMatch = !actMatch ? info.match(/^act\.([a-zA-Z0-9_-]+)$/) : null;
        if (actMatch) {
          pendingActionBlock = { kind: 'response', id: actMatch[1], lines: [], startLine: lineNum };
          inFencedBlock = true;
        } else if (actDefMatch) {
          pendingActionBlock = { kind: 'action', id: actDefMatch[1], lines: [], startLine: lineNum };
          inFencedBlock = true;
        } else {
          inFencedBlock = true;
          if (openBlock) {
            openBlock.contentLines.push(lines[i]);
          }
        }
      }
      continue;
    }

    // Inside fenced code blocks
    if (inFencedBlock) {
      if (pendingActionBlock) {
        pendingActionBlock.lines.push(lines[i]);
      } else if (openBlock) {
        openBlock.contentLines.push(lines[i]);
      }
      continue;
    }

    // ── Check for missing-identifier directives ─────────────────────────────
    const noIdMatch = line.match(DIRECTIVE_NO_ID_RE);
    if (noIdMatch) {
      const type = noIdMatch[1];
      errors.push({
        line: lineNum,
        message: `MISSING_IDENTIFIER: [!${type}] requires an id — use [!${type}:name](path)`,
      });
      continue;
    }

    // ── Block open marker ───────────────────────────────────────────────────
    const openMatch = line.match(BLOCK_OPEN_RE);
    if (openMatch) {
      const id = openMatch[1];
      if (openBlock) {
        errors.push({
          line: lineNum,
          message: `NESTED_BLOCK: cannot open <!-- #${id} --> inside <!-- #${openBlock.id} -->`,
        });
      } else if (blockIdsSeen.has(id)) {
        errors.push({
          line: lineNum,
          message: `DUPLICATE_BLOCK_ID: <!-- #${id} --> already declared in this document`,
        });
      } else {
        openBlock = { id, startLine: lineNum, contentLines: [] };
        blockIdsSeen.add(id);
      }
      continue;
    }

    // ── Block close marker ──────────────────────────────────────────────────
    const closeMatch = line.match(BLOCK_CLOSE_RE);
    if (closeMatch) {
      const id = closeMatch[1];
      if (!openBlock) {
        errors.push({
          line: lineNum,
          message: `UNEXPECTED_BLOCK_CLOSE: <!-- /${id} --> has no matching open marker`,
        });
      } else if (openBlock.id !== id) {
        errors.push({
          line: lineNum,
          message: `MISMATCHED_BLOCK: expected <!-- /${openBlock.id} -->, got <!-- /${id} -->`,
        });
      } else {
        blocks.push({
          id: openBlock.id,
          content: openBlock.contentLines.join('\n').trim(),
          startLine: openBlock.startLine,
          endLine: lineNum,
        });
        openBlock = null;
      }
      continue;
    }

    // Accumulate block content
    if (openBlock) {
      openBlock.contentLines.push(lines[i]);
    }

    // ── Directives only apply outside of blocks ─────────────────────────────
    if (!openBlock) {
      const includeMatch = line.match(INCLUDE_RE);
      if (includeMatch) {
        includes.push({ id: includeMatch[1], path: includeMatch[2], line: lineNum });
        continue;
      }

      // [!menu:name] and [!nav:name] are equivalent — both push to menus
      const menuMatch = line.match(MENU_RE) ?? line.match(NAV_RE);
      if (menuMatch) {
        menus.push({ name: menuMatch[1], path: menuMatch[2], line: lineNum });
        continue;
      }
    }

    // ── Shortcuts are scanned on every line ─────────────────────────────────
    const originalLine = lines[i];
    let shortcutMatch;
    SHORTCUT_RE.lastIndex = 0;
    while ((shortcutMatch = SHORTCUT_RE.exec(originalLine)) !== null) {
      const rawId = shortcutMatch[1]; // includes the @
      const id = rawId.slice(1);      // strip the @
      const label = shortcutMatch[2];
      const href = shortcutMatch[3];

      let resolvedId = id;
      if (shortcutIdsSeen.has(id)) {
        let suffix = 2;
        while (shortcutIdsSeen.has(`${id}${suffix}`)) suffix++;
        resolvedId = `${id}${suffix}`;
      }
      shortcutIdsSeen.add(resolvedId);
      shortcuts.push({ id: resolvedId, label, href, line: lineNum });
    }

    // ── Reference definitions: [name]: url ──────────────────────────────
    const refDefMatch = line.match(REF_DEF_RE);
    if (refDefMatch) {
      const refName = refDefMatch[1];
      const refUrl = refDefMatch[2];
      if (!references.has(refName)) {
        references.set(refName, refUrl);
      }
    }
  }

  // Unclosed block
  if (openBlock) {
    errors.push({
      line: openBlock.startLine,
      message: `UNCLOSED_BLOCK: <!-- #${openBlock.id} --> has no closing <!-- /${openBlock.id} -->`,
    });
  }

  // Post-pass: match orphan response templates to actions by ID
  for (const [id, template] of responseTemplates) {
    const action = actions.find(a => a.id === id);
    if (action) {
      action.responseTemplate = template;
    }
    // Orphan response templates (no matching action) are silently ignored
  }

  return { blocks, includes, menus, shortcuts, references, actions, errors };
}

// ─── Action Block Parser ────────────────────────────────────────────────────

/**
 * Parse a ```act.name fenced code block into an ActionDirective.
 * Line 0: METHOD URI
 * Lines 1+: name: type (required|optional) "description"
 */
const ACTION_BLOCK_FIELD_RE = /^\s+(\w+):\s+(\w+)(?:\s+\((required|optional)\))?(?:\s+"([^"]*)")?(?:\s*=\s*"([^"]*)")?$/;

/** Extract -H "Key: Value" flags from action first line, returning remaining URI and headers. */
function parseHeaderFlags(raw: string): { uri: string; headers: ActionHeader[] } {
  const headers: ActionHeader[] = [];
  const HEADER_RE = /-H\s+"([^"]+)"/g;
  let match;
  while ((match = HEADER_RE.exec(raw)) !== null) {
    const colonIdx = match[1].indexOf(':');
    if (colonIdx !== -1) {
      headers.push({
        key: match[1].slice(0, colonIdx).trim(),
        value: match[1].slice(colonIdx + 1).trim(),
      });
    }
  }
  // URI is everything before the first -H flag
  const hIdx = raw.indexOf(' -H ');
  const uri = (hIdx !== -1 ? raw.slice(0, hIdx) : raw).trim();
  return { uri, headers };
}

function parseActionBlock(id: string, lines: string[], startLine: number): ActionDirective | null {
  if (lines.length === 0) return null;

  const firstLine = lines[0].trim();
  const headerMatch = firstLine.match(/^(GET|POST|PUT|PATCH|DELETE|CLI)\s+(.+)$/i);
  if (!headerMatch) return null;

  const method = headerMatch[1].toLowerCase() as HttpMethod;
  const { uri, headers } = parseHeaderFlags(headerMatch[2]);

  const fields: ActionField[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fieldMatch = lines[i].match(ACTION_BLOCK_FIELD_RE);
    if (fieldMatch) {
      const reqStr = fieldMatch[3] ?? 'optional';
      const field: ActionField = {
        name: fieldMatch[1],
        type: fieldMatch[2],
        required: reqStr.toLowerCase() === 'required',
        constraints: reqStr,
        description: fieldMatch[4] ?? '',
      };
      if (fieldMatch[5] !== undefined) {
        field.defaultValue = fieldMatch[5];
      }
      fields.push(field);
    }
    // Non-matching non-empty lines are ignored (blank lines separate sections)
  }

  return {
    id,
    method,
    uri,
    headers,
    description: '',
    fields,
    responseTemplate: null,
    line: startLine,
  };
}

export function extractBlock(source: string, blockId: string): string | null {
  const lines = source.split('\n');
  let capturing = false;
  const contentLines: string[] = [];

  const openPattern = new RegExp(`^<!-- #${blockId} -->$`);
  const closePattern = new RegExp(`^<!-- \\/${blockId} -->$`);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!capturing && openPattern.test(trimmed)) {
      capturing = true;
      continue;
    }
    if (capturing && closePattern.test(trimmed)) {
      break;
    }
    if (capturing) {
      contentLines.push(line);
    }
  }

  return capturing ? contentLines.join('\n').trim() : null;
}
