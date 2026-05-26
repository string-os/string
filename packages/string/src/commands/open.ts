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
import { buildContextVars } from './context-vars.js';
import { deriveEnvScope } from '../env-store.js';
import { cmdLs } from './info.js';
import { isHubName } from '../types.js';
import { renderHub } from './hub.js';

// ─── /open ────────────────────────────────────────────────────────────────────

export async function cmdOpen(
  topic: string,
  session: Session,
  loader: Loader,
): Promise<CommandResult> {
  if (!topic) {
    // No argument:
    //  - hub topic → show the hub's placeholder/listing
    //  - app:<name> → re-open the app's index.md (= app home)
    //  - otherwise re-open whatever was last opened, or show usage
    if (isHubName(session.name)) {
      return ok(renderHub(session.name, loader));
    }
    if (session.name.startsWith('app:')) {
      topic = session.name; // e.g. "app:moltbook-browse" → resolved by registry below
    } else if (session.currentUri) {
      topic = session.currentUri;
    } else {
      return err(
        'Usage: /open <uri | path | file.md#block | @shortcut>\n' +
        'Examples:\n' +
        '  /open string.md\n' +
        '  /open guide/setup.md\n' +
        '  /open @home\n' +
        '  /open file.md#intro',
        'INVALID_TARGET'
      );
    }
  }

  // Bare hub name (`/open app`, `/open bash`, ...) → render the hub
  // placeholder. The CLI already routes this command to the hub topic so the
  // session is on the right canonical name; we just need to produce content.
  if (isHubName(topic)) {
    return ok(renderHub(topic, loader));
  }

  // Parse fragment
  let uri = topic;
  let blockId: string | undefined;

  // @shortcut resolution
  if (topic.startsWith('@')) {
    const id = topic.slice(1);
    const resolved = session.resolveShortcut(id);
    if (resolved === null) return err(`Shortcut not found: ${topic}`, 'NOT_FOUND');
    if (Array.isArray(resolved)) {
      return err(
        `Shortcut ${topic} is a value tuple, not a navigable target. ` +
        `Use it as an action argument (e.g. /act.<name> ${topic} ...) instead of /open.`,
        'INVALID_TARGET',
      );
    }
    uri = resolved;
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
    // `app:<name>` or `app:<name>:<config>` — config segment is a topic-level
    // env scope marker, not part of the package name. The package always lives
    // at the bare-name lookup; config is consulted later for env resolution.
    const appMatch = uri.match(/^app:([a-zA-Z0-9_-]+)(?::[a-zA-Z0-9_-]+)*$/);
    const toolMatch = !appMatch ? uri.match(/^tool:([a-zA-Z0-9_-]+)(?::[a-zA-Z0-9_-]+)*$/) : null;
    if (appMatch) {
      registryType = 'apps';
      registryName = appMatch[1];
    } else if (toolMatch) {
      registryType = 'tools';
      registryName = toolMatch[1];
    } else if (!uri.includes('/') && !uri.includes('.') && !uri.includes('://') && !uri.startsWith('@')) {
      registryType = 'apps';
      registryName = uri;
    }
    if (registryType && registryName) {
      const registeredUri = loader.envStore.getPackage(registryType, registryName);
      if (registeredUri) {
        uri = registeredUri;
      } else if (appMatch || toolMatch) {
        // Explicit app:/tool: form must resolve from the registry. If we let
        // it fall through to path resolution, the colon-prefixed string ends
        // up joined onto the cwd (e.g. "packages/translate/app:translate"),
        // which surfaces as a confusing ENOENT instead of the real cause.
        const installed = Object.keys(loader.envStore.listPackages(registryType));
        const label = registryType === 'apps' ? 'App' : 'Tool';
        const hint = installed.length
          ? `\nInstalled ${registryType}: ${installed.join(', ')}`
          : `\nNo ${registryType} installed yet. Use /install <source> to add one.`;
        return err(
          `${label} '${registryName}' is not installed. ` +
          `Run /install <source> to install it.${hint}`,
          'NOT_FOUND'
        );
      }
      // Bare-name miss falls through silently — same string may also be a
      // valid relative path (legacy behavior preserved).
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

    // Directory → if it contains string.md, open that as the App/Tool root.
    // Otherwise fall back to /ls.
    const resolvedUri = loader.resolve(uri, baseUri);
    if (resolvedUri.startsWith('file://')) {
      const resolvedPath = new URL(resolvedUri).pathname;
      const boundaryError = validateWorkspaceBoundary(resolvedPath, loader.home, topic, loader.accessMode);
      if (boundaryError) return boundaryError;
      try {
        const stat = await fsPromises.stat(resolvedPath);
        if (stat.isDirectory()) {
          const stringMd = `${resolvedPath}/string.md`;
          try {
            await fsPromises.stat(stringMd);
            uri = `file://${stringMd}`;
          } catch {
            const result = await cmdLs(topic, session, loader);
            session.setCwdOverride(resolvedPath);
            return result;
          }
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
    const envScope = deriveEnvScope(session.name);
    const { content: rendered, autoShortcuts } = await render(doc, blockId, loader.home, loader, envScope);
    session.setAutoShortcuts(autoShortcuts);

    // displaySuffix is appended at the very end — purely cosmetic, not
    // persisted, not parsed. Currently used to surface install-hint when
    // /open targets a marketplace manifest URL (pre-install browse).
    const suffix = loaded.displaySuffix ?? '';

    // Surface HTML→markdown conversion so the agent can attribute layout
    // quirks (orphan links, missing images, weird ordering) to the converter
    // rather than to the site itself. Native markdown sources (file://, or
    // HTTP with text/markdown content negotiation) stay silent — the
    // asymmetry is intentional: "marker present = derivative" is one bit
    // the agent learns once.
    const transformNote = loaded.transform === 'html-to-md'
      ? '\nSource: HTML auto-converted to markdown — the site does not serve text/markdown natively'
      : '';

    // Default action: auto-execute if frontmatter declares one
    const defaultAction = doc.frontmatter.default as string | undefined;
    if (defaultAction && !blockId) {
      const action = doc.actions.find(a => a.id === defaultAction);
      if (action) {
        const actionResult = await executeAction(action, '', session, loader, buildContextVars(session, loader));
        if (actionResult.ok) {
          return ok(`Opened ${openLabel}${transformNote}\n---\n${rendered}\n\n---\n\n${actionResult.content}${suffix}`);
        }
      }
    }

    return ok(`Opened ${openLabel}${transformNote}\n---\n${rendered}${suffix}`);
  } catch (e) {
    if (e instanceof StringError) {
      // Add recovery hints for common errors. URL fetch failures must steer
      // the caller toward URL-shaped alternatives (re-check the URL, use a
      // shortcut from the current page) — the generic /ls workspace hint is
      // misleading when the failing target is a remote resource.
      let hint = '';
      if (e.code === 'NOT_FOUND') {
        const isUrl = uri.startsWith('http://') || uri.startsWith('https://');
        if (isUrl) {
          const currentDoc = session.currentDoc;
          const pageNames = currentDoc ? [...currentDoc.shortcuts.keys()] : [];
          const autoNames = [...session.autoShortcuts.keys()];
          const all = [...pageNames, ...autoNames];
          if (all.length > 0) {
            const cap = 8;
            const shown = all.slice(0, cap).map(n => `@${n}`).join(', ');
            const more = all.length - cap;
            const tail = more > 0 ? `, +${more} more (run /info)` : '';
            hint = `\nRecovery: Verify the URL, or use a shortcut from the current page: ${shown}${tail}`;
          } else {
            hint = '\nRecovery: Verify the URL spelling, scheme, and path. Use /info to see shortcuts on the current page.';
          }
        } else {
          hint = '\nRecovery: Use /ls to list available files, or check the path spelling.';
        }
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
    const envScope = deriveEnvScope(session.name);
    const { content: rendered, autoShortcuts } = await render(doc, prev.blockId, loader.home, loader, envScope);
    session.setAutoShortcuts(autoShortcuts);

    // Default action on /back (same as /open)
    const defaultAction = doc.frontmatter.default as string | undefined;
    if (defaultAction && !prev.blockId) {
      const action = doc.actions.find(a => a.id === defaultAction);
      if (action) {
        const actionResult = await executeAction(action, '', session, loader, buildContextVars(session, loader));
        if (actionResult.ok) {
          return ok(`Back to ${displayPath}\n---\n${rendered}\n\n---\n\n${actionResult.content}`);
        }
      }
    }

    return ok(`Back to ${displayPath}\n---\n${rendered}`);
  } catch {
    const displayPath = prev.doc.uri.startsWith('file://')
      ? toWorkspacePath(new URL(prev.doc.uri).pathname, loader.home)
      : prev.doc.uri;
    const envScope = deriveEnvScope(session.name);
    const { content: rendered, autoShortcuts } = await render(prev.doc, prev.blockId, loader.home, loader, envScope);
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
    const envScope = deriveEnvScope(session.name);
    const { content: rendered, autoShortcuts } = await render(doc, blockId, loader.home, loader, envScope);
    session.setAutoShortcuts(autoShortcuts);

    // Default action on refresh (same as /open)
    const defaultAction = doc.frontmatter.default as string | undefined;
    if (defaultAction && !blockId) {
      const action = doc.actions.find(a => a.id === defaultAction);
      if (action) {
        const actionResult = await executeAction(action, '', session, loader, buildContextVars(session, loader));
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
