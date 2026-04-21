/**
 * Navigation commands: /open, /back, /close, /refresh
 */

import fsPromises from 'fs/promises';
import { extract } from '@string-os/core';
import type { Loader } from '../loader.js';
import { resolve } from '../resolver.js';
import type { Session } from '../session.js';
import { render } from '../renderer.js';
import type { CommandResult } from '../types.js';
import { StringError } from '../types.js';
import {
  ok, err,
  toWorkspacePath,
  validateWorkspaceBoundary,
} from './helpers.js';
import { executeAction } from './action.js';
import { deriveEnvScope } from '../env-store.js';
import { cmdLs } from './info.js';

// ─── /open ────────────────────────────────────────────────────────────────────

export async function cmdOpen(
  topic: string,
  session: Session,
  loader: Loader,
): Promise<CommandResult> {
  if (!topic) {
    // No argument: re-open current document (like refresh, but re-runs default action)
    if (session.currentUri) {
      topic = session.currentUri;
    } else {
      return err(
        'Usage: /open <uri | path | file.md#block | @shortcut>\n' +
        'Examples:\n' +
        '  /open index.md\n' +
        '  /open guide/setup.md\n' +
        '  /open @home\n' +
        '  /open file.md#intro',
        'INVALID_TARGET'
      );
    }
  }

  // Parse fragment
  let uri = topic;
  let blockId: string | undefined;

  // @shortcut resolution
  if (topic.startsWith('@')) {
    const id = topic.slice(1);
    const href = session.resolveShortcut(id);
    if (!href) return err(`Shortcut not found: ${topic}`, 'NOT_FOUND');
    uri = href;
  }

  // Split uri#fragment
  const hashIdx = uri.indexOf('#');
  if (hashIdx !== -1) {
    blockId = uri.slice(hashIdx + 1);
    uri = uri.slice(0, hashIdx);
  }

  // Installed app resolution:
  //   bare name (e.g. "weather")         → apps registry lookup
  //   app:<name> (e.g. "app:weather")    → apps registry lookup
  //   tool:<name> (e.g. "tool:git")      → tools registry lookup
  // The typed forms match what `/install` prints as the next-step hint and
  // what the runtime docs reference as the canonical way to open an app.
  {
    let registryType: 'apps' | 'tools' | null = null;
    let registryName: string | null = null;
    if (/^app:[a-zA-Z0-9_-]+$/.test(uri)) {
      registryType = 'apps';
      registryName = uri.slice('app:'.length);
    } else if (/^tool:[a-zA-Z0-9_-]+$/.test(uri)) {
      registryType = 'tools';
      registryName = uri.slice('tool:'.length);
    } else if (!uri.includes('/') && !uri.includes('.') && !uri.includes('://') && !uri.startsWith('@')) {
      registryType = 'apps';
      registryName = uri;
    }
    if (registryType && registryName) {
      const registeredUri = loader.envStore.getPackage(registryType, registryName);
      if (registeredUri) {
        uri = registeredUri;
      }
    }
  }

  try {
    // Path resolution: cwd = current document's directory (or home if no doc open).
    // @shortcuts also resolve from current document (their href is doc-relative).
    // In web context, absolute paths like /en/quickstart are site-root-relative, not local files.
    const isWebContext = session.currentUri?.startsWith('https://') || session.currentUri?.startsWith('http://');
    const isRelative = !uri.includes('://') && (!uri.startsWith('/') || isWebContext);
    // cwdOverride → synthetic file:// base so loader.resolve's path.dirname() returns the directory
    const cwdBase = session.cwdOverride ? `file://${session.cwdOverride}/_` : undefined;
    const baseUri = (topic.startsWith('@') || isRelative) ? session.currentUri ?? cwdBase : undefined;

    // Directory → delegate to /ls
    const resolvedUri = loader.resolve(uri, baseUri);
    if (resolvedUri.startsWith('file://')) {
      const resolvedPath = new URL(resolvedUri).pathname;
      const boundaryError = validateWorkspaceBoundary(resolvedPath, loader.home, topic, loader.accessMode);
      if (boundaryError) return boundaryError;
      try {
        const stat = await fsPromises.stat(resolvedPath);
        if (stat.isDirectory()) {
          const result = await cmdLs(topic, session, loader);
          session.setCwdOverride(resolvedPath);
          return result;
        }
      } catch { /* not found — let loader.load handle it */ }
    }

    const loaded = await loader.load(uri, baseUri);
    const doc = await resolve(loaded.uri, loaded.source, loader, undefined, loaded.rawSource);

    if (blockId) {
      const result = extract(doc.source, blockId);
      if (!result.found) {
        const docDisplayPath = loaded.uri.startsWith('file://')
          ? toWorkspacePath(new URL(loaded.uri).pathname, loader.home)
          : loaded.uri;
        const available = doc.blockIds.length > 0
          ? `Available blocks: ${doc.blockIds.join(', ')}`
          : 'This document has no blocks.';
        return err(
          `Block not found: #${blockId} in ${docDisplayPath}\n${available}`,
          'BLOCK_NOT_FOUND'
        );
      }
    }

    session.open(doc, blockId);
    const displayPath = loaded.uri.startsWith('file://')
      ? toWorkspacePath(new URL(loaded.uri).pathname, loader.home)
      : loaded.uri;
    const openLabel = blockId ? `${displayPath}#${blockId}` : displayPath;
    const { content: rendered, autoShortcuts } = await render(doc, blockId, loader.home, loader);
    session.setAutoShortcuts(autoShortcuts);

    // Check frontmatter `requires: [VAR1, VAR2]` — warn about missing env vars
    const requires = doc.frontmatter.requires as string[] | undefined;
    let requiresWarning = '';
    if (requires && Array.isArray(requires) && !blockId) {
      const envScope = deriveEnvScope(session.name);
      const missing = requires.filter(name => {
        if (loader.envStore.get(name, envScope) !== undefined) return false;
        if (process.env[name] !== undefined) return false;
        return true;
      });
      if (missing.length > 0) {
        requiresWarning = '\n\n[!] Missing required environment variable' +
          (missing.length > 1 ? 's' : '') + ': ' +
          missing.map(n => `$${n}`).join(', ') + '\n' +
          'Set ' + (missing.length > 1 ? 'them' : 'it') + ' with: ' +
          missing.map(n => `/set ${n} <value>`).join(', ') +
          '\nSee setup instructions in this document.';
      }
    }

    // Default action: auto-execute if frontmatter declares one
    const defaultAction = doc.frontmatter.default as string | undefined;
    if (defaultAction && !blockId) {
      const action = doc.actions.find(a => a.id === defaultAction);
      if (action) {
        const actionResult = await executeAction(action, '', session, loader);
        if (actionResult.ok) {
          return ok(`Opened ${openLabel}\n---\n${rendered}${requiresWarning}\n\n---\n\n${actionResult.content}`);
        }
      }
    }

    return ok(`Opened ${openLabel}\n---\n${rendered}${requiresWarning}`);
  } catch (e) {
    if (e instanceof StringError) {
      // Add recovery hints for common errors
      let hint = '';
      if (e.code === 'NOT_FOUND') {
        hint = '\nRecovery: Use /ls to list available files, or check the path spelling.';
      }
      return err(e.message + hint, e.code);
    }
    throw e;
  }
}

