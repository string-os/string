/**
 * String — Document Resolver
 * Resolves [!include:id] and [!menu:name] / [!nav:name] directives into a fully
 * LoadedDocument. Detects circular references.
 */

import { parse } from '@string-os/core';
import type { Loader } from './loader.js';
import type { LoadedDocument, ResolvedMenuEntry } from './types.js';
import { StringError } from './types.js';

// [Label][@id] or [Label][@ns.id] — shortcut invocation written by AI
const INVOKE_RE = /\[([^\]]+)\]\[@([a-zA-Z0-9._-]+)\]/g;

/**
 * Resolve a raw SFMD source into a LoadedDocument.
 * All [!include], [!menu], and [!nav] directives are processed.
 * Action directives are indexed by id for fast lookup.
 */
export async function resolve(
  uri: string,
  source: string,
  loader: Loader,
  visited: Set<string> = new Set(),
  rawSource?: string,
): Promise<LoadedDocument> {
  if (visited.has(uri)) {
    throw new StringError('CIRCULAR_REFERENCE', `Circular include detected: ${uri}`);
  }
  visited.add(uri);

  const parsed = parse(source);

  // ── Capture parse errors as warnings ──────────────────────────────────────
  const parseWarnings: string[] = [];
  for (const error of parsed.errors) {
    parseWarnings.push(`Line ${error.line}: ${error.message}`);
  }

  // ── Shortcuts ──────────────────────────────────────────────────────────────
  const shortcuts = new Map<string, string>();
  for (const s of parsed.shortcuts) {
    shortcuts.set(s.id, s.href);
  }

  // Merge @-prefixed reference definitions into shortcuts
  for (const [name, url] of parsed.references) {
    if (name.startsWith('@')) {
      const id = name.slice(1);
      if (!shortcuts.has(id)) {
        shortcuts.set(id, url);
      }
    }
  }

  // ── Block IDs (inline) ─────────────────────────────────────────────────────
  const blockIds: string[] = parsed.blocks.map(b => b.id);

  // ── Includes → additional block IDs ───────────────────────────────────────
  for (const inc of parsed.includes) {
    blockIds.push(inc.id);
  }

  // ── Menus and Navs (both stored in parsed.menus) ───────────────────────────
  const menus = new Map<string, ResolvedMenuEntry[]>();

  for (const menuDirective of parsed.menus) {
    const menuUri = loader.resolve(menuDirective.path, uri);

    if (visited.has(menuUri)) {
      throw new StringError(
        'CIRCULAR_REFERENCE',
        `Circular menu/nav reference detected: ${menuUri}`,
      );
    }

    let menuSource: string;
    try {
      const loaded = await loader.load(menuDirective.path, uri);
      menuSource = loaded.source;
    } catch (err) {
      if (err instanceof StringError && err.code === 'NOT_FOUND') {
        menus.set(menuDirective.name, []);
        continue;
      }
      throw err;
    }

    const menuParsed = parse(menuSource);
    const entries: ResolvedMenuEntry[] = menuParsed.shortcuts.map(s => ({
      id: `${menuDirective.name}.${s.id}`,
      label: s.label,
      // Resolve href relative to the menu file so shortcuts work from any page
      href: loader.resolve(s.href, menuUri),
    }));

    menus.set(menuDirective.name, entries);
  }

  // ── Frontmatter ────────────────────────────────────────────────────────────
  const frontmatter = parseFrontmatter(source);

  // ── Shortcut invocation resolution ────────────────────────────────────────
  // [Label][@id] → [@id Label](href) if shortcut known; warn if not.
  const { resolvedSource, warnings } = resolveInvocations(source, shortcuts, menus);

  return {
    uri,
    source: resolvedSource,
    rawSource,
    frontmatter,
    blockIds,
    shortcuts,
    references: parsed.references,
    menus,
    includes: parsed.includes,
    actions: parsed.actions,
    warnings: [...parseWarnings, ...warnings],
  };
}

// ─── Shortcut invocation resolution ──────────────────────────────────────────

function resolveInvocations(
  source: string,
  shortcuts: Map<string, string>,
  menus: Map<string, ResolvedMenuEntry[]>,
): { resolvedSource: string; warnings: string[] } {
  const warnings: string[] = [];

  const resolvedSource = source.replace(INVOKE_RE, (match, label: string, id: string) => {
    // 1. Page-level shortcut (exact)
    if (shortcuts.has(id)) {
      return `[@${id} ${label}](${shortcuts.get(id)})`;
    }

    // 2. Menu entry — exact match first, then unnamespaced suffix match
    for (const entries of menus.values()) {
      const entry =
        entries.find(e => e.id === id) ??
        entries.find(e => e.id.endsWith(`.${id}`));
      if (entry) {
        // Use the full namespaced ID so the rendered form teaches the correct syntax
        return `[@${entry.id} ${label}](${entry.href})`;
      }
    }

    // 3. Unknown — warn and leave as-is so the AI can see and fix it
    warnings.push(`Unknown shortcut @${id} — define with: [@${id} ${label}](URI)`);
    return match;
  });

  return { resolvedSource, warnings };
}

// ─── Frontmatter Parser ───────────────────────────────────────────────────────

function parseFrontmatter(source: string): Record<string, unknown> {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const result: Record<string, unknown> = {};
  const lines = match[1].split('\n');
  let currentKey: string | null = null;
  let currentList: unknown[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // List item: "  - KEY: value" (object entry) or "  - VALUE" (plain scalar)
    if (currentList !== null && /^\s+-\s/.test(line)) {
      const itemContent = line.replace(/^\s+-\s*/, '');
      const colonIdx = itemContent.indexOf(':');
      if (colonIdx !== -1) {
        const itemKey = itemContent.slice(0, colonIdx).trim();
        const itemValue = itemContent.slice(colonIdx + 1).trim();
        const entry: Record<string, unknown> = {};
        entry[itemKey] = parseYamlScalar(itemValue);
        currentList.push(entry);
      } else {
        currentList.push(parseYamlScalar(itemContent.trim()));
      }
      continue;
    }

    // Indented key under a list item (e.g. "    default: en")
    if (currentList !== null && /^\s{4,}\w/.test(line)) {
      const trimmed = line.trim();
      const colonIdx = trimmed.indexOf(':');
      const lastEntry = currentList.length > 0 ? currentList[currentList.length - 1] : null;
      if (colonIdx !== -1 && lastEntry && typeof lastEntry === 'object') {
        const subKey = trimmed.slice(0, colonIdx).trim();
        const subValue = trimmed.slice(colonIdx + 1).trim();
        (lastEntry as Record<string, unknown>)[subKey] = parseYamlScalar(subValue);
      }
      continue;
    }

    // Top-level key: "key: value"
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (!key || key.startsWith('-')) continue;

    // Finalize any pending list
    if (currentList !== null && currentKey !== null) {
      result[currentKey] = currentList;
      currentList = null;
      currentKey = null;
    }

    // Check if this starts a list (value is empty, next line is "  - ...")
    if (value === '' && i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
      currentKey = key;
      currentList = [];
      continue;
    }

    result[key] = parseYamlScalar(value);
  }

  // Finalize any pending list
  if (currentList !== null && currentKey !== null) {
    result[currentKey] = currentList;
  }

  return result;
}

function parseYamlScalar(value: string): unknown {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map(v => v.trim().replace(/^['"]|['"]$/g, ''));
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  const num = Number(value);
  if (!isNaN(num) && value !== '') return num;
  return value.replace(/^['"]|['"]$/g, '');
}
