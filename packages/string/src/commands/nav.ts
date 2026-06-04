/**
 * /nav command handler.
 */

import type { Loader } from '../loader.js';
import type { Session } from '../session.js';
import type { CommandResult } from '../types.js';
import { renderNav, renderNavList } from '../renderer.js';
import { ok, err } from './helpers.js';
import { hydrateAppDocument } from './app-session.js';

export async function cmdNav(args: string, session: Session, loader: Loader): Promise<CommandResult> {
  let doc = session.currentDoc;
  if (!doc) {
    // Auto-open: see cmdAction for rationale. tab/bash/hub still error.
    const hydrateResult = await hydrateAppDocument(session, loader);
    if (hydrateResult) return hydrateResult;
    doc = session.currentDoc;
    if (!doc) {
      return err('No document is open in this session. Open a document first, then run /nav again.', 'INVALID_TARGET');
    }
  }

  const menuName = args.trim();

  // Handle /nav page — show all shortcuts on current page
  if (menuName === 'page') {
    const lines: string[] = [];

    // Author-defined shortcuts
    if (doc.shortcuts.size > 0) {
      lines.push('Shortcuts:');
      for (const [id, href] of doc.shortcuts) {
        lines.push(`  @${id} → ${href}`);
      }
    }

    // Auto-generated shortcuts (from render)
    if (session.autoShortcuts.size > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('Auto:');
      for (const [id, href] of session.autoShortcuts) {
        lines.push(`  @${id} → ${href}`);
      }
    }

    if (lines.length === 0) {
      return ok('No shortcuts on this page.');
    }

    lines.push('');
    lines.push('use: /open @id');
    return ok(lines.join('\n'));
  }

  // Handle /nav scaffold - generate nav template from links on page
  if (menuName === 'scaffold' || menuName === 'create' || menuName === 'bootstrap') {
    // Extract ordinary markdown links from source (not shortcuts, not directives)
    const linkPattern = /\[([^\]]+)\]\((?![@!])([^)]+)\)/g;
    const links: Array<{ label: string; url: string }> = [];

    let match;
    while ((match = linkPattern.exec(doc.source)) !== null) {
      const label = match[1];
      const url = match[2];
      // Skip action invocations and other special patterns
      if (!url.startsWith('▶') && !url.startsWith('action:')) {
        links.push({ label, url });
      }
    }

    // Also include existing shortcuts if any
    const existingShortcuts = Array.from(doc.shortcuts.entries()).map(([id, href]) => ({
      label: id,
      url: href,
      id
    }));

    if (links.length === 0 && existingShortcuts.length === 0) {
      return ok(
        'No links found on this page.\n\n' +
        'Nav scaffolding extracts links from the current page and generates shortcut templates.\n' +
        'Add some links to your document first using [Label](url) syntax.'
      );
    }

    const lines: string[] = [];
    lines.push('Copy and edit the shortcuts below to create a nav file:');
    lines.push('');
    lines.push('```markdown');

    // Show existing shortcuts first
    for (const shortcut of existingShortcuts) {
      lines.push(`[@${shortcut.id} ${shortcut.label}](${shortcut.url})`);
    }

    // Generate shortcut templates from ordinary links
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      // Generate a simple ID from the label (slugify)
      const id = link.label.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 20);
      lines.push(`[@${id} ${link.label}](${link.url})`);
    }

    lines.push('```');
    lines.push('');
    lines.push('Then save to a file (e.g., nav/main.md) and reference it:');
    lines.push('[!nav:main](./nav/main.md)');

    return ok(`Nav Scaffold\n---\n${lines.join('\n')}`);
  }

  if (!menuName) {
    return ok(`Menus\n---\n${renderNavList(doc)}`);
  }

  if (!doc.menus.has(menuName)) {
    return err(`Menu not found: ${menuName}`, 'NOT_FOUND');
  }

  return ok(`Menu: ${menuName}\n---\n${renderNav(menuName, doc)}`);
}
