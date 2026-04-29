/**
 * String — Environment Variable Store
 * Per-user persistent $var storage with scope cascade.
 *
 * `home` is the String user's home directory — it's already String-only, so
 * everything sits at the root (no nested `.string/` subdir).
 *
 * Storage layout:
 *   Global:  {home}/config.json              → { "env": { "KEY": "val" }, ... }
 *   App:     {home}/apps/{app}/env.json      → { "KEY": "val" }
 *   Config:  {home}/apps/{app}/{cfg}/env.json → { "KEY": "val" }
 *
 * Resolution order (most specific wins): config → app → global
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

export interface EnvScope {
  app?: string;
  config?: string;
}

export class EnvStore {
  private readonly baseDir: string; // String user home — root for config/apps
  private readonly fileCache = new Map<string, Record<string, unknown>>();

  constructor(home: string) {
    this.baseDir = home;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Get a $var value, cascading through scopes.
   * Resolution: config → app → global (most specific wins).
   */
  get(name: string, scope?: EnvScope): string | undefined {
    // Check config scope (most specific)
    if (scope?.app && scope?.config) {
      const vars = this.loadAppEnv(scope.app, scope.config);
      if (name in vars) return vars[name];
    }
    // Check app scope
    if (scope?.app) {
      const vars = this.loadAppEnv(scope.app);
      if (name in vars) return vars[name];
    }
    // Check global scope
    const globalVars = this.loadGlobalEnv();
    return globalVars[name];
  }

  /**
   * Set a $var value in the specified scope.
   * If no scope specified, stores in global config.
   */
  set(name: string, value: string, scope?: EnvScope): void {
    if (scope?.app && scope?.config) {
      this.setAppEnv(scope.app, name, value, scope.config);
    } else if (scope?.app) {
      this.setAppEnv(scope.app, name, value);
    } else {
      this.setGlobalEnv(name, value);
    }
  }

  /**
   * Delete a $var from the specified scope.
   */
  delete(name: string, scope?: EnvScope): boolean {
    if (scope?.app && scope?.config) {
      return this.deleteAppEnv(scope.app, name, scope.config);
    }
    if (scope?.app) {
      return this.deleteAppEnv(scope.app, name);
    }
    return this.deleteGlobalEnv(name);
  }

  /**
   * Get all vars for a scope (merged with cascade).
   * Global vars are the base, app overrides, config overrides app.
   */
  getAll(scope?: EnvScope): Record<string, string> {
    const result: Record<string, string> = { ...this.loadGlobalEnv() };
    if (scope?.app) {
      Object.assign(result, this.loadAppEnv(scope.app));
    }
    if (scope?.app && scope?.config) {
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
    if (this.fileCache.has(filePath)) return this.fileCache.get(filePath)!;
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        this.fileCache.set(filePath, data as Record<string, unknown>);
        return data as Record<string, unknown>;
      }
    } catch { /* file doesn't exist yet — that's fine */ }
    const empty: Record<string, unknown> = {};
    this.fileCache.set(filePath, empty);
    return empty;
  }

  private writeJson(filePath: string, data: Record<string, unknown>): void {
    try {
      // 0o700 dir / 0o600 file: env-store holds API keys and tokens; must not
      // be world-readable on shared machines.
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      this.fileCache.set(filePath, data);
    } catch (e) {
      console.error(`[EnvStore] Failed to write ${filePath}: ${e}`);
    }
  }

  // ── Global config ───────────────────────────────────────────────────────────

  private get configPath(): string {
    return join(this.baseDir, 'config.json');
  }

  private loadGlobalEnv(): Record<string, string> {
    const config = this.readJson(this.configPath);
    const env = config.env;
    if (typeof env === 'object' && env !== null && !Array.isArray(env)) {
      return env as Record<string, string>;
    }
    return {};
  }

  private setGlobalEnv(name: string, value: string): void {
    const config = this.readJson(this.configPath);
    const env = (typeof config.env === 'object' && config.env !== null && !Array.isArray(config.env))
      ? { ...(config.env as Record<string, string>) }
      : {};
    env[name] = value;
    this.writeJson(this.configPath, { ...config, env });
  }

  private deleteGlobalEnv(name: string): boolean {
    const config = this.readJson(this.configPath);
    const env = (typeof config.env === 'object' && config.env !== null && !Array.isArray(config.env))
      ? { ...(config.env as Record<string, string>) }
      : {};
    if (!(name in env)) return false;
    delete env[name];
    this.writeJson(this.configPath, { ...config, env });
    return true;
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
 * "file:main" → {} (global only)
 * "app:weather" → { app: "weather" }
 * "app:weather:korea" → { app: "weather", config: "korea" }
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
