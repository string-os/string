/**
 * Shell commands: /exec (stateless), bash topic dispatch
 */

import { spawn } from 'child_process';
import path from 'path';
import type { Loader } from '../loader.js';
import type { Session } from '../session.js';
import type { CommandResult, StringErrorCode } from '../types.js';
import { ok, err } from './helpers.js';
import { cmdHelp, cmdBashInfo } from './info.js';

const EXEC_TIMEOUT_MS = 30_000;

// ─── /exec ─────────────────────────────────────────────────────────────────

export async function cmdExec(args: string, session: Session, loader: Loader): Promise<CommandResult> {
  if (!args?.trim()) return err('Usage: /exec <command>', 'COMMAND_UNSUPPORTED');

  const command = args.trim();
  const cwd = deriveCwd(session, loader);

  // session {var} → env vars (skip _config vars)
  const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: loader.home };
  for (const [name, value] of session.getAllVars()) {
    if (!name.startsWith('_')) {
      env[name] = value;
    }
  }

  const result = await execOneShot(command, cwd, env);
  const meta = `exit: ${result.exitCode} | cwd: ${cwd}`;
  const output = result.output || '(no output)';
  return {
    ok: result.exitCode === 0,
    code: result.exitCode === 0 ? undefined : `EXIT_${result.exitCode}` as StringErrorCode,
    content: `${meta}\n---\n${output}`,
  };
}

export function deriveCwd(session: Session, loader: Loader): string {
  if (session.cwdOverride) return session.cwdOverride;
  const uri = session.currentUri;
  if (uri?.startsWith('file://')) {
    return path.dirname(new URL(uri).pathname);
  }
  return loader.home;
}

export function execOneShot(command: string, cwd: string, env: Record<string, string>): Promise<{
  exitCode: number;
  output: string;
}> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', command], {
      cwd, env,
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d; });
    child.stderr.on('data', (d: Buffer) => { output += d; });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, output: output.trimEnd() });
    });
    child.on('error', (e) => {
      resolve({ exitCode: 1, output: e.message });
    });
  });
}

// ─── Bash dispatch ───────────────────────────────────────────────────────────

interface ParsedCommand {
  cmd: string;
  args: string;
  body?: string;
}

/**
 * Bash topic dispatch.
 * - `//command` → String meta-command (strip one `/`, dispatch normally)
 * - Everything else → shell stdin
 */
export async function dispatchBash(
  input: string,
  parsed: ParsedCommand,
  session: Session,
  loader: Loader,
): Promise<CommandResult> {
  const trimmed = input.trim();

  // // prefix → String meta-command
  if (trimmed.startsWith('//')) {
    const metaInput = trimmed.slice(1); // strip one /, keep the other
    const metaParsed = parseCommandForBash(metaInput);
    if (!metaParsed.cmd) {
      return err('Invalid meta-command. Use //help for details.', 'COMMAND_UNSUPPORTED');
    }
    const cmd = metaParsed.cmd.toLowerCase();
    switch (cmd) {
      case 'help':    return cmdHelp(session, 'bash');
      case 'info':    return cmdBashInfo(session, loader);
      case 'close':
        session.close();
        return ok('Bash session closed.');
      default:
        return err(
          `Unknown bash meta-command: //${metaParsed.cmd}\nUse //help for available commands.`,
          'COMMAND_UNSUPPORTED'
        );
    }
  }

  // Everything else → execute in persistent PTY shell
  if (!trimmed) {
    return err('Empty input.', 'COMMAND_UNSUPPORTED');
  }

  try {
    const bash = await session.getOrCreateBash(loader.home);
    const result = await bash.exec(trimmed);

    // Format: meta line + --- + output
    const meta = `exit: ${result.exitCode} | cwd: ${result.cwd}`;
    const output = result.output || '(no output)';
    const content = `${meta}\n---\n${output}`;

    return {
      ok: result.ok,
      code: result.ok ? undefined : `EXIT_${result.exitCode}`,
      content,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Bash error: ${msg}`, 'INTERNAL_ERROR');
  }
}

/** Minimal parseCommand for bash meta-commands */
function parseCommandForBash(input: string): ParsedCommand {
  const trimmed = input.trim();
  if (trimmed.startsWith('/')) {
    const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
    return { cmd, args: rest.join(' ') };
  }
  return { cmd: '', args: trimmed };
}
