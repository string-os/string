/**
 * String — Document Loader
 * Abstracts local filesystem and HTTP loading into a single interface.
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile, isTrinity } from '@string-os/compiler';
import { StringError } from './types.js';
import { EnvStore } from './env-store.js';

export interface LoadResult {
  /** Canonical URI — always absolute (file:// or https://) */
  uri: string;
  /** Raw markdown source — pristine; this is what gets persisted on /install. */
  source: string;
  /** Original source before conversion (e.g. raw HTML before htmlToMarkdown) */
  rawSource?: string;
  /**
   * Optional markdown to append AT DISPLAY TIME ONLY (not stored, not parsed
   * for actions). Currently used by manifest-aware HTTP loads to surface an
   * install hint to agents browsing a marketplace URL. Empty / undefined for
   * file:// loads so installed apps don't carry stale hints.
   */
  displaySuffix?: string;
  /**
   * What transformation was applied to produce `source` from the upstream
   * bytes. `'html-to-md'` means we fetched HTML and ran htmlToMarkdown over
   * it — the body the agent sees is a derivative, not the site's own format.
   * Surface this in /open output so the agent can attribute layout quirks to
   * the conversion rather than to the site (and notice when a site DOES
   * serve native markdown, in which case this stays undefined).
   */
  transform?: 'html-to-md';
}

/** A single entry in the install-manifest's files[] array. */
interface ManifestFile {
  path: string;
  url?: string;
  content?: string;
}

export interface ActionResult extends LoadResult {
  /** HTTP status code */
  status: number;
  /** Parsed JSON body (or null if not JSON) */
  jsonBody: unknown;
}

/** File access mode: 'full' allows any path, 'workspace' restricts to home. */
export type AccessMode = 'full' | 'workspace';

/** Pluggable HTML→Markdown converter. Receives raw HTML and the source URL. */
export type HtmlToMarkdown = (html: string, url: string) => string;

export interface LoaderOptions {
  /** AI home directory — base for path resolution when no document is open (default: process.cwd()) */
  home?: string;
  /** Allow HTTP/HTTPS fetching (default: true) */
  allowHttp?: boolean;
  /** File access mode (default: 'full') */
  accessMode?: AccessMode;
  /** Optional HTML→Markdown converter for HTTP responses with text/html content-type */
  htmlToMarkdown?: HtmlToMarkdown;
}

/**
 * Hook the Browser registers so package commands (e.g. /uninstall) can ask
 * "close any session whose currentUri matches this predicate" without taking
 * a Browser reference. Returns the names of sessions it closed, for reporting.
 *
 * Why on Loader: dispatch passes (input, session, loader, topicType); commands
 * see the loader but not the Browser. Threading Browser through every command
 * just for one cleanup path is overkill. The loader already has lifetime
 * matching the Browser, so it's a natural rendezvous.
 */
export type SessionCleanup = (predicate: (uri: string) => boolean) => string[];

/**
 * One row in a `SessionLister` result. Compact projection of Session state for
 * hub listings — hubs render across sessions without needing the Session class.
 */
export interface SessionInfo {
  name: string;
  type: import('./types.js').TopicType;
  namespace: string;
  currentUri: string | null;
  bashAlive: boolean;
  bashCwd: string | null;
}

/**
 * Browser-registered hook letting hub views enumerate active sessions without
 * taking a Browser reference. Mirrors the {@link SessionCleanup} pattern.
 */
export type SessionLister = () => SessionInfo[];

export class Loader {
  readonly home: string;
  readonly accessMode: AccessMode;
  readonly envStore: EnvStore;
  /** Set by Browser at construction. Optional — non-Browser embeddings skip. */
  sessionCleanup?: SessionCleanup;
  /** Set by Browser at construction. Optional — non-Browser embeddings skip. */
  sessionLister?: SessionLister;
  private readonly allowHttp: boolean;
  private readonly htmlToMarkdown: HtmlToMarkdown | null;

  // In-memory cache of install manifests keyed by the URL they were fetched
  // from. Lets resolve() route relative paths through manifest.files[] for
  // linked installs (where sibling .md files don't sit next to string.md
  // in URL space — they're at arbitrary URLs the manifest declares).
  // Bounded; see {@link rememberManifest}.
  private readonly manifestCache = new Map<string, ManifestFile[]>();
  private static readonly MANIFEST_CACHE_MAX = 64;

