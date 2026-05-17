/**
 * /set command handler — session and persistent variable management.
 */

import type { Loader } from '../loader.js';
import type { Session } from '../session.js';
import type { CommandResult } from '../types.js';
import { deriveEnvScope } from '../env-store.js';
import { ok, err } from './helpers.js';

export function cmdSet(args: string, body: string | undefined, session: Session, loader: Loader): CommandResult {
  // Phase 1: pre-parse code blocks + plain lines from body
  const codeBlockAssignments: Array<{name: string, value: string, persistent: boolean}> = [];
  const plainLines: string[] = [];

  if (args.trim()) plainLines.push(args.trim());

  if (body !== undefined) {
    const bodyLines = body.split('\n');
    let i = 0;
    while (i < bodyLines.length) {
      // Support both {var} and $VAR in code block fences
      const fenceMatch = bodyLines[i].match(/^(`{3,})(?:\{([a-zA-Z_]\w*)\}|\$([a-zA-Z_]\w*))\s*$/);
      if (fenceMatch) {
        const fenceLen = fenceMatch[1].length;
        const varName = fenceMatch[2] ?? fenceMatch[3];
        const isPersistent = !!fenceMatch[3]; // $VAR style
        const contentLines: string[] = [];
        i++;
        while (i < bodyLines.length) {
          if (/^`{3,}\s*$/.test(bodyLines[i]) && bodyLines[i].trim().length >= fenceLen) break;
          contentLines.push(bodyLines[i]);
          i++;
        }
        i++; // skip closing fence
        codeBlockAssignments.push({ name: varName, value: contentLines.join('\n'), persistent: isPersistent });
      } else {
        const trimmed = bodyLines[i].trim();
        if (trimmed) plainLines.push(trimmed);
        i++;
      }
    }
  }

  // No input: show current variables (both session {var} and persistent $var)
  if (plainLines.length === 0 && codeBlockAssignments.length === 0) {
    const sessionVars = session.getAllVars();
    const envScope = deriveEnvScope(session.name);
    const envVars = loader.envStore.getAll(envScope);
    if (sessionVars.size === 0 && Object.keys(envVars).length === 0) {
      return ok('No variables set.');
    }
    const out: string[] = [];
    for (const [k, v] of sessionVars) {
      out.push(`{${k}} = "${v}"`);
    }
    for (const [k, v] of Object.entries(envVars)) {
      out.push(`$${k} = "${v}"`);
    }
    return ok(`Variables\n---\n${out.join('\n')}`);
  }

  // Phase 2: parse plain lines — support both {var} and $VAR
  // {var} or bare name → session variable
  // $VAR → persistent env variable
  const SESSION_SET_RE = /^\{?([a-zA-Z_]\w*)\}?\s*=\s*(?:"([^"]*)"|'([^']*)'|(.+))$/;
  const ENV_SET_RE = /^\$([a-zA-Z_]\w*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(.+))$/;
  const results: string[] = [];

  for (const line of plainLines) {
    // Try $VAR = "value" first (persistent env)
    const envMatch = line.match(ENV_SET_RE);
    if (envMatch) {
      const name = envMatch[1];
      const value = (envMatch[2] ?? envMatch[3] ?? envMatch[4]).trim();
      const envScope = deriveEnvScope(session.name);
      if (!envScope.app) {
        return err(
          `$${name}: persistent env vars are app-scoped. Run /set from an app session:\n` +
          `  string app:<name> '/set $${name} = "${value}"'`,
          'INVALID_TARGET',
        );
      }
      loader.envStore.set(name, value, envScope);
      const scopeLabel = envScope.config
        ? ` (${envScope.app}:${envScope.config})`
        : ` (${envScope.app})`;
      results.push(`$${name} = "${value}"${scopeLabel}`);
      continue;
    }

    // Try {var} = "value" (session variable)
    const sessionMatch = line.match(SESSION_SET_RE);
    if (sessionMatch) {
      const name = sessionMatch[1];
      const value = (sessionMatch[2] ?? sessionMatch[3] ?? sessionMatch[4]).trim();
      session.setVar(name, value);
      results.push(`{${name}} = "${value}"`);
      continue;
    }

    return err(`Invalid assignment: ${line}\nUsage: /set {var} = "value" or /set $VAR = "value"`, 'INVALID_PAYLOAD');
  }

  // Phase 3: apply code block assignments
  for (const { name, value, persistent } of codeBlockAssignments) {
    if (persistent) {
      const envScope = deriveEnvScope(session.name);
      if (!envScope.app) {
        return err(
          `$${name}: persistent env vars are app-scoped. Run /set from an app session.`,
          'INVALID_TARGET',
        );
      }
      loader.envStore.set(name, value, envScope);
      const display = value.includes('\n') ? `(${value.split('\n').length} lines)` : `"${value}"`;
      results.push(`$${name} = ${display}`);
    } else {
      session.setVar(name, value);
      const display = value.includes('\n') ? `(${value.split('\n').length} lines)` : `"${value}"`;
      results.push(`{${name}} = ${display}`);
    }
  }

  return ok(results.join('\n'));
}
