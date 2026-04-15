/**
 * Info commands: /info, /source, /ls, /help, bash info
 */

import fsPromises from 'fs/promises';
import path from 'path';
import type { Loader } from '../loader.js';
import type { Session } from '../session.js';
import type { CommandResult } from '../types.js';
import { parseTopic } from '../types.js';
import { renderActions } from '../renderer.js';
import {
  ok, err,
  resolveFilePath,
  validateWorkspaceBoundary,
} from './helpers.js';

// ─── /info ────────────────────────────────────────────────────────────────────

export function cmdInfo(args: string, session: Session, loader: Loader): CommandResult {
  // /info @shortcut — resolve and display
  const trimmedArgs = args.trim();
  if (trimmedArgs.startsWith('@')) {
    const id = trimmedArgs.slice(1);
    const href = session.resolveShortcut(id);
    if (!href) return err(`Shortcut not found: ${trimmedArgs}`, 'NOT_FOUND');
    return ok(`@${id} → ${href}`);
  }

  const lines: string[] = [];
  const doc = session.currentDoc;
  const topic = parseTopic(session.name);

  if (!doc) {
    // Show cwdOverride if set (from /open directory), else ~/
    if (session.cwdOverride) {
      const absDir = session.cwdOverride;
      if (absDir.startsWith(loader.home)) {
        const rel = path.relative(loader.home, absDir);
        lines.push(`cwd:       ~/${rel ? rel + '/' : ''}`);
      } else {
        lines.push(`cwd:       ${absDir}/`);
      }
    } else {
      lines.push(`cwd:       ~/`);
    }
    lines.push('file:      (none open)');
    return ok(`Session info\n---\n${lines.join('\n')}`);
  }

  const uri = doc.uri;
  const fm = doc.frontmatter;

  // ── Identity (topic-type specific) ──────────────────────────────────────
  if (topic?.type === 'app') {
    lines.push(`app:       ${topic.namespace}`);
    if (typeof fm.name === 'string' && fm.name) lines.push(`name:      ${fm.name}`);
    if (typeof fm.version === 'string' && fm.version) lines.push(`version:   ${fm.version}`);
  } else if (topic?.type === 'web' || uri.startsWith('https://') || uri.startsWith('http://')) {
    lines.push(`url:       ${uri}`);
  } else if (uri.startsWith('file://')) {
    const absPath = new URL(uri).pathname;
    const relPath = absPath.startsWith(loader.home)
      ? path.relative(loader.home, absPath)
      : absPath;
    lines.push(`file:      ${relPath}`);

    // cwdOverride takes priority over document directory
    const absDir = session.cwdOverride ?? path.dirname(absPath);
    if (absDir.startsWith(loader.home)) {
      const relDir = path.relative(loader.home, absDir);
      lines.push(`cwd:       ~/${relDir ? relDir + '/' : ''}`);
    } else {
      lines.push(`cwd:       ${absDir}/`);
    }
  } else {
    lines.push(`uri:       ${uri}`);
  }

  // ── Common (SFMD document) ───────────────────────────────────────────────
  if (typeof fm.title === 'string' && fm.title) lines.push(`title:     ${fm.title}`);
  if (session.currentBlockId) lines.push(`block:     #${session.currentBlockId}`);
  if (doc.blockIds.length > 0) lines.push(`blocks:    ${doc.blockIds.join(', ')}`);
  if (doc.menus.size > 0) lines.push(`menus:     ${[...doc.menus.keys()].join(', ')}`);
  const shortcutCount = doc.shortcuts.size + session.autoShortcuts.size;
  if (shortcutCount > 0) {
    const parts = [...doc.shortcuts.keys()].map(k => `@${k}`);
    if (session.autoShortcuts.size > 0) parts.push(`+${session.autoShortcuts.size} auto`);
    lines.push(`shortcuts: ${parts.join(', ')}`);
  }
  if (doc.actions.length > 0) lines.push(`actions:   ${doc.actions.map(a => `${a.id}(${a.method.toUpperCase()})`).join(', ')}`);
  if (doc.rawSource) lines.push(`source:    converted from HTML (use /source to view original)`);
  lines.push(`history:   ${session.historyLength} entries`);

  const vars = session.getAllVars();
  if (vars.size > 0) lines.push(`vars:      ${[...vars.entries()].map(([k, v]) => `{${k}}="${v}"`).join(', ')}`);

  if (doc.warnings && doc.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of doc.warnings) lines.push(`  ${w}`);
  }

  return ok(`Session info\n---\n${lines.join('\n')}`);
}

// ─── /source ──────────────────────────────────────────────────────────────────

export function cmdSource(session: Session): CommandResult {
  const doc = session.currentDoc;
  if (!doc) return err('No document open.', 'INVALID_TARGET');

  const source = doc.rawSource ?? doc.source;
  return ok(`[source: ${doc.uri}]\n---\n${source}`);
}

// ─── //info (bash) ────────────────────────────────────────────────────────────

