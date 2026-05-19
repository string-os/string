/**
 * Hub topics — aggregator views over canonical session kinds.
 *
 * A hub is a reserved bare topic name (`app`, `bash`, `tool`, `system`)
 * that lists / manages instances of its kind. Listings render from the
 * Loader's registry (installed packages) and SessionLister (active sessions);
 * management actions are existing commands surfaced as one-liners on each
 * hub page.
 */

import type { Loader, SessionInfo } from '../loader.js';

/**
 * Render a hub page. The page lists what's installed / what's open and tells
 * the agent which commands manage it. Non-Browser embeddings that didn't wire
 * a `sessionLister` get a degraded page: the registry listing still works,
 * the active-sessions listing is omitted with a one-line note.
 */
export function renderHub(hubName: string, loader: Loader): string {
  switch (hubName) {
    case 'app':
      return renderAppHub(loader);
    case 'bash':
      return renderBashHub(loader);
    case 'tool':
      return renderToolHub(loader);
    case 'system':
      return renderSystemHub(loader);
    default:
      // Defensive: parseTopic only returns hub for the four reserved names,
      // so reaching this branch means a runtime bug or extension. Surface
      // it rather than silently returning something benign.
      return `Unknown hub: ${hubName}\nValid hubs: app, bash, tool, system`;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function listSessions(loader: Loader): SessionInfo[] | null {
  return loader.sessionLister ? loader.sessionLister() : null;
}

/** Render `name → URI` registry rows as a 2-column list. Empty → null. */
function renderRegistry(label: string, entries: Record<string, string>): string | null {
  const names = Object.keys(entries).sort();
  if (names.length === 0) return null;
  const width = Math.max(...names.map(n => n.length));
  const lines = names.map(n => `  ${n.padEnd(width)}  ${entries[n]}`);
  return `## ${label} (${names.length})\n\n${lines.join('\n')}`;
}

// ─── app hub ──────────────────────────────────────────────────────────────

function renderAppHub(loader: Loader): string {
  const installed = loader.envStore.listPackages('apps');
  const sessions = listSessions(loader);
  const appSessions = sessions?.filter(s => s.type === 'app') ?? [];

  const parts: string[] = [
    '# app hub',
    '',
    'Manage installed apps and currently open app sessions.',
  ];

  const installedBlock = renderRegistry('Installed', installed);
  if (installedBlock) {
    parts.push('', installedBlock);
  } else {
    parts.push('', '## Installed (0)', '', '  (no apps installed yet)');
  }

  if (sessions === null) {
    parts.push('', '## Open sessions', '', '  (session listing not available in this embedding)');
  } else if (appSessions.length === 0) {
    parts.push('', '## Open sessions (0)', '', '  (no app sessions open yet — `string app:<name> /open` to start one)');
  } else {
    const width = Math.max(...appSessions.map(s => s.name.length));
    const lines = appSessions.map(s => {
      const detail = s.currentUri ? `current: ${s.currentUri.replace(/^file:\/\//, '')}` : '(no doc)';
      return `  ${s.name.padEnd(width)}  ${detail}`;
    });
    parts.push('', `## Open sessions (${appSessions.length})`, '', lines.join('\n'));
  }

  parts.push(
    '',
    '## Manage',
    '',
    '  /open app:<name>                       — open / re-open an app',
    '  /install --app <path|URL>              — install from a local SFMD file or HTTPS URL',
    '  /uninstall <name>                      — remove an installed app',
  );
  return parts.join('\n');
}

// ─── tool hub ─────────────────────────────────────────────────────────────

function renderToolHub(loader: Loader): string {
  const installed = loader.envStore.listPackages('tools');
  const parts: string[] = [
    '# tool hub',
    '',
    'Browse installed tools. Tools are one-shot — they have no per-session state.',
  ];

  const installedBlock = renderRegistry('Installed', installed);
  if (installedBlock) {
    parts.push('', installedBlock);
  } else {
    parts.push('', '## Installed (0)', '', '  (no tools installed yet)');
  }

  parts.push(
    '',
    '## Run',
    '',
    '  /tool:<name> [args]                    — run the tool (default action)',
    '  /tool:<name>.<act> [args]              — run a named action on the tool',
    '',
    '## Manage',
    '',
    '  /install --tool <path|URL>             — install from a local SFMD file or HTTPS URL',
    '  /uninstall <name>                      — remove an installed tool',
  );
  return parts.join('\n');
}

// ─── bash hub ─────────────────────────────────────────────────────────────

function renderBashHub(loader: Loader): string {
  const sessions = listSessions(loader);
  const bashSessions = sessions?.filter(s => s.type === 'bash') ?? [];

  const parts: string[] = [
    '# bash hub',
    '',
    'Active bash sessions across this user.',
  ];

  if (sessions === null) {
    parts.push('', '## Sessions', '', '  (session listing not available in this embedding)');
  } else if (bashSessions.length === 0) {
    parts.push('', '## Sessions (0)', '', '  (no bash sessions running — `string bash:<name> "<cmd>"` to spawn one)');
  } else {
    const width = Math.max(...bashSessions.map(s => s.name.length));
    const lines = bashSessions.map(s => {
      const status = s.bashAlive ? `alive · cwd: ${s.bashCwd}` : '(no shell)';
      return `  ${s.name.padEnd(width)}  ${status}`;
    });
    parts.push('', `## Sessions (${bashSessions.length})`, '', lines.join('\n'));
  }

  parts.push(
    '',
    '## Use',
    '',
    '  string bash:<name> "<cmd>"             — run a command in a named bash session',
    '  string bash:<name>                     — interactive REPL on that session',
    '  /open bash:<name>                      — open the bash topic from another session',
  );
  return parts.join('\n');
}

// ─── system hub ───────────────────────────────────────────────────────────

function renderSystemHub(loader: Loader): string {
  const sessions = listSessions(loader);
  const apps = loader.envStore.listPackages('apps');
  const tools = loader.envStore.listPackages('tools');

  const parts: string[] = [
    '# system hub',
    '',
    'Daemon controls, env-store, and runtime state.',
    '',
    '## Stats',
    '',
    `  home:           ${loader.home}`,
    `  apps installed: ${Object.keys(apps).length}`,
    `  tools installed: ${Object.keys(tools).length}`,
  ];

  if (sessions === null) {
    parts.push('  sessions open:  (not available in this embedding)');
  } else {
    const byType = sessions.reduce<Record<string, number>>((acc, s) => {
      acc[s.type] = (acc[s.type] ?? 0) + 1;
      return acc;
    }, {});
    const breakdown = ['tab', 'app', 'bash', 'hub']
      .filter(t => byType[t])
      .map(t => `${byType[t]} ${t}`)
      .join(', ');
    parts.push(`  sessions open:  ${sessions.length}${breakdown ? ` (${breakdown})` : ''}`);
  }

  parts.push(
    '',
    '## Controls',
    '',
    '  string --daemon status                 — daemon health + port',
    '  string --daemon stop                   — stop the daemon',
    '  /topics [tab|app|bash|hub]             — list active sessions, optionally filtered',
    '  /session close <name>                  — close one session',
    '',
    '## Env',
    '',
    '  /set                                   — list vars visible in this topic',
    '  /set $VAR = "..."                      — set a var (scope follows current topic)',
  );
  return parts.join('\n');
}

