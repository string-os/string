/**
 * String — Command Dispatcher
 * Parses and executes commands against a Session.
 *
 * Returns CommandResult { ok, content }
 * - success: content is the viewport (clean document/nav/info)
 * - error:   content is the error message
 */

import type { Loader } from '../loader.js';
import type { Session } from '../session.js';
import type { CommandResult, TopicType } from '../types.js';
import { err } from './helpers.js';
import { cmdAction } from './action.js';
import { cmdOpen, cmdBack, cmdRefresh, cmdClose } from './open.js';
import { cmdNav } from './nav.js';
import { cmdInfo, cmdSource, cmdHelp, cmdLs } from './info.js';
import { cmdWrite, cmdAppend, cmdEdit, cmdVerify, cmdUndo } from './edit.js';
import { cmdSet } from './set.js';
import { cmdExec, dispatchBash } from './exec.js';
import { cmdTool } from './tool.js';
import { cmdInstall, cmdUninstall } from './packages.js';

// ─── Command Parser ──────────────────────────────────────────────────────────

/**
 * Parse command into header and optional multiline body.
 * Supports document-native multiline authoring for write/append/edit commands.
 *
 * Format:
 *   Single-line: /write file.md content here
 *   Multiline:   /write file.md
 *                content here
 *                with real newlines
 */
interface ParsedCommand {
  cmd: string;
  args: string;      // First line arguments (after command name)
  body?: string;     // Optional multiline body (everything after first newline)
}

function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();

  // Check for multiline format (header + body separated by newline)
  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline !== -1) {
    const header = trimmed.slice(0, firstNewline).trim();
    const body = trimmed.slice(firstNewline + 1); // Preserve exact body content

    if (header.startsWith('/')) {
      const [cmd, ...rest] = header.slice(1).split(/\s+/);
      return { cmd, args: rest.join(' '), body };
    }
  }

  // Single-line format: split by whitespace
  if (trimmed.startsWith('/')) {
    const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
    return { cmd, args: rest.join(' ') };
  }

  // Plain content (no slash command)
  return { cmd: '', args: trimmed };
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

export async function dispatch(
  input: string,
  session: Session,
  loader: Loader,
  topicType?: TopicType,
): Promise<CommandResult> {
  // Bash topics: plain text → stdin, // prefix → String command
  if (topicType === 'bash') {
    return dispatchBash(input, parseCommand(input), session, loader);
  }

  // // prefix → strip one /, treat as normal command (consistent with bash convention)
  const normalizedInput = input.trimStart().startsWith('//')
    ? input.trimStart().slice(1)
    : input;

  const parsed = parseCommand(normalizedInput);

  // Command-only mode: all input must start with /
  if (!parsed.cmd) {
    return err(
      'Commands must start with /. Use /help for details.',
      'COMMAND_UNSUPPORTED'
    );
  }

  const cmd = parsed.cmd.toLowerCase();

  switch (cmd) {
    case 'help':    return cmdHelp(session);
    case 'open':    return cmdOpen(parsed.args, session, loader);
    case 'nav':     return cmdNav(parsed.args, session);
    case 'act':     return cmdAction(parsed.args, session, loader);
    case 'back':    return cmdBack(session, loader);
    case 'close':   return cmdClose(session);
    case 'refresh': return cmdRefresh(session, loader);
    case 'info':    return cmdInfo(parsed.args, session, loader);
    case 'source':  return cmdSource(session);
    case 'ls':      return cmdLs(parsed.args, session, loader);
    case 'write':   return cmdWrite(parsed.args, parsed.body, session, loader);
    case 'append':  return cmdAppend(parsed.args, parsed.body, session, loader);
    case 'edit':    return cmdEdit(parsed.args, parsed.body, session, loader);
    case 'verify':  return cmdVerify(parsed.args, session, loader);
    case 'undo':    return cmdUndo(session, loader);
    case 'set':     return cmdSet(parsed.args, parsed.body, session, loader);
    case 'exec':    return cmdExec(parsed.args, session, loader);
    case 'install':   return cmdInstall(parsed.args, session, loader);
    case 'uninstall': return cmdUninstall(parsed.args, session, loader);
    default: {
      // Dot-notation routing: /act.search_city --name "Seoul" → cmdAction("search_city --name Seoul")
      const dotMatch = cmd.match(/^act\.([a-zA-Z0-9_-]+)$/);
      if (dotMatch) {
        const actionId = dotMatch[1];
        const actionArgs = parsed.args ? `${actionId} ${parsed.args}` : actionId;
        return cmdAction(actionArgs, session, loader);
      }
      // Tool routing: /tool:name or /tool:name.act
      const toolMatch = cmd.match(/^tool:([a-zA-Z0-9_-]+)(?:\.([a-zA-Z0-9_-]+))?$/);
      if (toolMatch) {
        const toolName = toolMatch[1];
        const subAction = toolMatch[2];
        return cmdTool(toolName, subAction, parsed.args, session, loader);
      }
      return err(`Unknown command: /${parsed.cmd}\nUse /info to see available commands.`, 'COMMAND_UNSUPPORTED');
    }
  }
}
