/**
 * String — Environment Variable Store
 * Per-app persistent $var storage.
 *
 * `home` is the String user's home directory — it's already String-only, so
 * everything sits at the root (no nested `.string/` subdir).
 *
 * Storage layout:
 *   App:     {home}/apps/{app}/env.json       → { "KEY": "val" }
 *   Config:  {home}/apps/{app}/{cfg}/env.json → { "KEY": "val" }
 *
 * Resolution: config → app (most specific wins). No global scope: an app's
 * env never leaks to other apps, and shell-level vars never leak into any
 * app. Daemon-defined system vars ($HOME, $CWD, $CURRENT_*) are supplied
 * separately via `extraEnv` at action call time — see context-vars.ts.
 *
 * Trade-off: a key needed by N apps must be /set in each. Considered worth
 * the cost — the alternative (shared global env) is the leak path we're
 * closing.
 *
 * Note: `{home}/config.json` still exists as the package registry
 * (apps/tools name → URI), but no longer carries an `env` section.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join, dirname } from 'path';

export interface EnvScope {
  app?: string;
  config?: string;
}

export class EnvStore {
  private readonly baseDir: string; // String user home — root for config/apps
  // mtime-keyed cache: invalidates if file was edited (or deleted) outside this process.
  private readonly fileCache = new Map<string, { mtimeMs: number; data: Record<string, unknown> }>();

  constructor(home: string) {
    this.baseDir = home;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Get a $var value, cascading config → app.
   * Returns undefined for non-app scopes — no global fallback.
   */
  get(name: string, scope?: EnvScope): string | undefined {
    if (!scope?.app) return undefined;
    if (scope.config) {
      const vars = this.loadAppEnv(scope.app, scope.config);
      if (name in vars) return vars[name];
    }
    const vars = this.loadAppEnv(scope.app);
    return vars[name];
  }

  /**
   * Set a $var in the given app (or app+config) scope.
   * Throws if scope has no app — global env is no longer supported.
   */
  set(name: string, value: string, scope?: EnvScope): void {
    if (!scope?.app) {
      throw new Error(
        `EnvStore.set requires an app scope. ` +
        `Tried to set $${name} with no app — global env is not supported.`,
      );
    }
    this.setAppEnv(scope.app, name, value, scope.config);
  }

  /**
   * Delete a $var from the given scope. No-op if no app scope.
   */
  delete(name: string, scope?: EnvScope): boolean {
    if (!scope?.app) return false;
    return this.deleteAppEnv(scope.app, name, scope.config);
  }

  /**
   * Get all vars visible to a scope (config overrides app). Empty for
   * non-app scopes.
   */
  getAll(scope?: EnvScope): Record<string, string> {
    if (!scope?.app) return {};
    const result: Record<string, string> = { ...this.loadAppEnv(scope.app) };
    if (scope.config) {
      Object.assign(result, this.loadAppEnv(scope.app, scope.config));
    }
    return result;
  }

  // ── Package Registry ────────────────────────────────────────────────────────

  /** Get registered URI for an app/tool name. */
  getPackage(type: 'apps' | 'tools', name: string): string | undefined {
    const config = this.readJson(this.configPath);
    const section = config[type];
    if (typeof section === 'object' && section !== null && !Array.isArray(section)) {
      return (section as Record<string, string>)[name];
    }
    return undefined;
  }

  /** Register an app/tool name → URI mapping. */
  setPackage(type: 'apps' | 'tools', name: string, uri: string): void {
    const config = this.readJson(this.configPath);
    const section = (typeof config[type] === 'object' && config[type] !== null && !Array.isArray(config[type]))
      ? { ...(config[type] as Record<string, string>) }
      : {};
    section[name] = uri;
    this.writeJson(this.configPath, { ...config, [type]: section });
  }

  /** Unregister an app/tool. Returns true if it existed. */
  deletePackage(type: 'apps' | 'tools', name: string): boolean {
    const config = this.readJson(this.configPath);
    const section = (typeof config[type] === 'object' && config[type] !== null && !Array.isArray(config[type]))
      ? { ...(config[type] as Record<string, string>) }
      : {};
    if (!(name in section)) return false;
    delete section[name];
    this.writeJson(this.configPath, { ...config, [type]: section });
    return true;
  }

  /** List all registered packages of a type. */
  listPackages(type: 'apps' | 'tools'): Record<string, string> {
    const config = this.readJson(this.configPath);
    const section = config[type];
    if (typeof section === 'object' && section !== null && !Array.isArray(section)) {
      return { ...(section as Record<string, string>) };
    }
    return {};
  }

  /**
   * Invalidate cached file data (useful after external edits).
   */
  clearCache(): void {
    this.fileCache.clear();
  }

  // ── File I/O ────────────────────────────────────────────────────────────────

  private readJson(filePath: string): Record<string, unknown> {
    // Check on-disk mtime first. If the file was deleted or modified outside
    // this process (e.g. user did `rm -rf ~/.string`), our cached copy is stale
    // and reusing it would resurrect data the user just deleted.
    let mtimeMs: number | null = null;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      // File missing — drop any cached copy and return empty.
      this.fileCache.delete(filePath);
      return {};
    }
    const cached = this.fileCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.data;

    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        this.fileCache.set(filePath, { mtimeMs, data: data as Record<string, unknown> });
        return data as Record<string, unknown>;
      }
    } catch { /* unreadable — fall through to empty */ }
    return {};
  }

  private writeJson(filePath: string, data: Record<string, unknown>): void {
    try {
      // 0o700 dir / 0o600 file: env-store holds API keys and tokens; must not
      // be world-readable on shared machines.
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      const mtimeMs = statSync(filePath).mtimeMs;
      this.fileCache.set(filePath, { mtimeMs, data });
    } catch (e) {
      console.error(`[EnvStore] Failed to write ${filePath}: ${e}`);
    }
  }

  // ── Package registry config ────────────────────────────────────────────────

  // {home}/config.json holds the apps/tools package registry (name → URI).
  // It no longer carries an `env` section — global env was removed for
  // isolation.

  private get configPath(): string {
    return join(this.baseDir, 'config.json');
  }

  // ── App env ─────────────────────────────────────────────────────────────────

  private appEnvPath(app: string, config?: string): string {
    if (config) return join(this.baseDir, 'apps', app, config, 'env.json');
    return join(this.baseDir, 'apps', app, 'env.json');
  }

  private loadAppEnv(app: string, config?: string): Record<string, string> {
    return this.readJson(this.appEnvPath(app, config)) as Record<string, string>;
  }

  private setAppEnv(app: string, name: string, value: string, config?: string): void {
    const p = this.appEnvPath(app, config);
    const env = { ...this.readJson(p) as Record<string, string> };
    env[name] = value;
    this.writeJson(p, env);
  }

  private deleteAppEnv(app: string, name: string, config?: string): boolean {
    const p = this.appEnvPath(app, config);
    const env = { ...this.readJson(p) as Record<string, string> };
    if (!(name in env)) return false;
    delete env[name];
    this.writeJson(p, env);
    return true;
  }
}

// ── Scope derivation ────────────────────────────────────────────────────────

/**
 * Derive env scope from a session/topic name.
 * "main", "notes" (tab) → {} (no env access)
 * "app:weather"          → { app: "weather" }
 * "app:weather:korea"    → { app: "weather", config: "korea" }
 * "bash:dev"             → {} (bash sessions don't carry app-scoped env)
 * "app", "bash" (hubs)   → {} (hub topics aren't app-scoped)
 *
 * An empty scope means the session can neither set nor read persistent
 * env. Apps see only their own scope; system vars come through extraEnv.
 */
export function deriveEnvScope(sessionName: string): EnvScope {
  const colonIdx = sessionName.indexOf(':');
  if (colonIdx === -1) return {};

  const type = sessionName.slice(0, colonIdx);
  if (type !== 'app') return {};

  const rest = sessionName.slice(colonIdx + 1);
  const parts = rest.split(':');
  if (parts.length >= 2) return { app: parts[0], config: parts.slice(1).join(':') };
  if (parts.length === 1 && parts[0]) return { app: parts[0] };
  return {};
}
