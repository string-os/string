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
  /** Raw markdown source */
  source: string;
  /** Original source before conversion (e.g. raw HTML before htmlToMarkdown) */
  rawSource?: string;
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

export class Loader {
  readonly home: string;
  readonly accessMode: AccessMode;
  readonly envStore: EnvStore;
  private readonly allowHttp: boolean;
  private readonly htmlToMarkdown: HtmlToMarkdown | null;

  constructor(options: LoaderOptions = {}) {
    this.home = options.home ?? process.cwd();
    this.allowHttp = options.allowHttp ?? true;
    this.accessMode = options.accessMode ?? 'full';
    this.envStore = new EnvStore(this.home);
    this.htmlToMarkdown = options.htmlToMarkdown ?? null;
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
   */
  async action(
    topic: string,
    method: string,
    body: Record<string, unknown>,
    baseUri?: string,
    headers?: Record<string, string>,
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
      init = {
        method: verb,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/markdown, text/plain',
          ...headers,
        },
        body: JSON.stringify(body),
      };
    }

    let res: Response;
    try {
      res = await fetch(uri, init);
    } catch (err) {
      throw new StringError('LOAD_ERROR', `Network error: ${(err as Error).message}`);
    }

    if (res.status === 404) throw new StringError('NOT_FOUND', `Not found: ${uri}`);
    if (!res.ok) throw new StringError('LOAD_ERROR', `HTTP ${res.status} at ${uri}`);

    let source = await res.text();
    let rawSource: string | undefined;

    // Convert HTML responses if converter is available
    if (this.htmlToMarkdown && isHtmlResponse(res)) {
      rawSource = source;
      source = this.htmlToMarkdown(source, uri);
    }

    // Try to parse response as JSON
    let jsonBody: unknown = null;
    try {
      jsonBody = JSON.parse(source);
    } catch {
      // Not JSON — leave as null
    }

    return { uri, source, rawSource, status: res.status, jsonBody };
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
        headers: { Accept: 'text/markdown, text/plain' },
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
    if (this.htmlToMarkdown && isHtmlResponse(res)) {
      rawSource = source;
      source = this.htmlToMarkdown(source, uri);
    }
    return { uri, source, rawSource };
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
