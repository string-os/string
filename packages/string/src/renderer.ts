/**
 * String — Renderer
 * Transforms a LoadedDocument into the viewport string seen by AI agents.
 *
 * Transformations:
 * 1. If blockId given: extract only that block's content
 * 2. Strip YAML frontmatter (AI gets it via /info)
 * 3. Strip SFMD directives ([!menu:] / [!nav:] / [!include:]) and action code blocks (```act.*)
 * 4. Strip <!-- #id --> / <!-- /id --> markers
 * 5. Hide URLs: [@id Label](url) → [Label][@id]
 * 6. Auto-slugify plain https links
 * 7. Prepend nav/action hints
 */

import { extract } from '@string-os/core';
import { toSlug } from '@string-os/core';
import type { LoadedDocument } from './types.js';
import type { Loader } from './loader.js';

// [@shortcut_id Label](href) — IDs may include dots for namespaced menu entries
const SHORTCUT_RE = /\[(@[a-zA-Z0-9._-]+)\s+([^\]]+)\]\([^)]+\)/g;
// Plain markdown link — excludes shortcut refs (@). Allows empty label [](url).
const PLAIN_LINK_RE = /\[([^\]]*)\]\((?![@])([^)]+)\)/g;
// [!include:id](path) — include directive
const INCLUDE_RE = /\[!include:([a-zA-Z0-9_-]+)\]\(([^)]+)\)/g;
// Standard Markdown reference link: [text][ref] — excludes @-prefixed (SFMD shortcuts)
const REF_LINK_RE = /\[([^\]]+)\]\[([^\]@][^\]]*)\]/g;
// Reference definition line: [name]: url (stripped from AI view)
const REF_DEF_LINE_RE = /^\[[^\]]+\]:\s+\S/;

// Block markers to strip
const BLOCK_OPEN_RE = /^<!-- #[a-zA-Z0-9_-]+ -->$/;
const BLOCK_CLOSE_RE = /^<!-- \/[a-zA-Z0-9_-]+ -->$/;
// SFMD directive lines ([!menu:...], [!nav:...], [!include:...])
const DIRECTIVE_LINE_RE = /^\[!(menu|nav|include):[a-zA-Z0-9_-]+[^\]]*\]\(.*\)$/;

// ─── Include Expansion ────────────────────────────────────────────────────────

/**
 * Check if a position in source is inside a fenced code block.
 */
function isInFencedBlock(source: string, position: number): boolean {
  const beforePos = source.slice(0, position);
  const lines = beforePos.split('\n');
  let inFence = false;

  // Check all complete lines before the position
  for (let i = 0; i < lines.length - 1; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
    }
  }

  return inFence;
}

/**
 * Check if a position in source is inside an inline code span (backticks).
 */
function isInInlineCode(source: string, position: number): boolean {
  // Find the line containing this position
  const beforePos = source.slice(0, position);
  const lastNewline = beforePos.lastIndexOf('\n');
  const lineStart = lastNewline + 1;
  const posInLine = position - lineStart;

  // Extract the line up to the position
  const lineBeforePos = source.slice(lineStart, position);

  // Count unescaped backticks before position in the current line
  let backticks = 0;
  let escapeNext = false;

  for (let i = 0; i < lineBeforePos.length; i++) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (lineBeforePos[i] === '\\') {
      escapeNext = true;
      continue;
    }
    if (lineBeforePos[i] === '`') {
      backticks++;
    }
  }

  // Odd number of backticks = inside code span
  return backticks % 2 === 1;
}

/**
 * Check if a position is inside any code context (fenced block or inline code).
 */
function isInCodeContext(source: string, position: number): boolean {
  return isInFencedBlock(source, position) || isInInlineCode(source, position);
}

/**
 * Check if a match is a standalone directive line (not embedded in prose).
 * A directive is standalone if:
 * - It appears at the start of a line (after optional whitespace)
 * - It's the only content on that line (no text before or after)
 */