  constructor(options: LoaderOptions = {}) {
    this.home = options.home ?? process.cwd();
    this.allowHttp = options.allowHttp ?? true;
    this.accessMode = options.accessMode ?? 'full';
    this.envStore = new EnvStore(this.home);
    this.htmlToMarkdown = options.htmlToMarkdown ?? null;
  }

  private rememberManifest(url: string, files: ManifestFile[]): void {
    // Evict oldest if at capacity (Map preserves insertion order).
    if (this.manifestCache.size >= Loader.MANIFEST_CACHE_MAX) {
      const oldest = this.manifestCache.keys().next().value;
      if (oldest !== undefined) this.manifestCache.delete(oldest);
    }
    this.manifestCache.set(url, files);
  }

  /**
   * Load a document from a URI, relative path, or shortcut-resolved href.
   * @param topic  URI, relative path, or absolute path (no fragment — strip before calling)
   * @param baseUri Base URI for resolving relative paths
   */
  async load(topic: string, baseUri?: string): Promise<LoadResult> {
    const resolved = this.resolve(topic, baseUri);

    if (resolved.startsWith('file://')) {
      return this.loadFile(resolved);
    }

    if (resolved.startsWith('https://') || resolved.startsWith('http://')) {
      if (!this.allowHttp) {
        throw new StringError('LOAD_ERROR', `HTTP loading is disabled: ${resolved}`);
      }
      return this.loadHttp(resolved);
    }

    throw new StringError('LOAD_ERROR', `Unsupported URI scheme: ${resolved}`);
  }

  /**
   * Execute an action via HTTP or CLI.
   * Returns the response body as an ActionResult.
   *
   * @param topic  URI, relative path, or CLI command template
   * @param method  HTTP method ('get' | 'post' | ...) or 'cli'
   * @param body    Payload fields (for HTTP) or params (for CLI template substitution)
   * @param baseUri Base URI for resolving relative paths
   * @param headers Extra headers to merge (from action -H definitions)
   * @param bodyTemplate  Optional pre-substituted request body string. When set
   *                      (HTTP only), used verbatim instead of JSON.stringify(body).
   *                      Lets authors declare APIs whose body shape doesn't match
   *                      the flat field map.
   */
  async action(
    topic: string,
    method: string,
    body: Record<string, unknown>,
    baseUri?: string,
    headers?: Record<string, string>,
    bodyTemplate?: string,
  ): Promise<ActionResult> {
    const verb = method.toUpperCase();

    // CLI execution branch
    if (verb === 'CLI') {
      return this.execCli(topic, body, baseUri);
    }

    if (!this.allowHttp) {
      throw new StringError('LOAD_ERROR', 'HTTP is disabled — cannot execute actions');
    }

    const resolved = this.resolve(topic, baseUri);

    if (!resolved.startsWith('http://') && !resolved.startsWith('https://')) {
      throw new StringError(
        'LOAD_ERROR',
        `Actions can only topic HTTP endpoints (got: ${resolved})`,
      );
    }

    let uri: string;
    let init: RequestInit;

    if (verb === 'GET' || verb === 'DELETE') {
      const url = new URL(resolved);
      // GET/DELETE never use a body template — query string is the only
      // input. Promote remaining fields (after URI substitution) to query.
      for (const [k, v] of Object.entries(body)) {
        url.searchParams.set(k, String(v));
      }
      uri = url.toString();
      init = {
        method: verb,
        headers: { Accept: 'text/markdown, text/plain', ...headers },
      };
    } else {
      uri = resolved;
      // Body precedence: caller-supplied template (already field-substituted)
      // wins. Otherwise fall back to flat JSON.stringify(payload).
      const requestBody = bodyTemplate !== undefined
        ? bodyTemplate
        : JSON.stringify(body);
      init = {
        method: verb,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/markdown, text/plain',
          ...headers,
        },
        body: requestBody,
      };
    }

    let res: Response;
    try {
      res = await fetch(uri, init);
    } catch (err) {
      throw new StringError('LOAD_ERROR', `Network error: ${(err as Error).message}`);
    }