// ─── /back ────────────────────────────────────────────────────────────────────

export async function cmdBack(session: Session, loader: Loader): Promise<CommandResult> {
  const prev = session.back();
  if (!prev) return err('No previous page in history.', 'INVALID_TARGET');

  try {
    const loaded = await loader.load(prev.doc.uri);
    const doc = await resolve(loaded.uri, loaded.source, loader, undefined, loaded.rawSource);
    session.refresh(doc);
    const displayPath = doc.uri.startsWith('file://')
      ? toWorkspacePath(new URL(doc.uri).pathname, loader.home)
      : doc.uri;
    const { content: rendered, autoShortcuts } = await render(doc, prev.blockId, loader.home, loader);
    session.setAutoShortcuts(autoShortcuts);
    return ok(`Back to ${displayPath}\n---\n${rendered}`);
  } catch {
    const displayPath = prev.doc.uri.startsWith('file://')
      ? toWorkspacePath(new URL(prev.doc.uri).pathname, loader.home)
      : prev.doc.uri;
    const { content: rendered, autoShortcuts } = await render(prev.doc, prev.blockId, loader.home, loader);
    session.setAutoShortcuts(autoShortcuts);
    return ok(`Back to ${displayPath}\n---\n${rendered}`);
  }
}

// ─── /close ───────────────────────────────────────────────────────────────────

export function cmdClose(session: Session): CommandResult {
  if (!session.currentDoc) return err('No document open.', 'INVALID_TARGET');
  const uri = session.currentUri;
  session.close();
  return ok(`Closed: ${uri}`);
}

// ─── /refresh ─────────────────────────────────────────────────────────────────

export async function cmdRefresh(session: Session, loader: Loader): Promise<CommandResult> {
  const uri = session.currentUri;
  const blockId = session.currentBlockId;
  if (!uri) return err('No document open.', 'INVALID_TARGET');

  try {
    const loaded = await loader.load(uri);
    const doc = await resolve(loaded.uri, loaded.source, loader, undefined, loaded.rawSource);
    session.refresh(doc);
    const displayPath = doc.uri.startsWith('file://')
      ? toWorkspacePath(new URL(doc.uri).pathname, loader.home)
      : doc.uri;
    const { content: rendered, autoShortcuts } = await render(doc, blockId, loader.home, loader);
    session.setAutoShortcuts(autoShortcuts);

    // Default action on refresh (same as /open)
    const defaultAction = doc.frontmatter.default as string | undefined;
    if (defaultAction && !blockId) {
      const action = doc.actions.find(a => a.id === defaultAction);
      if (action) {
        const actionResult = await executeAction(action, '', session, loader);
        if (actionResult.ok) {
          return ok(`Refreshed ${displayPath}\n---\n${rendered}\n\n---\n\n${actionResult.content}`);
        }
      }
    }

    return ok(`Refreshed ${displayPath}\n---\n${rendered}`);
  } catch (e) {
    if (e instanceof StringError) return err(e.message, e.code);
    throw e;
  }
}
