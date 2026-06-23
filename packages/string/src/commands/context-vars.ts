/**
 * Context variables — the system-defined `$VAR`s every action sees.
 *
 * Computed fresh per call and supplied via `extraEnv` to `resolveEnvVars`.
 * Sits above the app's own env store in the lookup chain. Never reads
 * process.env: apps must not see OS-level environment vars.
 *
 * `HOME` is the *String* per-agent home (`~/.string/agents/{agentId}`), not
 * the OS process's HOME.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Loader } from '../loader.js';
import type { Session } from '../session.js';
import { deriveCwd } from './exec.js';
import { deriveEnvScope } from '../env-store.js';

/**
 * Writable scratch directory for an app, keyed by (agent home, app, config).
 *
 * A CLI action runs with `cwd` = the app's own directory, which is read-only:
 * source files (string.md + helper scripts) live there and must not be polluted
 * by runtime output. Anything an app needs to *create* goes under `$STRING_WORK_DIR`
 * instead. The key includes the config namespace so the same app under different
 * configs (e.g. `app:gh-kanban:agentnews` vs `:string`) keeps separate state.
 * Returns '' when there is no app scope (e.g. a plain document session).
 */
export function appWorkDir(home: string, sessionName: string): string {
  const scope = deriveEnvScope(sessionName);
  if (!scope.app) return '';
  const key = scope.config ? `${scope.app}:${scope.config}` : scope.app;
  return path.join(home, '.string-work', key);
}

export function buildContextVars(
  session: Session,
  loader: Loader,
  rawArgs: string = '',
): Record<string, string> {
  const uri = session.currentUri;
  // The app's own directory (read-only source). Matches the cwd a CLI action
  // runs in for a file-backed app. Empty for remote/linked apps (no local dir).
  const appDir = uri?.startsWith('file://') ? path.dirname(new URL(uri).pathname) : '';
  // The app's writable scratch dir. Created lazily so apps can write to it
  // immediately without their own mkdir. Persists between runs (per agent+config).
  const workDir = appWorkDir(loader.home, session.name ?? '');
  if (workDir) {
    try { fs.mkdirSync(workDir, { recursive: true }); } catch { /* best-effort */ }
  }
  return {
    HOME: loader.home,
    CWD: deriveCwd(session, loader),
    CURRENT_FILE: uri?.startsWith('file://') ? new URL(uri).pathname : '',
    CURRENT_URI: uri ?? '',
    CURRENT_TARGET: session.name ?? '',
    CURRENT_BLOCK: session.currentBlockId ?? '',
    ARGS: rawArgs,
    STRING_APP_DIR: appDir,
    STRING_WORK_DIR: workDir,
  };
}