function isStandaloneLine(source: string, matchStart: number, matchEnd: number): boolean {
  // Find line boundaries
  const beforeMatch = source.slice(0, matchStart);
  const afterMatch = source.slice(matchEnd);

  const lineStart = beforeMatch.lastIndexOf('\n') + 1;
  const lineEnd = afterMatch.indexOf('\n');

  // Extract content before and after the match on the same line
  const beforeOnLine = source.slice(lineStart, matchStart);
  const afterOnLine = lineEnd === -1
    ? afterMatch
    : afterMatch.slice(0, lineEnd);

  // Check if before/after content is only whitespace
  const onlyWhitespaceBefore = beforeOnLine.trim() === '';
  const onlyWhitespaceAfter = afterOnLine.trim() === '';

  return onlyWhitespaceBefore && onlyWhitespaceAfter;
}

/**
 * Expand [!include:id](path) directives inline.
 * Resolves the topic file, extracts the specified block, and replaces the directive.
 *
 * STANDALONE LINE SEMANTICS:
 * - Directives inside fenced code blocks (``` or ~~~) are NOT expanded
 * - Directives inside inline code spans (backticks) are NOT expanded
 * - Directives embedded in prose (not standalone lines) are NOT expanded
 * - Only standalone directive lines in normal prose context are processed
 *
 * A directive is standalone if:
 * - It appears at the start of a line (after optional whitespace)
 * - It's the only content on that line (no text before or after)
 *
 * Resolution priority (via extract()):
 * 1. Explicit markers: <!-- #id --> ... <!-- /id -->
 * 2. Explicit heading IDs: ## Heading {#id} or ## Heading []{#id}
 * 3. Heading-derived slugs: ## Heading Text
 */
