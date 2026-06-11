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
import { err, ok } from './helpers.js';
import { renderHub } from './hub.js';
import { cmdAction } from './action.js';
import { cmdOpen, cmdBack, cmdRefresh, cmdClose } from './open.js';
import { cmdNav } from './nav.js';
import { cmdInfo, cmdSource, cmdHelp, cmdLs } from './info.js';
import { cmdWrite, cmdAppend, cmdReplace, cmdEdit, cmdVerify, cmdUndo } from './edit.js';
import { cmdSet } from './set.js';
import { cmdExec, dispatchBash } from './exec.js';
import { cmdTool } from './tool.js';
import { cmdInstall, cmdUninstall } from './packages.js';
import { cmdEvents } from './events.js';
import { cmdAgentHub, cmdEventWebhook, cmdSystemHub } from './management.js';

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
      // Preserve raw args (don't collapse internal whitespace via split/join).
      const after = header.slice(1);
      const sp = after.search(/\s/);
      const cmd = sp === -1 ? after : after.slice(0, sp);
      const args = sp === -1 ? '' : after.slice(sp + 1).trimStart();
      return { cmd, args, body };
    }
  }

  // Single-line format
  if (trimmed.startsWith('/')) {
    const after = trimmed.slice(1);
    const sp = after.search(/\s/);
    const cmd = sp === -1 ? after : after.slice(0, sp);
    const args = sp === -1 ? '' : after.slice(sp + 1).trimStart();
    return { cmd, args };
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

  // Hub topics: empty input shows the hub's aggregate view. Other commands
  // (/open, /info, /help, ...) still dispatch normally so the user can leave
  // the hub. Hubs render installed packages + active sessions of their kind,
  // plus a short management cheat-sheet.
  if (topicType === 'hub' && !input.trim()) {
    const hubName = session.name;
    return ok(await renderHub(hubName, loader));
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
  // parseCommand splits a command into a first-line header and a multiline body
  // (designed for /write etc.). For actions/tools, a quoted value can legitimately
  // span newlines (e.g. /act.post -c "line1\nline2"), so re-attach the body to the
  // args. parsePosixFlags keeps newlines inside quotes, so multiline values survive.
  const actionArgs = parsed.body !== undefined
    ? `${parsed.args}\n${parsed.body}`
    : parsed.args;

  if (topicType === 'hub') {
    if (session.name === 'agent' && ['help', 'list', 'add', 'use', 'current', 'set-home', 'rm', 'remove'].includes(cmd)) {
      return cmdAgentHub(`${cmd} ${actionArgs}`.trim(), loader);
    }
    if (session.name === 'system' && ['help', 'status', 'stop', 'restart'].includes(cmd)) {
      return cmdSystemHub(`${cmd} ${actionArgs}`.trim(), loader);
    }
    if (session.name === 'event' && cmd === 'help') {
      return cmdEventWebhook('help', loader);
    }
    if (session.name === 'event' && ['list', 'read', 'ack', 'clear'].includes(cmd)) {
      const eventArgs = cmd === 'list'
        ? `list ${actionArgs}`.trim()
        : `${cmd} ${actionArgs}`.trim();
      return cmdEvents(eventArgs, loader);
    }
    if (session.name === 'event' && cmd === 'webhook') {
      return cmdEventWebhook(actionArgs, loader);
    }
  }

  switch (cmd) {
    case 'help':    return cmdHelp(session);
    case 'open':    return cmdOpen(parsed.args, session, loader);
    case 'nav':     return cmdNav(parsed.args, session, loader);
    case 'act':     return cmdAction(actionArgs, session, loader);
    case 'back':    return cmdBack(session, loader);
    case 'close':   return cmdClose(session);
    case 'refresh': return cmdRefresh(session, loader);
    case 'info':    return cmdInfo(parsed.args, session, loader);
    case 'source':  return cmdSource(session);
    case 'ls':      return cmdLs(parsed.args, session, loader, topicType);
    case 'write':   return cmdWrite(parsed.args, parsed.body, session, loader);
    case 'append':  return cmdAppend(parsed.args, parsed.body, session, loader);
    case 'replace': return cmdReplace(parsed.args, parsed.body, session, loader);
    case 'edit':    return cmdEdit(parsed.args, parsed.body, session, loader);
    case 'verify':  return cmdVerify(parsed.args, session, loader);
    case 'undo':    return cmdUndo(session, loader);
    case 'set':     return cmdSet(parsed.args, parsed.body, session, loader);
    case 'exec':    return cmdExec(parsed.args, session, loader);
    case 'install':   return cmdInstall(parsed.args, session, loader);
    case 'uninstall': return cmdUninstall(parsed.args, session, loader);
    case 'events':  return cmdEvents(actionArgs, loader);
    case 'read':
    case 'ack':
    case 'clear':
      if (session.name === 'event') return cmdEvents(`${cmd} ${actionArgs}`.trim(), loader);
      return err(`Unknown command: /${parsed.cmd}\nUse /info to see available commands.`, 'COMMAND_UNSUPPORTED');
    default: {
      // Dot-notation routing: /act.search_city --name "Seoul" → cmdAction("search_city --name Seoul")
      const dotMatch = cmd.match(/^act\.([a-zA-Z0-9_-]+)$/);
      if (dotMatch) {
        const actionId = dotMatch[1];
        const dotArgs = actionArgs ? `${actionId} ${actionArgs}` : actionId;
        return cmdAction(dotArgs, session, loader);
      }
      // Tool routing: /tool:name or /tool:name.act
      const toolMatch = cmd.match(/^tool:([a-zA-Z0-9_-]+)(?:\.([a-zA-Z0-9_-]+))?$/);
      if (toolMatch) {
        const toolName = toolMatch[1];
        const subAction = toolMatch[2];
        return cmdTool(toolName, subAction, actionArgs, session, loader);
      }
      const eventsMatch = cmd.match(/^events\.(read|ack|clear)$/);
      if (eventsMatch) {
        return cmdEvents(`${eventsMatch[1]} ${actionArgs}`.trim(), loader);
      }
      return err(`Unknown command: /${parsed.cmd}\nUse /info to see available commands.`, 'COMMAND_UNSUPPORTED');
    }
  }
}
