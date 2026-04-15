/**
 * Action execution: /act command and shared executeAction helper.
 */

import fs from 'fs';
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

  // Reject bare flags (e.g. `--city` with no following value) for non-boolean
  // fields. Without this, `--city` alone would silently parse as `city=true`
  // and reach the action's template as the literal string "true", producing
  // confusing results downstream (e.g. a weather lookup for the city "true").
  const fieldByName = new Map(action.fields.map(f => [f.name, f]));
  for (const bareKey of parsed.bareFlags) {
    const field = fieldByName.get(bareKey);
    // Unknown flag: leave it as a bare boolean, let rest-validation or the
    // template decide. Known flag with a non-boolean type: reject.
    if (field && field.type !== 'boolean') {
      return err(
        `Flag --${bareKey} requires a value (declared type: ${field.type}).\n` +
        `Usage: /act.${action.id} --${bareKey} <${field.type}>`,
        'INVALID_PAYLOAD',
      );
    }
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

  // Build the request body template, if the action declares one. `{field}`
  // placeholders are substituted with values from `payload` (and session
  // vars as a fallback). When the placeholder appears inside a JSON string
  // literal context, the value is JSON-string-escaped so embedded quotes
  // and backslashes don't break the resulting JSON. `$var` env refs are
  // also resolved (extraEnv → env-store → process.env).
  let resolvedBody: string | undefined;
  if (action.body !== undefined && !isCli) {
    resolvedBody = substituteBodyTemplate(action.body, payload, session);
    resolvedBody = resolveEnvVars(resolvedBody, loader, envScope, extraEnv);
  }

  // Execute the action
  try {
    const actionResult = await loader.action(
      resolvedUri,
      action.method,
      payload as Record<string, unknown>,
      session.currentUri ?? undefined,
      Object.keys(resolvedHeaders).length > 0 ? resolvedHeaders : undefined,
      resolvedBody,
    );

    // If action has a response template, execute it. The template is the
    // canonical place for response-shape concerns: variable extraction,
    // file save (save:/decode:/to:), and rendered output. Pass the action's
    // payload so directives like `to: {filename}` can substitute fields.
    if (action.responseTemplate) {
      const output = executeResponseTemplate(action.responseTemplate, actionResult, session, payload);
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

    // HTTP fallback (no response template declared): render the response as
    // text and return it as the action's output. The current document stays
    // unchanged — action invocation is *call this thing and read the result*,
    // not navigation. Conflating the two meant a second `/act.foo` after the
    // first would fail with "Action not found" because the JSON response
    // body had been opened as the new current document and that document had
    // no actions.
    //
    // For SFMD sites that genuinely want an action's response to BECOME the
    // next page (the form-post pattern: submit, land on result page), the
    // right way is an explicit `/open` after the action, or an opt-in
    // navigation directive — not silent navigation on every HTTP call. The
    // navigation behavior may come back later as opt-in if the use case
    // emerges; for now, the safe default is "actions don't navigate".
    const responseDoc = await resolve(actionResult.uri, actionResult.source, loader, undefined, actionResult.rawSource);
    const { content: rendered } = await render(responseDoc, undefined, loader.home, loader);
    return ok(rendered);
  } catch (e) {
    if (e instanceof StringError) return err(e.message, e.code);
    throw e;
  }
}

// ─── HTTP body templating + response extraction ─────────────────────────────

/**
 * Substitute `{field}` and `{field|modifier}` placeholders in an action's
 * body template.
 *
 * The template is typically JSON, so values that land inside a JSON string
 * literal must be JSON-escaped (quotes, backslashes, newlines, control chars).
 * The substitution function detects context heuristically: if the placeholder
 * is immediately surrounded by double quotes, it's inside a string and gets
 * escaped. Otherwise the value is inserted raw — for cases where the author
 * is interpolating a number, boolean, or pre-formatted JSON fragment.
 *
 * Resolution order for each placeholder name:
 *   1. payload (parsed action flags)
 *   2. session vars
 *   3. left as `{name}` if unresolved
 *
 * Supported modifiers (pipe-separated, Jinja-style):
 *   `{name|base64}`     base64-encode the field value as-is
 *   `{name|base64file}` treat the value as a file path, read the file's
 *                       bytes, and base64-encode them. Use this for binary
 *                       inputs like images that would otherwise blow past
 *                       the OS argv limit (~2MB on Linux) if passed as
 *                       base64 strings on the command line.
 *   `{name|file}`       treat the value as a file path, read the file as
 *                       UTF-8 text, and substitute the contents.
 *
 * Modifiers can be chained: `{name|file|base64}`.
 */
function substituteBodyTemplate(
  template: string,
  payload: Record<string, unknown>,
  session: Session,
): string {
  return template.replace(
    /(")?\{([a-zA-Z_]\w*)((?:\|[a-zA-Z][a-zA-Z0-9]*)*)\}(")?/g,
    (match: string, lq: string | undefined, name: string, modifierStr: string, rq: string | undefined): string => {
      let resolved: string;
      if (payload[name] !== undefined) {
        resolved = String(payload[name]);
      } else {
        const sessionVal = session.getVar(name);
        if (sessionVal === undefined) return match;
        resolved = sessionVal;
      }

      // Apply modifiers left-to-right.
      const modifiers = modifierStr.split('|').filter(Boolean);
      for (const mod of modifiers) {
        if (mod === 'base64') {
          resolved = Buffer.from(resolved, 'utf-8').toString('base64');
        } else if (mod === 'base64file') {
          try {
            const bytes: Buffer = fs.readFileSync(resolved);
            resolved = bytes.toString('base64');
          } catch (e) {
            // Leave the placeholder unresolved with an inline error marker
            // so the caller sees something useful instead of a silent JSON
            // parse error from the API.
            return `__BODY_TEMPLATE_ERROR__: cannot read ${resolved}: ${(e as Error).message}`;
          }
        } else if (mod === 'file') {
          try {
            resolved = fs.readFileSync(resolved, 'utf-8');
          } catch (e) {
            return `__BODY_TEMPLATE_ERROR__: cannot read ${resolved}: ${(e as Error).message}`;
          }
        } else {
          // Unknown modifier — leave placeholder intact for visibility
          return match;
        }
      }

      // Inside a JSON string: escape and re-emit the surrounding quotes.
      if (lq && rq) {
        return `"${jsonEscape(resolved)}"`;
      }
      // Outside a JSON string: insert raw.
      return resolved;
    },
  );
}

function jsonEscape(s: string): string {
  // Use JSON.stringify to handle every edge case (control chars, unicode,
  // surrogate pairs) correctly, then strip the surrounding quotes.
  const json = JSON.stringify(s);
  return json.slice(1, -1);
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
