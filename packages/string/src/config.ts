/**
 * String — Configuration
 * "Config = State" — session variables override hardcoded defaults.
 * AI can adjust via `/set {_diff_context} = "5"` etc.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
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

// ─── Client config (~/.string/config.json) ────────────────────────────────────
//
// Persistent client-side config, separate from per-session StringConfig above.
// Today it holds the "current user" so terse `string <topic> '<cmd>'` calls can
// resolve to a configured user instead of always `default`. Stored as a
// forward-compatible object so new keys can be added without a migration.

/** Client config schema persisted to ~/.string/config.json. */
export interface ClientConfig {
  currentUser?: string;
}

/** Path to the client config file. Override with STRINGD_CONFIG (tests/isolated installs). */
export function configPath(): string {
  return process.env.STRINGD_CONFIG || join(homedir(), '.string', 'config.json');
}

/** Load the client config. Missing/corrupt file → empty config (back-compat). */
export function loadClientConfig(): ClientConfig {
  try {
    const data = JSON.parse(readFileSync(configPath(), 'utf-8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data as ClientConfig;
    }
  } catch { /* no config yet — that's fine */ }
  return {};
}

/** Persist the client config, merging into any existing on-disk config. */
export function saveClientConfig(patch: ClientConfig): void {
  const merged = { ...loadClientConfig(), ...patch };
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
}

/** Get the configured current user id, if any. */
export function getCurrentUser(): string | undefined {
  const id = loadClientConfig().currentUser;
  return id && id.trim() ? id.trim() : undefined;
}

/** Set the configured current user id. */
export function setCurrentUser(id: string): void {
  saveClientConfig({ currentUser: id.trim() });
}

/** Clear the configured current user (e.g. after removing that user). */
export function clearCurrentUser(): void {
  const cfg = loadClientConfig();
  delete cfg.currentUser;
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Centralized user-id resolution.
 * Precedence: `userFlag` > STRINGD_USER > config.currentUser > 'default'.
 */
export function resolveUserId(userFlag?: string | null): string {
  const flag = userFlag?.trim();
  if (flag) return flag;
  const env = process.env.STRINGD_USER?.trim();
  if (env) return env;
  const current = getCurrentUser();
  if (current) return current;
  return 'default';
}
