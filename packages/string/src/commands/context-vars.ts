/**
 * Context variables — the system-defined `$VAR`s every action sees.
 *
 * Computed fresh per call and supplied via `extraEnv` to `resolveEnvVars`.
 * Sits above the app's own env store in the lookup chain. Never reads
 * process.env: apps must not see OS-level environment vars.
 *
 * `HOME` is the *String* per-user home (`~/.string/users/{userId}`), not
 * the OS process's HOME.
 */

import type { Loader } from '../loader.js';
import type { Session } from '../session.js';
import { deriveCwd } from './exec.js';

export function buildContextVars(
  session: Session,
  loader: Loader,
  rawArgs: string = '',
): Record<string, string> {
  const uri = session.currentUri;
  return {
    HOME: loader.home,
    CWD: deriveCwd(session, loader),
    CURRENT_FILE: uri?.startsWith('file://') ? new URL(uri).pathname : '',
    CURRENT_URI: uri ?? '',
    CURRENT_TARGET: session.name ?? '',
    CURRENT_BLOCK: session.currentBlockId ?? '',
    ARGS: rawArgs,
  };
}
