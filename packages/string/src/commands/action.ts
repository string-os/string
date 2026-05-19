/**
 * Action execution: /act command and shared executeAction helper.
 */

import fs from 'fs';
import type { ActionDirective } from '@string-os/core';
import type { Loader, ActionResult } from '../loader.js';
import type { Session } from '../session.js';
import type { CommandResult, StringErrorCode, LoadedDocument } from '../types.js';
import { StringError, parseTopic } from '../types.js';
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
import { buildContextVars } from './context-vars.js';
import { cmdOpen } from './open.js';

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
  // Append "Setup info: /open <path>" to error content when the current doc
  // has a requirements file registered. Surfaces the setup doc at the moment
  // it's most likely to help — when an action just failed.
  const withSetupHint = (content: string): string => {
    const reqs = session.currentDoc?.requirements;
    if (!reqs) return content;
    return `${content}\n\nSetup info: /open ${reqs.path}`;
  };

  // Build short alias map from field definitions (e.g. {c: 'city'})
  const shortToLong: Record<string, string> = {};
  for (const f of action.fields) {
    if (f.short) shortToLong[f.short] = f.name;
  }

  // Parse POSIX flags — null means --help or -h was present
  const parsed = parsePosixFlags(flagStr, shortToLong);
  if (parsed === null) {
    const doc = session.currentDoc;
    if (doc) return ok(`Action: ${action.id}\n---\n${renderActions(doc, action.id)}`);
    return ok(`Action: ${action.id}`);
  }

  // Bind positional operands to fields in declaration order
  // (GNU/POSIX-style: `/act.forecast Seoul 1` is equivalent to
  // `/act.forecast --city Seoul --days 1`). Both required and optional
  // fields can receive positional values — this matches how real CLIs
  // document signatures like `<city> [days]`. A field that has already
  // been set by `--flag value` is skipped.
  //
  // If the action declares no fields at all, leave `rest` untouched: tools
  // like `CLI echo $ARGS` rely on the raw arg string passing through, and
  // positional binding would steal those tokens.
  if (parsed.rest.length > 0 && action.fields.length > 0) {
    const unfilled = action.fields.filter(f => !(f.name in parsed.flags));
    if (parsed.rest.length > unfilled.length) {
      const names = action.fields.map(f => f.name).join(', ');
      return err(
        `Too many positional arguments for /act.${action.id}.\n` +
        `Expected up to ${unfilled.length} positional value${unfilled.length === 1 ? '' : 's'}` +
        ` (field${action.fields.length === 1 ? '' : 's'}: ${names || 'none'})` +
        `, got ${parsed.rest.length}.\n` +
        `Use -- to pass values that start with '-'.`,
        'INVALID_PAYLOAD',
      );
    }
    for (let i = 0; i < parsed.rest.length; i++) {
      parsed.flags[unfilled[i].name] = parsed.rest[i];
    }
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

  // Resolve @shortcut in flag values. Value shortcuts (from {@var}=expr in
  // response templates) may resolve to a tuple (string[]); URI/body
  // substitution then accesses elements via {name[N]} syntax.
  //
  // Only resolve when the whole value matches the @<slug> shape (single token,
  // slug chars only) — that signals intent. A value like "@user said hi" is a
  // normal string, not a shortcut reference, and falls through unchanged.
  // An unresolved single-token @<slug> errors out so the action doesn't run
  // against an empty value and silently succeed against an unrelated target.
  const SHORTCUT_REF = /^@[a-zA-Z_][\w-]*$/;
  for (const [key, val] of Object.entries(payload)) {
    if (typeof val === 'string' && SHORTCUT_REF.test(val)) {
      const id = val.slice(1);
      const resolved = session.resolveShortcut(id);
      if (resolved === null) {
        const doc = session.currentDoc;
        const ids = new Set<string>([
          ...(doc ? doc.shortcuts.keys() : []),
          ...session.valueShortcuts.keys(),
          ...session.autoShortcuts.keys(),
        ]);
        const available = [...ids];
        const list = available.length > 0
          ? `\nAvailable: ${available.slice(0, 12).map(k => `@${k}`).join(', ')}${available.length > 12 ? ', ...' : ''}`
          : '\n(no shortcuts in this session yet — run a list action like /act.repo or /act.feed to register them)';
        return err(`Unknown shortcut: ${val}${list}`, 'NOT_FOUND');
      }
      payload[key] = resolved;
    }
  }

  // Fill missing fields with default values
  for (const field of action.fields) {
    if (field.defaultValue !== undefined && !(field.name in payload)) {
      payload[field.name] = field.defaultValue;
    }
  }

  // Resolve $VAR refs that appear in default values. This pass runs *before*
  // URI/body substitution so `$VAR` doesn't get URL-encoded (`$` → `%24`),
  // which would defeat the later resolveEnvVars pass on the URI. Lets authors
  // write `city: string = "$CITY"` and have the env var land naturally.
  // Only acts on string-typed payload entries (tuples, numbers untouched).
  const earlyEnvScope = deriveEnvScope(session.name);
  const earlyUnresolved = new Set<string>();
  for (const k of Object.keys(payload)) {
    const v = payload[k];
    if (typeof v === 'string' && v.includes('$')) {
      const resolved = resolveEnvVars(v, loader, earlyEnvScope, extraEnv);
      payload[k] = resolved;
      // Scan for any $VAR that survived resolution — these are vars referenced
      // in defaults but never set anywhere. Without this check, the value would
      // be URL-encoded ($→%24) and the existing unresolved-var check on the URI
      // would miss it.
      for (const m of resolved.matchAll(/\$([A-Z_][A-Z0-9_]*)/g)) {
        earlyUnresolved.add(m[1]);
      }
    }
  }
  if (earlyUnresolved.size > 0) {
    const names = [...earlyUnresolved].map(n => `$${n}`).join(', ');
    const setLines = earlyEnvScope.app
      ? [...earlyUnresolved].map(n => `  /set $${n} = "..."`).join('\n')
      : `  string app:<name> '/set $${[...earlyUnresolved][0]} = "..."'`;
    const setHintPrefix = earlyEnvScope.app
      ? `Set ${earlyUnresolved.size > 1 ? 'them' : 'it'} from this app session:`
      : `Persistent env vars are app-scoped. Open an app session first:`;
    return err(
      `Unresolved environment variable${earlyUnresolved.size > 1 ? 's' : ''} in field default:\n  ${names}\n\n` +
      `${setHintPrefix}\n${setLines}\n` +
      `Or pass the field explicitly: /act.${action.id} --<field> <value>`,
      'INVALID_PAYLOAD',
    );
  }

  // Snapshot the parsed input fields BEFORE URI/body substitution mutates
  // payload (URI substitution deletes consumed keys to avoid double-sending
  // them as query/body params). The response template runs *after* execution,
  // and still wants access to whatever fields the caller passed in — e.g. an
  // @-shortcut directive that references `{post}` to compose a tuple slug
  // pairing the input id with each comment id from the response body.
  const inputFields: Record<string, unknown> = { ...payload };

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

  // Stringify a payload value for substitution. Tuples (string[]) join with
  // commas as a fallback when referenced without an index — visible enough to
  // debug authorial mistakes (the right form is `{name[N]}`).
  const stringifyPayloadVal = (v: unknown): string =>
    Array.isArray(v) ? v.map(String).join(',') : String(v);

  // {...args} — serialize remaining payload as --key value flags
  resolvedUri = resolvedUri.replace(/\{\.\.\.args\}/g, () => {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(payload)) {
      const val = stringifyPayloadVal(v);
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

  // URI substitution. Supports `{name}` (whole value) and `{name[N]}` (tuple
  // index). Payload entries are NOT deleted during the replace pass — that
  // would cause a second `{name}` (or `{name[1]}` after `{name[0]}`) to fall
  // through as literal. We collect consumed keys and delete them after the
  // pass completes, so leftover payload doesn't get re-sent as query/body.
  const uriConsumedFromPayload = new Set<string>();
  resolvedUri = resolvedUri.replace(
    /\{([a-zA-Z_]\w*)(?:\[(\d+)\])?\}/g,
    (_m, name, idxStr) => {
      if (payload[name] !== undefined) {
        const val = payload[name];
        consumedByUri.add(name);
        uriConsumedFromPayload.add(name);
        if (idxStr !== undefined) {
          const idx = parseInt(idxStr, 10);
          const arr = Array.isArray(val) ? val : [String(val)];
          const item = idx < arr.length ? String(arr[idx]) : '';
          return cliSub(item);
        }
        return cliSub(stringifyPayloadVal(val));
      }
      // Try session variable (no index support — session vars are scalar strings)
      const sessionVal = session.getVar(name);
      if (sessionVal !== undefined) {
        consumedByUri.add(name);
        return cliSub(sessionVal);
      }
      return idxStr !== undefined ? `{${name}[${idxStr}]}` : `{${name}}`;
    },
  );
  // Delete payload entries consumed by URI substitution (after replace pass).
  for (const k of uriConsumedFromPayload) delete payload[k];
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
    // Use the input snapshot — URI substitution may have deleted fields that
    // the body template still wants to reference (e.g. `{reply[0]}` in URI
    // path AND `{reply[1]}` in body for a tuple-shaped input).
    resolvedBody = substituteBodyTemplate(action.body, inputFields, session);
    resolvedBody = resolveEnvVars(resolvedBody, loader, envScope, extraEnv);
  }

  // Detect unresolved $VAR before sending HTTP requests. A literal $NAME
  // in the resolved URI, headers, or body means an env var was declared
  // but never set. Catch it here with a clear message instead of letting
  // the remote server reject a malformed request.
  // CLI actions are exempt — $VAR in a shell command is normal shell usage.
  if (!isCli) {
  const unresolvedVarRe = /\$([A-Z_][A-Z0-9_]*)/g;
  const unresolvedVars = new Set<string>();
  for (const m of resolvedUri.matchAll(unresolvedVarRe)) unresolvedVars.add(m[1]);
  for (const v of Object.values(resolvedHeaders)) {
    for (const m of v.matchAll(unresolvedVarRe)) unresolvedVars.add(m[1]);
  }
  if (resolvedBody) {
    for (const m of resolvedBody.matchAll(unresolvedVarRe)) unresolvedVars.add(m[1]);
  }
  if (unresolvedVars.size > 0) {
    const names = [...unresolvedVars];
    const list = names.map(n => `  $${n}`).join('\n');
    const appScope = deriveEnvScope(session.name);
    const setHintPrefix = appScope.app
      ? `Set ${names.length > 1 ? 'them' : 'it'} from this app session:`
      : `Persistent env vars are app-scoped. Open an app session first:`;
    const setLines = appScope.app
      ? names.map(n => `  /set $${n} = "..."`).join('\n')
      : `  string app:<name> '/set $${names[0]} = "..."'`;
    return err(
      withSetupHint(
        `Unresolved environment variable${names.length > 1 ? 's' : ''}:\n${list}\n\n` +
        `${setHintPrefix}\n${setLines}`,
      ),
      'INVALID_PAYLOAD',
    );
  }
  } // end !isCli

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

    // If action has a response template, execute it. The template output
    // is treated as SFMD source: resolved + rendered so that any markdown
    // links in the output become auto-shortcuts the agent can follow with
    // /open @slug. Shortcuts are MERGED into the session (not replaced),
    // preserving the app's string.md nav/actions/shortcuts so the agent can
    // still call other actions after reading a response.
    if (action.responseTemplate) {
      const sfmdSource = executeResponseTemplate(action.responseTemplate, actionResult, session, inputFields);
      const tempDoc = await resolve(`response://${action.id}`, sfmdSource, loader);
      const { content: rendered, autoShortcuts: newShortcuts } = await render(tempDoc, undefined, loader.home, loader);
      const merged = new Map(session.autoShortcuts);
      for (const [id, href] of newShortcuts) { merged.set(id, href); }
      session.setAutoShortcuts(merged);
      return ok(rendered);
    }

    // CLI: return raw output. On non-zero exit, append setup hint when the
    // doc has a requirements file — common cause is a missing CLI tool the
    // app's requirements.md tells you to install.
    if (action.method === 'cli') {
      const failed = actionResult.status !== 0;
      return {
        ok: !failed,
        code: failed ? `EXIT_${actionResult.status}` as StringErrorCode : undefined,
        content: failed ? withSetupHint(actionResult.source) : actionResult.source,
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
    if (e instanceof StringError) return err(withSetupHint(e.message), e.code);
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
    /(")?\{([a-zA-Z_]\w*)(?:\[(\d+)\])?((?:\|[a-zA-Z][a-zA-Z0-9]*)*)\}(")?/g,
    (match: string, lq: string | undefined, name: string, idxStr: string | undefined, modifierStr: string, rq: string | undefined): string => {
      let resolved: string;
      if (payload[name] !== undefined) {
        const val = payload[name];
        if (idxStr !== undefined) {
          // Tuple index access
          const idx = parseInt(idxStr, 10);
          const arr = Array.isArray(val) ? val : [String(val)];
          resolved = idx < arr.length ? String(arr[idx]) : '';
        } else if (Array.isArray(val)) {
          // Tuple referenced without index — fall back to comma-join (visible
          // for debugging; correct usage is `{name[N]}`).
          resolved = val.map(String).join(',');
        } else {
          resolved = String(val);
        }
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
  let doc = session.currentDoc;
  if (!doc) {
    // Auto-open: app sessions resolve to a canonical doc (the app's index),
    // so a first /act after a daemon restart or fresh session shouldn't make
    // the agent run /open separately. tab/bash/hub topics still error — they
    // have no canonical doc to auto-open.
    const parsed = parseTopic(session.name);
    if (parsed?.type === 'app') {
      const appName = parsed.namespace.split(':')[0];
      const openResult = await cmdOpen(`app:${appName}`, session, loader);
      if (!openResult.ok) return openResult;
      doc = session.currentDoc;
    }
    if (!doc) return err('No document open. Use /open <uri> first.', 'INVALID_TARGET');
  }

  const trimmed = args.trim();

  // No args, or top-level --help/-h: list every action's full schema. Lets
  // callers run `/act --help` to inspect the entire action surface in one
  // shot, instead of `/act.<name> --help` per action.
  if (!trimmed || trimmed === '--help' || trimmed === '-h') {
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

  // App actions get the same context vars as tools — $CWD, $HOME (String
  // per-user home), $CURRENT_FILE/URI/TARGET/BLOCK, $ARGS. These are
  // daemon-defined, computed per call, and isolated from process.env. Apps
  // never see OS-level env vars.
  return executeAction(action, flagStr, session, loader, buildContextVars(session, loader, flagStr));
}
