/**
 * String — Configuration
 * "Config = State" — session variables override hardcoded defaults.
 * AI can adjust via `/set {_diff_context} = "5"` etc.
 */

import type { Session } from './session.js';

export interface StringConfig {
  diffContext: number;       // context lines around changes in diff output
  diffMaxLines: number;      // max diff output lines before truncation
  editMaxLines: number;      // max lines shown in /edit view mode
}

export const DEFAULT_CONFIG: StringConfig = {
  diffContext: 3,
  diffMaxLines: 50,
  editMaxLines: 100,
};

/**
 * Resolve config from session variables, falling back to defaults.
 * Convention: `{_diff_context}`, `{_diff_max_lines}`, `{_edit_max_lines}`
 */
export function resolveConfig(session: Session): StringConfig {
  return {
    diffContext: intVarMin0(session, '_diff_context', DEFAULT_CONFIG.diffContext),
    diffMaxLines: intVarMin1(session, '_diff_max_lines', DEFAULT_CONFIG.diffMaxLines),
    editMaxLines: intVarMin1(session, '_edit_max_lines', DEFAULT_CONFIG.editMaxLines),
  };
}

/** Parse int >= 0 (context can be 0 to show only changed lines). */
function intVarMin0(session: Session, name: string, fallback: number): number {
  const val = session.getVar(name);
  if (val === undefined) return fallback;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Parse int >= 1 (max lines must be positive). */
function intVarMin1(session: Session, name: string, fallback: number): number {
  const val = session.getVar(name);
  if (val === undefined) return fallback;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
