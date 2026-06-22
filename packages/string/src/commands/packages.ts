/**
 * Package commands: /install, /uninstall
 */

import fsPromises from 'fs/promises';
import path from 'path';
import type { Loader } from '../loader.js';
import type { Session } from '../session.js';
import type { CommandResult } from '../types.js';
import { installPackage } from '../installer.js';
import { parseGithubUrl } from '../github-installer.js';
import { ok, err, parsePosixFlags } from './helpers.js';
import { deriveCwd } from './exec.js';

const INSTALL_HELP = [
  '/install <source>  — install an app or tool from a URL, a path, or the current document.',
  '',
  'Source forms:',
  '  ./path/to/string.md                           Local single file',
  '  ./path/to/app-dir/                            Local directory (must contain string.md)',
  '  https://example.com/foo/string.md             Single markdown URL (linked by default; /open re-fetches)',
  '  https://example.com/foo/manifest.json         Install manifest (multi-file, see runtime/install-manifest)',
  '  https://github.com/owner/repo                 GitHub repo root — local install; uses string.md at root if present',
  '  https://github.com/owner/repo/tree/<ref>/<p>  GitHub directory — enumerates files via Contents API,',
  '                                                requires string.md inside <p>',
  '  https://github.com/owner/repo/blob/<ref>/<p>  GitHub single file — local install by default',
  '  gh:owner/repo[/<path>][@<ref>]                GitHub short form. Local install; defaults to repo default branch.',
  '  (no source)                                   Install whatever is currently open in this session',
  '',
  'Path rules for GitHub directory installs:',
  '  • The pointed path must contain a string.md — that file is the package root.',
  '  • All top-level files in the directory are staged (subdirectories skipped in v0.1).',
  '  • Files starting with `#!` shebang get chmod +x at install time.',
  '  • Anonymous GitHub API limit is 60 req/hr; set GITHUB_TOKEN to raise to 5000 req/hr.',
  '',
  'Flags:',
  '  --app | --tool  Force package type when frontmatter is missing or wrong.',
  '  --as <name>     Install under a custom local registry name (lets two apps that share',
  '                  a frontmatter `name` but differ by `namespace` live side by side).',
  '  --link          Force URL-shortcut mode for manifest URLs — no files copied; /open re-fetches.',
  '                  Plain http(s) markdown pages already use link mode by default.',
  '  --local         Force local-copy mode for a URL source — snapshot into packages/<name>/.',
  '  --help / -h     Show this help.',
  '',
  'When the source returns a JSON install manifest (`{files:[...], delivery:...}`), the daemon picks',
  'mode (link/local) and stages files automatically — no flags needed.',
].join('\n');

// ─── /install ─────────────────────────────────────────────────────────────────

