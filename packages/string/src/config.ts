/**
 * String — Configuration
 * "Config = State" — session variables override hardcoded defaults.
 * AI can adjust via `/set {_diff_context} = "5"` etc.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
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

// ─── Client config (.string/config.json or ~/.string/config.json) ─────────────
//
// Persistent client-side config, separate from per-session StringConfig above.
// Today it holds the "current agent" so terse `string <topic> '<cmd>'` calls can
// resolve to a configured agent instead of always `default`. A project-local
// `.string/config.json` wins over the global `~/.string/config.json` when it
// exists, which lets plugin-provided MCP (`string --mcp`) pick the right agent
// from the launched workspace without changing the MCP server name.

/** Client config schema persisted to ~/.string/config.json. */
export interface ClientConfig {
  currentAgent?: string;
}

/** Global client config path. */
export function globalConfigPath(): string {
  return join(homedir(), '.string', 'config.json');
}

function normalizeStartDir(value: string): string {
  return resolve(isAbsolute(value) ? value : join(process.cwd(), value));
}

/**
 * Find the nearest project-local String config.
 *
 * Claude Code exposes CLAUDE_PROJECT_DIR to MCP server processes. Outside
 * Claude, cwd is the natural project root candidate. A `.string/` directory is
 * enough to select the local config path so `string agent use` can create the
 * file there after a user intentionally creates the local config directory.
 */
export function projectConfigPath(): string | undefined {
  const rawStart = process.env.STRING_PROJECT_DIR?.trim()
    || process.env.CLAUDE_PROJECT_DIR?.trim()
    || process.cwd();
  let dir = normalizeStartDir(rawStart);
  const home = resolve(homedir());

  while (true) {
    if (dir === home) break;
    const stringDir = join(dir, '.string');
    const file = join(stringDir, 'config.json');
    if (existsSync(file) || existsSync(stringDir)) return file;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Path to the selected client config file. Override with STRING_CONFIG. */
export function configPath(): string {
  return process.env.STRING_CONFIG || projectConfigPath() || globalConfigPath();
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

/** Get the configured current agent id, if any. */
export function getCurrentAgent(): string | undefined {
  const id = loadClientConfig().currentAgent;
  return id && id.trim() ? id.trim() : undefined;
}

/** Set the configured current agent id. */
export function setCurrentAgent(id: string): void {
  saveClientConfig({ currentAgent: id.trim() });
}

/** Clear the configured current agent (e.g. after removing that agent). */
export function clearCurrentAgent(): void {
  const cfg = loadClientConfig();
  delete cfg.currentAgent;
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Centralized agent-id resolution.
 * Precedence:
 *   agentFlag > STRING_AGENT_ID > STRING_CONFIG/current project config >
 *   global config > 'default'.
 */
export function resolveAgentId(agentFlag?: string | null): string {
  const flag = agentFlag?.trim();
  if (flag) return flag;
  const env = process.env.STRING_AGENT_ID?.trim();
  if (env) return env;
  const current = getCurrentAgent();
  if (current) return current;
  return 'default';
}
