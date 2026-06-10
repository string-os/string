/**
 * Info commands: /info, /source, /ls, /help, bash info
 */

import fsPromises from 'fs/promises';
import path from 'path';
import type { Loader } from '../loader.js';
import type { Session } from '../session.js';
import type { CommandResult, TopicType } from '../types.js';
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
    const resolved = session.resolveShortcut(id);
    if (resolved === null) return err(`Shortcut not found: ${trimmedArgs}`, 'NOT_FOUND');
    const display = Array.isArray(resolved)
      ? `(${resolved.join(', ')})`
      : resolved;
    return ok(`@${id} → ${display}`);
  }

  const lines: string[] = [];
  const doc = session.currentDoc;
  const topic = parseTopic(session.name);

  if (!doc) {
    // app:NAME topic with no document loaded — report installation state
    // explicitly so callers (especially MCP agents) get an actionable body
    // instead of a generic "(none open)". Mirrors /open's resolution error.
    if (topic?.type === 'app') {
      const appName = topic.namespace;
      const registered = loader.envStore.getPackage('apps', appName);
      lines.push(`app:       ${appName}`);
      if (registered) {
        lines.push(`status:    installed, not yet opened`);
        lines.push(`hint:      run /open to load the app`);
      } else {
        const installed = Object.keys(loader.envStore.listPackages('apps'));
        lines.push(`status:    not installed`);
        if (installed.length > 0) {
          lines.push(`installed: ${installed.join(', ')}`);
        } else {
          lines.push(`installed: (none)`);
        }
        lines.push(`hint:      run /install <source> to install this app`);
      }
      return ok(`Session info\n---\n${lines.join('\n')}`);
    }

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
  } else if (uri.startsWith('https://') || uri.startsWith('http://')) {
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
  // Enumerate shortcut names so an agent reading /info can call them
  // directly with `/open @<name>`. Auto-shortcuts get listed alongside
  // author-defined ones — for the caller the distinction is academic, the
  // invocation shape is the same. Long lists cap at 12 + a "+N more" tail
  // so a 50-link page doesn't blow up the info block.
  const allShortcuts = [
    ...[...doc.shortcuts.keys()].map(k => `@${k}`),
    ...[...session.autoShortcuts.keys()].map(k => `@${k}`),
  ];
  if (allShortcuts.length > 0) {
    const cap = 12;
    const shown = allShortcuts.slice(0, cap).join(', ');
    const more = allShortcuts.length - cap;
    const tail = more > 0 ? `, +${more} more (${allShortcuts.length} total)` : '';
    lines.push(`shortcuts: ${shown}${tail}`);
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
  lines.push('/replace <path|path#block|path:Lx>  Replace text, block, line, or range');
  lines.push('/verify <path>#block         Verify block exists and show content');
  lines.push('');
  lines.push('### Topics (sessions)');
  lines.push('/topics                      List active topics');
  lines.push('/topics <type>               Filter by type: tab, app, bash, hub');
  lines.push('/sessions                    Alias of /topics');
  lines.push('/session close [name]        Close a session by name');
  lines.push('');
  lines.push('### Tools');
  lines.push('/tool:<name>                  Run tool (default action)');
  lines.push('/tool:<name>.<act>            Run specific tool action');
  lines.push('/tool:<name> --flag value     Pass flags to tool');
  lines.push('');
  lines.push('### Events');
  lines.push('/events                       List pending agent events');
  lines.push('/events.read <id>             Read full event text');
  lines.push('/events.ack <id>              Mark an event handled');
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
      const flags = a.fields.filter(f => f.required).map(f => {
        const alias = f.short ? `-${f.short}/` : '';
        return `${alias}--${f.name} <${f.type}>`;
      });
      const flagStr = flags.length > 0 ? ' ' + flags.join(' ') : '';
      lines.push(`/act.${a.id}${flagStr}`);
    }
  }

  return ok(`String Commands\n---\n${lines.join('\n')}`);
}

// ─── /ls ──────────────────────────────────────────────────────────────────────

export async function cmdLs(
  args: string,
  session: Session,
  loader: Loader,
  topicType?: TopicType,
): Promise<CommandResult> {
  const home = loader.home;
  const topic = args.trim() || '.';

  // /ls is filesystem-only. App / bash / hub topics, or remote-URL contexts,
  // have no filesystem listing semantics — surface a clear redirect rather
  // than letting the user hit an opaque boundary error or "not found".
  //   1. Explicit topicType (passed from daemon for new topics)
  //   2. Active document URI (set after /open lands somewhere)
  //   3. session.name parse (handles bare "main" → tab:main)
  let kind: TopicType | 'web';
  if (topicType) {
    kind = topicType;
  } else if (session.currentUri?.startsWith('http://') || session.currentUri?.startsWith('https://')) {
    kind = 'web';
  } else {
    kind = parseTopic(session.name)?.type ?? 'tab';
  }
  if (kind !== 'tab') {
    return err(
      `/ls is not available for ${kind} topics — there is no filesystem to list.\n` +
      `Use /open <link>, /open @shortcut, or /nav to traverse the current document.`,
      'INVALID_TARGET',
    );
  }

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