export async function cmdInstall(
  args: string,
  session: Session,
  loader: Loader,
): Promise<CommandResult> {
  // Help is non-erroneous: pull it out before POSIX flag parsing, which would
  // otherwise classify a bare `--help` as a parse failure and rewrap the same
  // text under an error code.
  const trimmedArgs = args?.trim() || '';
  if (/(^|\s)(--help|-h)(\s|$)/.test(trimmedArgs)) {
    return ok(INSTALL_HELP);
  }

  const parsed = parsePosixFlags(trimmedArgs);
  if (!parsed) {
    return err(INSTALL_HELP, 'COMMAND_UNSUPPORTED');
  }

  // --app/--tool are boolean flags. parsePosixFlags greedily consumes the
  // next non-flag token as a value, so `/install --app ./foo.md` parses as
  // `app=./foo.md`. Recover by inspecting bareFlags: if --app appeared bare,
  // its value is a real boolean; otherwise the consumed token is the source
  // and should be folded back into `rest`.
  let typeOpt: 'app' | 'tool' | undefined;
  let source: string;

  if ('app' in parsed.flags) {
    typeOpt = 'app';
    source = parsed.bareFlags.has('app')
      ? parsed.rest.join(' ')
      : [parsed.flags.app, ...parsed.rest].join(' ');
  } else if ('tool' in parsed.flags) {
    typeOpt = 'tool';
    source = parsed.bareFlags.has('tool')
      ? parsed.rest.join(' ')
      : [parsed.flags.tool, ...parsed.rest].join(' ');
  } else {
    source = parsed.rest.join(' ');
  }

  // --link: install as URL shortcut (no local file copy).
  // --local: force local-copy mode for URL sources.
  let linkOpt: boolean | undefined;
  let localOpt: boolean | undefined;
  if ('link' in parsed.flags) {
    linkOpt = true;
    if (!parsed.bareFlags.has('link')) {
      // --link consumed the source token; fold it back
      source = source ? `${parsed.flags.link} ${source}` : String(parsed.flags.link);
    }
  }
  if ('local' in parsed.flags) {
    localOpt = true;
    if (!parsed.bareFlags.has('local')) {
      // --local consumed the source token; fold it back
      source = source ? `${parsed.flags.local} ${source}` : String(parsed.flags.local);
    }
  }
  if (linkOpt && localOpt) {
    return err('Choose either --link or --local, not both.', 'COMMAND_UNSUPPORTED');
  }

  // --as <name>: override the local registry key (e.g. install cookbook/weather
  // and stringhub/weather side by side). Always takes a value — bare --as is
  // an error. Empty/whitespace is rejected by installPackage's name validator.
  let asOpt: string | undefined;
  if ('as' in parsed.flags) {
    if (parsed.bareFlags.has('as')) {
      return err('--as requires a value: --as <local-name>', 'COMMAND_UNSUPPORTED');
    }
    asOpt = String(parsed.flags.as);
  }

  // No source → install current document
  if (!source) {
    const uri = session.currentUri;
    if (!uri) {
      return err(
        'No source specified and no document is open.\n' +
        'Usage: /install <source>   (URL, file path, or open document)',
        'COMMAND_UNSUPPORTED'
      );
    }
    source = uri;
  }

  // Resolve source path relative to cwd. URL-shaped sources pass through:
  //   - http(s)://… and file://…  (the `://` check)
  //   - github web URLs (caught by the `://` check above)
  //   - gh:owner/repo[/path] short form (no `://`; check explicitly)
  // Everything else is treated as a local path relative to cwd.
  const resolvedSource = source.includes('://') || path.isAbsolute(source) || parseGithubUrl(source)
    ? source
    : path.resolve(deriveCwd(session, loader), source);

  try {
    const result = await installPackage(resolvedSource, { type: typeOpt, link: linkOpt, local: localOpt, as: asOpt }, loader);
    const localPath = result.localUri.startsWith('file://')
      ? new URL(result.localUri).pathname
      : result.localUri;
    const useHint = result.type === 'app'
      ? `Use: /open app:${result.name}`
      : `Use: /tool:${result.name}`;
    const installLine = result.linked
      ? `Linked ${result.type}:${result.name} (URL shortcut)`
      : `Installed ${result.type}:${result.name}`;
    return ok(
      `${installLine}\n` +
      `  Source: ${source}\n` +
      `  Path: ${localPath}\n` +
      useHint
    );
  } catch (e) {
    return err((e as Error).message, 'COMMAND_UNSUPPORTED');
  }
}

// ─── /uninstall ───────────────────────────────────────────────────────────────

export async function cmdUninstall(
  args: string,
  _session: Session,
  loader: Loader,
): Promise<CommandResult> {
  const name = args?.trim();
  if (!name) {
    return err('Usage: /uninstall <name>', 'COMMAND_UNSUPPORTED');
  }

  // Find in apps or tools
  const appUri = loader.envStore.getPackage('apps', name);
  const toolUri = loader.envStore.getPackage('tools', name);

  if (!appUri && !toolUri) {
    return err(`Package not found: ${name}`, 'NOT_FOUND');
  }

  const type = appUri ? 'apps' : 'tools';
  const typeLabel = appUri ? 'app' : 'tool';
  const registryUri = (appUri ?? toolUri)!;
  loader.envStore.deletePackage(type as 'apps' | 'tools', name);

  // Remove local package files
  const packagesDir = path.join(loader.home, 'packages', name);
  const localPrefix = `file://${packagesDir}/`;
  const localExact = `file://${packagesDir}`;
  try {
    await fsPromises.rm(packagesDir, { recursive: true });
  } catch { /* directory may not exist */ }

  // Close any session still pointing at the package we just removed —
  // otherwise /refresh, /back, or any auto-default-action keeps re-reading
  // a now-stale or missing path. Match both the registry URI (covers linked
  // installs where files live at arbitrary HTTPS URLs) and the local
  // packages dir prefix (covers any sub-doc the user nav'd into).
  const closed = loader.sessionCleanup?.((uri) =>
    uri === registryUri ||
    uri.startsWith(registryUri + '#') ||
    uri === localExact ||
    uri.startsWith(localPrefix)
  ) ?? [];

  let summary = `Uninstalled ${typeLabel}:${name}`;
  if (closed.length > 0) {
    summary += `\n  Closed ${closed.length} active session${closed.length === 1 ? '' : 's'}: ${closed.join(', ')}`;
  }
  return ok(summary);
}