    if (res.status === 404) throw new StringError('NOT_FOUND', `Not found: ${uri}`);
    if (!res.ok) {
      // Read body for context — many APIs return useful JSON error messages
      // in the response even on non-2xx status. Forward up to ~500 chars.
      let errBody = '';
      try { errBody = (await res.text()).slice(0, 500); } catch { /* ignore */ }
      throw new StringError(
        'LOAD_ERROR',
        `HTTP ${res.status} at ${uri}${errBody ? `\n${errBody}` : ''}`,
      );
    }

    let source = await res.text();
    let rawSource: string | undefined;
    let transform: 'html-to-md' | undefined;

    // Convert HTML responses if converter is available
    if (this.htmlToMarkdown && isHtmlResponse(res)) {
      rawSource = source;
      source = this.htmlToMarkdown(source, uri);
      transform = 'html-to-md';
    }

    // Try to parse response as JSON
    let jsonBody: unknown = null;
    try {
      jsonBody = JSON.parse(source);
    } catch {
      // Not JSON — leave as null
    }

    return { uri, source, rawSource, status: res.status, jsonBody, transform };
  }

  /**
   * Execute a CLI action.
   * @param commandTemplate  Command string (e.g. "git $ARGS" or "echo hello")
   * @param params  Flag values for template substitution
   * @param baseUri Base URI for deriving cwd
   */
  private execCli(
    commandTemplate: string,
    params: Record<string, unknown>,
    baseUri?: string,
  ): Promise<ActionResult> {
    // Derive cwd from baseUri
    let cwd = this.home;
    if (baseUri?.startsWith('file://')) {
      cwd = path.dirname(fileUriToPath(baseUri));
    }

    return new Promise((resolve) => {
      const child = spawn('/bin/bash', ['-c', commandTemplate], {
        cwd,
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (d: Buffer) => { output += d; });
      child.stderr.on('data', (d: Buffer) => { output += d; });
      child.on('close', (code) => {
        const trimmed = output.trimEnd();
        let jsonBody: unknown = null;
        try { jsonBody = JSON.parse(trimmed); } catch { /* not JSON — leave null */ }
        resolve({
          uri: commandTemplate,
          source: trimmed,
          status: code ?? 1,
          jsonBody,
        });
      });
      child.on('error', (e) => {
        resolve({
          uri: commandTemplate,
          source: e.message,
          status: 1,
          jsonBody: null,
        });
      });
    });
  }

  /**
   * Resolve a topic to a canonical URI.
   * Does NOT strip fragments — caller is responsible.
   */
  resolve(topic: string, baseUri?: string): string {
    // Already a full URI
    if (topic.startsWith('file://') || topic.startsWith('https://') || topic.startsWith('http://')) {
      return topic;
    }

    // chanflow:// scheme → https://
    if (topic.startsWith('chanflow://')) {
      return 'https://' + topic.slice('chanflow://'.length);
    }

    // Relative or absolute file path
    if (baseUri?.startsWith('file://')) {
      const baseDir = path.dirname(fileUriToPath(baseUri));
      const abs = path.resolve(baseDir, topic);
      return pathToFileUri(abs);
    }

    if (baseUri?.startsWith('https://') || baseUri?.startsWith('http://')) {
      // Manifest-aware resolution: if baseUri was loaded as an install
      // manifest, look up the relative path in its files[]. This is the
      // only sensible mapping for linked installs (the install URL is a
      // catalog endpoint, not a directory — joining "submolts.md" onto
      // .../api/install/foo/bar yields a 404).
      const manifestFiles = this.manifestCache.get(baseUri);
      if (manifestFiles) {
        const entry = manifestFiles.find((f) => f.path === topic);
        if (entry?.url) return entry.url;
        // No matching entry: fall through to URL join (404 will surface
        // a clear "Not found" rather than silently returning bogus data).
      }
      const base = new URL(baseUri);
      return new URL(topic, base).toString();
    }

    // Fall back to home
    const abs = path.isAbsolute(topic)
      ? topic
      : path.resolve(this.home, topic);
    return pathToFileUri(abs);
  }

  private async loadFile(uri: string): Promise<LoadResult> {
    const filePath = fileUriToPath(uri);

    // Trinity check: if a sibling .md.source/ directory exists, compile on-demand
    if (filePath.endsWith('.md') && isTrinity(filePath)) {
      const dir = path.dirname(filePath);
      const baseName = path.basename(filePath, '.md');
      const { output } = compile(dir, baseName);
      return { uri, source: output };
    }

    try {
      const source = await fs.readFile(filePath, 'utf-8');
      return { uri, source };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new StringError('LOAD_ERROR', `Failed to read ${filePath}: ${(err as Error).message}`);
      }
    }

    throw new StringError('NOT_FOUND', `File not found: ${filePath}`);
  }

  private async loadHttp(uri: string): Promise<LoadResult> {
    let res: Response;
    try {
      res = await fetch(uri, {
        headers: { Accept: 'application/json, text/markdown, text/plain' },
      });
    } catch (err) {
      throw new StringError('LOAD_ERROR', `Network error fetching ${uri}: ${(err as Error).message}`);
    }

    if (res.status === 404) {
      throw new StringError('NOT_FOUND', `Not found: ${uri}`);
    }
    if (!res.ok) {
      throw new StringError('LOAD_ERROR', `HTTP ${res.status} fetching ${uri}`);
    }

    let source = await res.text();
    let rawSource: string | undefined;
    let displaySuffix: string | undefined;

    // Detect install manifest: { files: [{path, url}|{path, content}], ... }
    // Marketplace endpoints (e.g. /api/install/{ns}/{app}) return this shape.
    // Extract string.md content for SFMD resolution; preserve original JSON in
    // rawSource so installer can iterate files[] and download the rest.
    try {
      const manifest = JSON.parse(source);
      if (manifest && Array.isArray(manifest.files)) {
        // Remember every manifest URL we see so future relative /open or
        // shortcut resolution can route through manifest.files[] instead
        // of joining against the install URL's parent (which is wrong for
        // linked external apps where sibling files live at arbitrary urls).
        this.rememberManifest(uri, manifest.files as ManifestFile[]);

        const entry = manifest.files.find((f: { path: string }) => f.path === 'string.md');
        if (!entry) {
          // The shape said "I am a manifest" (files[] array present), but it
          // forgot the canonical entry. Without this guard we fall through
          // with the raw JSON as `source`, which the SFMD parser then fails
          // to parse, ultimately surfacing as "Cannot determine package type"
          // — a misleading recovery hint that sends users in the wrong
          // direction (the docs even tell them to add --app, which doesn't
          // help). Bail early with the actual cause.
          const declared = manifest.files
            .map((f: { path?: unknown }) => typeof f?.path === 'string' ? f.path : null)
            .filter((p: unknown): p is string => typeof p === 'string')
            .slice(0, 5)
            .join(', ');
          throw new StringError(
            'LOAD_ERROR',
            `Manifest at ${uri} is missing a "string.md" entry in files[]. ` +
            `Every package must have a string.md root file.` +
            (declared ? `\nDeclared paths: ${declared}` : '')
          );
        }

        rawSource = source;
        if (typeof entry.content === 'string') {
          source = entry.content;
        } else if (typeof entry.url === 'string') {
          const r = await fetch(entry.url, { headers: { Accept: 'text/markdown, text/plain' } });
          if (!r.ok) {
            throw new StringError('LOAD_ERROR', `HTTP ${r.status} fetching entry ${entry.url}`);
          }
          source = await r.text();
        }
        // Optional install_hint: shown only for manifest-URL /open (i.e.
        // pre-install browsing). We carry it as a separate displaySuffix
        // rather than mutating source, so /install writes the pristine
        // string.md to disk — once installed, /open uses file://, no
        // manifest, no hint echoing back at agents who already installed.
        if (typeof manifest.install_hint === 'string' && manifest.install_hint.trim()) {
          displaySuffix = '\n\n---\n\n' + manifest.install_hint.trim() + '\n';
        }
      }
    } catch (err) {
      if (err instanceof StringError) throw err;
      // Not JSON — leave source as-is (plain markdown response)
    }

    let transform: 'html-to-md' | undefined;
    if (this.htmlToMarkdown && isHtmlResponse(res)) {
      rawSource = source;
      source = this.htmlToMarkdown(source, uri);
      transform = 'html-to-md';
    }
    return { uri, source, rawSource, displaySuffix, transform };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Check if a fetch Response has an HTML content-type. */
function isHtmlResponse(res: Response): boolean {
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('text/html');
}

function fileUriToPath(uri: string): string {
  return fileURLToPath(uri);
}

function pathToFileUri(absPath: string): string {
  return pathToFileURL(absPath).toString();
}