async function expandIncludes(
  source: string,
  docUri: string,
  loader: Loader,
  visited: Set<string> = new Set(),
): Promise<string> {
  // Track visited URIs to prevent cycles
  if (visited.has(docUri)) {
    return source; // Already processing this document, skip to avoid infinite recursion
  }
  visited.add(docUri);

  const matches = [...source.matchAll(INCLUDE_RE)];
  if (matches.length === 0) return source;

  // Filter out includes that should not be expanded:
  // 1. Inside code contexts (fenced blocks or inline code)
  // 2. Not standalone (embedded in prose or mixed-content lines)
  const validMatches = matches.filter(m => {
    const matchStart = m.index!;
    const matchEnd = matchStart + m[0].length;

    // Check code context first (faster check)
    if (isInCodeContext(source, matchStart)) {
      return false;
    }

    // Check if standalone line
    if (!isStandaloneLine(source, matchStart, matchEnd)) {
      return false;
    }

    return true;
  });

  if (validMatches.length === 0) return source;

  let expandedSource = source;

  // Process valid includes from end to start to preserve string indices
  for (let i = validMatches.length - 1; i >= 0; i--) {
    const match = validMatches[i];
    const blockId = match[1];
    const includePath = match[2];
    const matchStart = match.index!;
    const matchEnd = matchStart + match[0].length;

    try {
      // Resolve include path relative to current document
      const includeUri = loader.resolve(includePath, docUri);

      // Check for circular includes
      if (visited.has(includeUri)) {
        const error = `⚠ Circular include detected: ${includePath} (already included in this chain)`;
        expandedSource = expandedSource.slice(0, matchStart) + error + expandedSource.slice(matchEnd);
        continue;
      }

      // Load the topic file
      const loaded = await loader.load(includePath, docUri);

      // Extract the specified block (supports markers, explicit IDs, and slugs)
      const result = extract(loaded.source, blockId);

      if (!result.found) {
        const error = `⚠ Include failed: Block #${blockId} not found in ${includePath}\n` +
          `Supported formats:\n` +
          `  1. Markers: <!-- #${blockId} --> ... <!-- /${blockId} -->\n` +
          `  2. Explicit ID: ## Heading {#${blockId}}\n` +
          `  3. Heading slug: ## Heading Text (where slug matches "${blockId}")`;
        expandedSource = expandedSource.slice(0, matchStart) + error + expandedSource.slice(matchEnd);
        continue;
      }

      // Recursively expand includes in the included content
      const expandedContent = await expandIncludes(result.content, includeUri, loader, new Set(visited));

      // Replace the include directive with the expanded content
      expandedSource = expandedSource.slice(0, matchStart) + expandedContent + expandedSource.slice(matchEnd);

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const error = `⚠ Include failed: ${includePath} - ${errorMsg}`;
      expandedSource = expandedSource.slice(0, matchStart) + error + expandedSource.slice(matchEnd);
    }
  }

  return expandedSource;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface RenderResult {
  content: string;
  /** Auto-generated shortcut id → href (for resolving @github, @docs-2, @link-1 etc.) */
  autoShortcuts: Map<string, string>;
}

export async function render(
  doc: LoadedDocument,
  blockId?: string,
  home?: string,
  loader?: Loader,
): Promise<RenderResult> {
  let source = doc.source;

  // 1. Extract block or strip frontmatter
  if (blockId) {
    const result = extract(source, blockId);
    if (!result.found) return { content: `Block not found: #${blockId}`, autoShortcuts: new Map() };
    source = result.content;
  } else {
    source = stripFrontmatter(source);
  }

  // 1.5. Expand include directives (if loader provided)
  if (loader && !blockId) {
    source = await expandIncludes(source, doc.uri, loader);
  }

  // 2. Strip block markers and SFMD directive lines (including action fields)
  source = stripAimdMarkup(source);

  // 3. Resolve standard Markdown reference links: [text][ref] → [text](url)
  if (doc.references.size > 0) {
    REF_LINK_RE.lastIndex = 0;
    source = source.replace(REF_LINK_RE, (match, text: string, ref: string) => {
      const url = doc.references.get(ref);
      return url ? `[${text}](${url})` : match;
    });
  }

  // 4. Replace shortcut links: [@id Label](url) → [Label][@id]
  source = source.replace(SHORTCUT_RE, (_match, rawId: string, label: string) => {
    const id = rawId.slice(1);
    return `[${label}][@${id}]`;
  });

  // 5. Auto-slugify plain https links
  const { offsets, shortcuts: autoShortcuts } = buildSlugMap(source);
  source = source.replace(
    PLAIN_LINK_RE,
    (_match, label: string, _href: string, offset: number) => {
      const slug = offsets.get(offset);
      if (!slug) return _match;
      const display = label || slug;
      return `[${display}][@${slug}]`;
    },
  );

  // 6. Prepend hints and warnings
  const hints: string[] = [];

  if (!blockId && doc.warnings.length > 0) {
    for (const w of doc.warnings) hints.push(`[!] ${w}`);
  }
  if (!blockId && doc.menus.size > 0) {
    const menuNames = [...doc.menus.keys()].join(', ');
    hints.push(`[nav] ${menuNames} — /nav <name>`);
  }
  if (!blockId && doc.actions.length > 0) {
    const actionHints = doc.actions.map(a => {
      const flags = a.fields.filter(f => f.required).map(f => `--${f.name} <${f.type}>`);
      const flagStr = flags.length > 0 ? ' ' + flags.join(' ') : '';
      return `/act.${a.id}${flagStr}`;
    }).join(' | ');
    hints.push(`[actions] ${actionHints}`);
    hints.push(`          /act.<name> --help for details`);
  }

  if (hints.length > 0) {
    source = hints.join('\n') + '\n\n' + source;
  }

  return { content: source.trim(), autoShortcuts };
}

/** Render the entries of a named menu. */
export function renderNav(menuName: string, doc: LoadedDocument): string {
  const entries = doc.menus.get(menuName);
  if (!entries) return `Menu not found: ${menuName}`;
  if (entries.length === 0) return `Menu ${menuName} is empty.`;
  return entries.map(e => `[${e.label}][@${e.id}]`).join('\n');
}

/** Render a list of all menus on the current document. */
export function renderNavList(doc: LoadedDocument): string {
  if (doc.menus.size === 0) {
    // Document is open, but no menus are registered
    const lines: string[] = [];
    lines.push('Document is open, but no menus are registered on this page.');
    lines.push('');
    lines.push('You can create a starter nav scaffold from links on this page.');
    lines.push('');
    lines.push('Try: /nav scaffold');
    return lines.join('\n');
  }

  const lines: string[] = [];
  for (const [name, entries] of doc.menus) {
    const count = entries.length;
    const preview = entries.slice(0, 3).map(e => e.label).join(', ');
    const more = count > 3 ? `, ... (${count - 3} more)` : '';
    lines.push(`${name} (${count}): ${preview}${more}`);
  }
  lines.push('');
  lines.push('use: /nav <name> to show menu · /open @menu.id to follow link');
  return lines.join('\n');
}

/**
 * Render all actions (or a single action) with their field schemas.
 * Called by /act and /act.<id> --help.
 */
export function renderActions(doc: LoadedDocument, singleId?: string): string {
  const list = singleId
    ? doc.actions.filter(a => a.id === singleId)
    : doc.actions;

  if (list.length === 0) {
    return singleId
      ? `Action not found: ${singleId}`
      : 'No actions defined on this page.';
  }

  return list
    .map(a => {
      // Header is the action's verb only — `/act.<id>`. The method (POST,
      // CLI, etc.) and the URL/template are *implementation* details, not
      // part of the call interface the agent needs to invoke the action.
      // Hiding them keeps the help surface focused on "what to call, what
      // to pass". For inspecting the underlying request, use `/source` to
      // dump the raw .md file.
      const header = `/act.${a.id}`;
      const desc = a.description ? `\n   ${a.description}` : '';
      const fields =
        a.fields.length > 0
          ? '\n' +
            a.fields
              .map(
                f =>
                  `   --${f.name} <${f.type}>${f.required ? ' (required)' : ' (optional)'}${f.description ? ' — ' + f.description : ''}`,
              )
              .join('\n')
          : '\n   (no flags)';
      return header + desc + fields;
    })
    .join('\n\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripFrontmatter(source: string): string {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/**
 * Strip block markers, SFMD directive lines, and action code blocks (```act.*).
 */
function stripAimdMarkup(source: string): string {
  let inFencedBlock = false;
  let inActionBlock = false;

  return source
    .split('\n')
    .filter(line => {
      const t = line.trim();

      // Track fenced code blocks
      if (t.startsWith('```') || t.startsWith('~~~')) {
        if (inFencedBlock) {
          // Closing fence
          if (inActionBlock) {
            inActionBlock = false;
            inFencedBlock = false;
            return false;
          }
          inFencedBlock = false;
          return true;
        } else {
          // Opening fence — check for act.* info string
          const info = t.slice(3).trim();
          if (/^act\.[a-zA-Z0-9_-]+(?:\.response)?$/.test(info)) {
            inActionBlock = true;
            inFencedBlock = true;
            return false;
          }
          inFencedBlock = true;
          return true;
        }
      }

      // Inside action code blocks: strip everything
      if (inActionBlock) return false;

      // Inside regular fenced blocks: keep everything
      if (inFencedBlock) return true;

      // Block markers
      if (BLOCK_OPEN_RE.test(t) || BLOCK_CLOSE_RE.test(t)) return false;

      // SFMD directive lines (menu/nav/include)
      if (DIRECTIVE_LINE_RE.test(t)) return false;

      // Reference definition lines: [name]: url
      if (REF_DEF_LINE_RE.test(t)) return false;

      return true;
    })
    .join('\n');
}

