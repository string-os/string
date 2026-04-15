/**
 * Action execution: /act command and shared executeAction helper.
 */

import type { ActionDirective } from '@string-os/core';
import type { Loader, ActionResult } from '../loader.js';
import type { Session } from '../session.js';
import type { CommandResult, StringErrorCode, LoadedDocument } from '../types.js';
import { StringError } from '../types.js';
import { resolve } from '../resolver.js';
import { render, renderActions } from '../renderer.js';
import { deriveEnvScope } from '../env-store.js';
import {
  ok, err,
  parsePosixFlags,
  substituteVars,
  resolveEnvVars,
  executeResponseTemplate,
} from './helpers.js';

/**
 * Execute an action directive with parsed flags.
 * Shared by cmdAction (for /act) and cmdTool (for /tool).
 *
 * @param action    The action directive to execute
 * @param flagStr   Raw POSIX flag string (e.g. '--name "Seoul"')
 * @param session   Current session (for {var} substitution + response template storage)
 * @param loader    Document loader (for HTTP/CLI execution)
 * @param extraEnv  Extra env vars for $var resolution (tool context vars)
 */
export async function executeAction(
  action: ActionDirective,
  flagStr: string,
  session: Session,
  loader: Loader,
  extraEnv?: Record<string, string>,
): Promise<CommandResult> {
  // Parse POSIX flags — null means --help was present
  const parsed = parsePosixFlags(flagStr);
  if (parsed === null) {
    const doc = session.currentDoc;
    if (doc) return ok(`Action: ${action.id}\n---\n${renderActions(doc, action.id)}`);
    return ok(`Action: ${action.id}`);
  }

  // Substitute {var} in flag values
  const payload: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(parsed.flags)) {
    const sub = substituteVars(val, session);
    if (sub.error) return err(sub.error, 'INVALID_PAYLOAD');
    payload[key] = sub.result;
  }

  // Resolve @shortcut in flag values
  for (const [key, val] of Object.entries(payload)) {
    if (typeof val === 'string' && val.startsWith('@')) {
      const href = session.resolveShortcut(val.slice(1));
      if (href) payload[key] = href;
    }
  }

  // Fill missing fields with default values
  for (const field of action.fields) {
    if (field.defaultValue !== undefined && !(field.name in payload)) {
      payload[field.name] = field.defaultValue;
    }
  }

  // Substitute {var} and $var in action URI (path params)
  // Track which fields were consumed by URI substitution (skip required validation for these)
  const consumedByUri = new Set<string>();
  let resolvedUri = action.uri;

  const isCli = action.method === 'cli';

  // Shell-safe single-quote escaping for CLI substitution.
  // Empty → ''; all-safe chars → as-is; otherwise wrap in '...' with any
  // embedded ' escaped as '\''. This is POSIX sh's only fully reliable quoting.
  const shellQuote = (s: string): string => {
    if (s === '') return "''";
    if (/^[a-zA-Z0-9_\-./=@:+,]+$/.test(s)) return s;
    return `'${s.replace(/'/g, `'\\''`)}'`;
  };
  const cliSub = (val: string): string => isCli ? shellQuote(val) : encodeURIComponent(val);

  // {...args} — serialize remaining payload as --key value flags
  resolvedUri = resolvedUri.replace(/\{\.\.\.args\}/g, () => {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(payload)) {
      const val = String(v);
      // For CLI, always shell-quote. For HTTP, URL-encode.
      parts.push(`--${k} ${cliSub(val)}`);
    }
    // Mark all fields as consumed and remove from payload
    for (const k of Object.keys(payload)) {
      consumedByUri.add(k);
      delete payload[k];
    }
    return parts.join(' ');
  });

  resolvedUri = resolvedUri.replace(/\{([a-zA-Z_]\w*)\}/g, (_m, name) => {
    // If the flag matches a path param, consume it
    if (payload[name] !== undefined) {
      const val = String(payload[name]);
      consumedByUri.add(name);
      delete payload[name];
      return cliSub(val);
    }
    // Try session variable
    const sessionVal = session.getVar(name);
    if (sessionVal !== undefined) {
      consumedByUri.add(name);
      return cliSub(sessionVal);
    }
    return `{${name}}`;
  });
  // $var substitution in URI — resolved from extraEnv → EnvStore
  const envScope = deriveEnvScope(session.name);
  resolvedUri = resolveEnvVars(resolvedUri, loader, envScope, extraEnv);

  // Resolve headers: {var} and $var substitution
  const resolvedHeaders: Record<string, string> = {};
  for (const h of action.headers) {
    let value = h.value;
    // {var} substitution
    value = value.replace(/\{([a-zA-Z_]\w*)\}/g, (_m, name) => {
      const sessionVal = session.getVar(name);
      return sessionVal !== undefined ? sessionVal : `{${name}}`;
    });
    // $var substitution
    value = resolveEnvVars(value, loader, envScope, extraEnv);
    resolvedHeaders[h.key] = value;
  }

  // Validate required fields (skip fields already consumed by URI substitution)
  const missing = action.fields.filter(
    f => f.required && !(f.name in payload) && !consumedByUri.has(f.name),
  );
  if (missing.length > 0) {
    const schema = action.fields
      .map(f => `  --${f.name} <${f.type}>${f.required ? ' (required)' : ''}`)
      .join('\n');
    return err(`Missing required flags: ${missing.map(f => f.name).join(', ')}\n\nUsage:\n${schema}`, 'INVALID_PAYLOAD');
  }

  // Execute the action
  try {
    const actionResult = await loader.action(
      resolvedUri,
      action.method,
      payload as Record<string, unknown>,
      session.currentUri ?? undefined,
      Object.keys(resolvedHeaders).length > 0 ? resolvedHeaders : undefined,
    );

    // If action has a response template, execute it
    if (action.responseTemplate) {
      const output = executeResponseTemplate(action.responseTemplate, actionResult, session);
      return ok(output);
    }

    // CLI: return raw output
    if (action.method === 'cli') {
      return {
        ok: actionResult.status === 0,
        code: actionResult.status === 0 ? undefined : `EXIT_${actionResult.status}` as StringErrorCode,
        content: actionResult.source,
      };
    }

    // HTTP: treat response as an SFMD document
    const responseDoc = await resolve(actionResult.uri, actionResult.source, loader, undefined, actionResult.rawSource);
    session.open(responseDoc);
    const { content: rendered, autoShortcuts } = await render(responseDoc, undefined, loader.home, loader);
    session.setAutoShortcuts(autoShortcuts);
    return ok(rendered);
  } catch (e) {
    if (e instanceof StringError) return err(e.message, e.code);
    throw e;
  }
}

/**
 * /act command handler.
 */
export async function cmdAction(
  args: string,
  session: Session,
  loader: Loader,
): Promise<CommandResult> {
  const doc = session.currentDoc;
  if (!doc) return err('No document open. Use /open <uri> first.', 'INVALID_TARGET');

  // No args: list all actions
  if (!args.trim()) {
    return ok(`Actions\n---\n${renderActions(doc)}`);
  }

  // Split: first token is action id, rest is flags/payload
  const spaceIdx = args.indexOf(' ');
  const actionId = spaceIdx === -1 ? args.trim() : args.slice(0, spaceIdx).trim();
  const flagStr = spaceIdx === -1 ? '' : args.slice(spaceIdx + 1).trim();

  const action = doc.actions.find(a => a.id === actionId);
  if (!action) {
    const available = doc.actions.map(a => a.id).join(', ') || 'none';
    const hint = doc.actions.length > 0
      ? `\nUse /act.<name> --help to inspect an action.`
      : `\nNo actions defined on current document.`;
    return err(`Action not found: "${actionId}"\nAvailable: ${available}${hint}`, 'NOT_FOUND');
  }

  // No flags: if all fields have defaults or are optional, execute directly.
  // Otherwise show schema (same as --help).
  if (!flagStr) {
    const hasRequiredWithoutDefault = action.fields.some(
      f => f.required && f.defaultValue === undefined,
    );
    if (hasRequiredWithoutDefault) {
      return ok(`Action: ${actionId}\n---\n${renderActions(doc, actionId)}`);
    }
  }

  return executeAction(action, flagStr, session, loader);
}
