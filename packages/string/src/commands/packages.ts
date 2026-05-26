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

// ─── /install ─────────────────────────────────────────────────────────────────

export async function cmdInstall(
  args: string,
  session: Session,
  loader: Loader,
): Promise<CommandResult> {
  const parsed = parsePosixFlags(args?.trim() || '');
  if (!parsed) {
    return err(
      'Usage: /install <source>\n' +
      '  Install an app or tool. <source> is a URL, file path, or current document.\n' +
      '  When <source> returns an install manifest, mode (link/local) and type are\n' +
      '  picked automatically. Power-user overrides:\n' +
      '    --as <name>     install under a custom local name (lets you keep two\n' +
      '                    apps that share a name but differ by namespace)\n' +
      '    --link          force URL-shortcut mode (no local copy)\n' +
      '    --app | --tool  force package type when frontmatter is missing one',
      'COMMAND_UNSUPPORTED'
    );
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
  // Tristate: true = force link, undefined = let manifest decide, false = future --local.
  let linkOpt: boolean | undefined;
  if ('link' in parsed.flags) {
    linkOpt = true;
    if (!parsed.bareFlags.has('link')) {
      // --link consumed the source token; fold it back
      source = source ? `${parsed.flags.link} ${source}` : String(parsed.flags.link);
    }
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
    const result = await installPackage(resolvedSource, { type: typeOpt, link: linkOpt, as: asOpt }, loader);
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