export function cmdBashInfo(session: Session, loader: Loader): CommandResult {
  const lines: string[] = [];
  const bash = session.bashSession;

  if (bash?.alive) {
    const absCwd = bash.cwd;
    if (absCwd.startsWith(loader.home)) {
      const rel = path.relative(loader.home, absCwd);
      lines.push(`cwd:       ~/${rel ? rel + '/' : ''}`);
    } else {
      lines.push(`cwd:       ${absCwd}`);
    }
    lines.push(`pid:       ${bash.alive ? 'running' : 'stopped'}`);
  } else {
    lines.push('cwd:       (no active shell)');
  }

  // Session variables
  const vars = session.getAllVars();
  if (vars.size > 0) {
    lines.push(`vars:      ${[...vars.entries()].map(([k, v]) => `{${k}}="${v}"`).join(', ')}`);
  }

  return ok(`Bash session info\n---\n${lines.join('\n')}`);
}

// ─── /help ────────────────────────────────────────────────────────────────────

export function cmdHelp(session: Session, mode?: 'bash'): CommandResult {
  // Bash topic: limited meta-commands with // prefix
  if (mode === 'bash') {
    const lines: string[] = [];
    lines.push('All input is sent to shell stdin.');
    lines.push('Use // prefix for String meta-commands:');
    lines.push('');
    lines.push('//help                       Show this help');
    lines.push('//info                       Session info');
    lines.push('//close                      Close this bash session');
    return ok(`Bash Session\n---\n${lines.join('\n')}`);
  }

  const lines: string[] = [];

  lines.push('## String Commands');
  lines.push('');
  lines.push('All input must start with /.');
  lines.push('');
  lines.push('### Navigation');
  lines.push('/open <path|url|@shortcut>   Open document, URL, or shortcut');
  lines.push('/open <path>#<block>         Open a specific block');
  lines.push('/back                        Go back in history');
  lines.push('/refresh                     Reload current document');
  lines.push('/close                       Close current document');
  lines.push('/nav [menu]                  Show navigation menus');
  lines.push('/info                        Document state, variables, actions');
  lines.push('/ls [path]                   List files in workspace');
  lines.push('/help                        Show this help');
  lines.push('');
  lines.push('### Actions');
  lines.push('/act                         List actions on current document');
  lines.push('/act.<name> --help           Show action schema and flags');
  lines.push('/act.<name> --flag value     Execute action with POSIX flags');
  lines.push('');
  lines.push('### State');
  lines.push('/set                         List session variables');
  lines.push('/set {var} = "value"         Set a session variable');
  lines.push('/set {var} = \'value\'         Single quotes also work');
  lines.push('/set with ```{var} block     Multiline value via code block');
  lines.push('');
  lines.push('### Editing');
  lines.push('/edit <path>[#block]         View raw source with line numbers');
  lines.push('/edit <path>[#block]         Edit with body: replace content');
  lines.push('/write <path>[#block]        Create or overwrite file/block');
  lines.push('/append <path>               Append to file');
  lines.push('/verify <path>#block         Verify block exists and show content');
  lines.push('');
  lines.push('### Sessions');
  lines.push('/session                     List sessions in current scheme');
  lines.push('/session close [name]        Close a session');
  lines.push('');
  lines.push('### Tools');
  lines.push('/tool:<name>                  Run tool (default action)');
  lines.push('/tool:<name>.<act>            Run specific tool action');
  lines.push('/tool:<name> --flag value     Pass flags to tool');
  lines.push('');
  lines.push('### Shell');
  lines.push('/exec <command>               Run shell command (stateless)');
  lines.push('');
  lines.push('### Packages');
  lines.push('/install <source>             Install app/tool from file or URL');
  lines.push('/install --app <source>       Install as app');
  lines.push('/install --tool <source>      Install as tool');
  lines.push('/uninstall <name>             Uninstall a package');

  // Context-aware: show current document's actions
  const doc = session.currentDoc;
  if (doc && doc.actions.length > 0) {
    lines.push('');
    lines.push('## Actions on this page');
    for (const a of doc.actions) {
      // Required-fields-only signature, no method/URL — see comment in
      // renderer.renderActions for the rationale. Matches the format used
      // by the [actions] hint that the renderer prepends on /open.
      const flags = a.fields.filter(f => f.required).map(f => `--${f.name} <${f.type}>`);
      const flagStr = flags.length > 0 ? ' ' + flags.join(' ') : '';
      lines.push(`/act.${a.id}${flagStr}`);
    }
  }

  return ok(`String Commands\n---\n${lines.join('\n')}`);
}

// ─── /ls ──────────────────────────────────────────────────────────────────────

export async function cmdLs(args: string, session: Session, loader: Loader): Promise<CommandResult> {
  const home = loader.home;
  const topic = args.trim() || '.';

  const resolved = resolveFilePath(topic, home, session.currentUri, session.cwdOverride);

  // Security: must be within home
  const boundaryError = validateWorkspaceBoundary(resolved, home, topic, loader.accessMode);
  if (boundaryError) return boundaryError;

  try {
    const stat = await fsPromises.stat(resolved);
    if (!stat.isDirectory()) {
      return err(`Not a directory: ${topic}`, 'INVALID_TARGET');
    }
  } catch {
    return err(`Not found: ${topic}`, 'NOT_FOUND');
  }

  const entries = await fsPromises.readdir(resolved, { withFileTypes: true });
  entries.sort((a, b) => {
    // Dirs first, then files; alphabetical within each group
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const relPath = path.relative(home, resolved) || '.';

  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // skip hidden files
    if (entry.isDirectory()) {
      lines.push(`  ${entry.name}/`);
    } else {
      lines.push(`  ${entry.name}`);
    }
  }

  if (lines.length === 0) lines.push('  (empty)');
  return ok(`Listing ${relPath}/\n---\n${lines.join('\n')}`);
}