interface SlugMapResult {
  /** offset → slug id (for positional replacement) */
  offsets: Map<number, string>;
  /** slug id → href (for shortcut resolution) */
  shortcuts: Map<string, string>;
}

/**
 * Build a map of string offset → slug for plain https links,
 * plus a reverse map of slug → href for shortcut resolution.
 */
function buildSlugMap(source: string): SlugMapResult {
  const offsets = new Map<number, string>();
  const shortcuts = new Map<string, string>();
  const seen = new Set<string>();
  /** Per-slug duplicate counters: slug → next suffix number */
  const slugCount = new Map<string, number>();
  let linkCounter = 1;

  PLAIN_LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = PLAIN_LINK_RE.exec(source)) !== null) {
    const label = match[1];
    const href = match[2];
    // Only auto-slug full URLs (https?://) or very long paths (> 40 chars)
    const shouldSlug = href.startsWith('http://') || href.startsWith('https://') || href.length > 40;
    if (!shouldSlug) continue;

    const slug = toSlug(label);
    const canSlug = label.length <= 20 && /^[a-zA-Z0-9\s-]+$/.test(label) && slug !== '';

    let id: string;
    if (canSlug) {
      if (!seen.has(slug)) {
        // First occurrence — use slug directly
        id = slug;
        slugCount.set(slug, 2);
      } else {
        // Duplicate slug — append -{N}
        const n = slugCount.get(slug) ?? 2;
        id = `${slug}-${n}`;
        slugCount.set(slug, n + 1);
      }
    } else {
      // Non-sluggable — generic fallback
      id = `link-${linkCounter++}`;
    }
    seen.add(id);
    offsets.set(match.index, id);
    shortcuts.set(id, href);
  }

  PLAIN_LINK_RE.lastIndex = 0;
  return { offsets, shortcuts };
}
