/**
 * Package commands: /install, /uninstall
 */

import fsPromises from 'fs/promises';
import path from 'path';
import type { Loader } from '../loader.js';
import type { Session } from '../session.js';
import type { CommandResult } from '../types.js';
import { installPackage } from '../installer.js';
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
      'Usage: /install [source] [--app | --tool]\n' +
      'Install a package (app or tool) from a local file, URL, or current document.',
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

  // No source → install current document
  if (!source) {
    const uri = session.currentUri;
    if (!uri) {
      return err(
        'No source specified and no document is open.\n' +
        'Usage: /install [source] [--app | --tool]',
        'COMMAND_UNSUPPORTED'
      );
    }
    source = uri;
  }

  // Resolve source path relative to cwd (file:// URIs and URLs pass through)
  const resolvedSource = source.includes('://') || path.isAbsolute(source)
    ? source
    : path.resolve(deriveCwd(session, loader), source);

  try {
    const result = await installPackage(resolvedSource, { type: typeOpt }, loader);
    const localPath = result.localUri.startsWith('file://')
      ? new URL(result.localUri).pathname
      : result.localUri;
    const useHint = result.type === 'app'
      ? `Use: /open app:${result.name}`
      : `Use: /tool:${result.name}`;
    return ok(
      `Installed ${result.type}:${result.name}\n` +
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
  loader.envStore.deletePackage(type as 'apps' | 'tools', name);

  // Remove local package files
  const packagesDir = path.join(loader.home, '.string', 'packages', name);
  try {
    await fsPromises.rm(packagesDir, { recursive: true });
  } catch { /* directory may not exist */ }

  return ok(`Uninstalled ${typeLabel}:${name}`);
}
