import os from 'os';
import path from 'path';
import * as client from '@string-os/client';
import type { Loader } from '../loader.js';
import type { CommandResult } from '../types.js';
import {
  clearCurrentAgent,
  configPath,
  getCurrentAgent,
  globalConfigPath,
  projectConfigPathForWrite,
  setCurrentAgentInFile,
  setCurrentAgent,
} from '../config.js';
import { err, ok, parsePosixFlags } from './helpers.js';

function port(): number {
  return Number(process.env.STRING_PORT) || 3923;
}

function deriveHome(agentId: string): string {
  return path.join(os.homedir(), '.string', 'agents', agentId);
}

function splitAllow(val?: string): string[] {
  if (!val) return [];
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

function currentAgentId(loader: Loader): string {
  return loader.agentId || getCurrentAgent() || 'default';
}

export async function cmdAgentHub(args: string, loader: Loader): Promise<CommandResult> {
  const parsed = parsePosixFlags(args);
  if (parsed === null) return ok(agentHelp('slash'));
  const [sub, ...rest] = parsed.rest;

  switch (sub) {
    case 'help':
    case '--help':
      return ok(agentHelp('slash'));
    case undefined:
    case 'list':
      return listAgents();
    case 'add':
      return addAgent(rest, parsed.flags);
    case 'use':
      return useAgent(rest, parsed.flags);
    case 'current':
      return currentAgent();
    case 'set-home':
      return setAgentHome(rest);
    case 'rm':
    case 'remove':
      return removeAgent(rest);
    default:
      return err(`Unknown agent command: /${sub}\n\n${agentHelp('slash')}`, 'COMMAND_UNSUPPORTED');
  }
}

/**
 * /capability mint|list|revoke — shell surface for capability issuance.
 * Sugar over the daemon's /capabilities routes (one code path with pairing).
 */
export async function cmdAgentCapability(args: string, loader: Loader): Promise<CommandResult> {
  const parsed = parsePosixFlags(args);
  if (parsed === null) return ok(agentHelp('slash'));
  const [sub, ...rest] = parsed.rest;

  switch (sub) {
    case 'mint':
      return mintCapability(parsed.flags, loader);
    case undefined:
    case 'list':
      return listCapabilities(parsed.flags, loader);
    case 'revoke':
      return revokeCapability(rest);
    default:
      return err(`Unknown capability command: ${sub}\n\n${agentHelp('slash')}`, 'COMMAND_UNSUPPORTED');
  }
}

/** '1h' | '30m' | '90s' | '2d' | plain ms → milliseconds. */
function parseTtl(raw: string | undefined): number | null {
  if (!raw) return 60 * 60 * 1000; // default 1h
  const m = raw.trim().match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * factor;
}

async function mintCapability(flags: Record<string, string>, loader: Loader): Promise<CommandResult> {
  const usage = 'Usage: /capability mint --path <prefix> --verbs <put,get,delete,stat> [--ttl 1h] [--single-use] [--agent <id>]';
  if (flags.path === undefined) return err(usage, 'INVALID_PAYLOAD');
  const verbs = splitAllow(flags.verbs).map(v => v.toUpperCase()) as client.CapabilityVerb[];
  if (verbs.length === 0) return err(usage, 'INVALID_PAYLOAD');
  const ttlMs = parseTtl(flags.ttl);
  if (ttlMs === null) return err(`Invalid --ttl: ${flags.ttl} (use e.g. 90s, 30m, 1h, 2d)`, 'INVALID_PAYLOAD');
  const agentId = flags.agent || currentAgentId(loader);

  const minted = await client.mintCapability(port(), {
    agentId,
    pathPrefix: flags.path,
    verbs,
    ttlMs,
    singleUse: flags['single-use'] === 'true',
  });
  return ok([
    `Minted capability ${minted.token_id} into workspace '${minted.agent_id}':`,
    `  scope:   ${minted.path_prefix || '(whole workspace)'} [${minted.verbs.join(', ')}]`,
    `  expires: ${minted.expires_at}${minted.single_use ? '   single-use' : ''}`,
    '',
    `  secret: ${minted.secret}`,
    '',
    'The secret is shown ONLY here — hand it to the component, never store it in a repo.',
    `Use: curl -H 'Authorization: Bearer ${minted.secret}' http://127.0.0.1:${port()}/fs/<path>`,
    `Revoke: /capability revoke ${minted.token_id}`,
  ].join('\n'));
}

async function listCapabilities(flags: Record<string, string>, loader: Loader): Promise<CommandResult> {
  const agentFilter = flags.agent || (flags.all === 'true' ? undefined : currentAgentId(loader));
  const records = await client.listCapabilities(port(), agentFilter);
  if (records.length === 0) return ok(`No capabilities${agentFilter ? ` for agent '${agentFilter}'` : ''}.`);
  const now = Date.now();
  const lines = records.map(r => {
    const state = r.revoked_at ? 'revoked' : r.used_at ? 'used' : now > Date.parse(r.expires_at) ? 'expired' : 'live';
    return `  ${r.token_id}\t${r.agent_id}\t${r.path_prefix || '(workspace)'}\t[${r.verbs.join(',')}]\t${state}\texpires ${r.expires_at}`;
  });
  return ok([`Capabilities${agentFilter ? ` for '${agentFilter}'` : ''}:`, ...lines].join('\n'));
}

async function revokeCapability(rest: string[]): Promise<CommandResult> {
  const tokenId = rest[0];
  if (!tokenId) return err('Usage: /capability revoke <token_id>', 'INVALID_PAYLOAD');
  const revoked = await client.revokeCapability(port(), tokenId);
  return ok(revoked ? `Revoked ${tokenId}.` : `${tokenId} was not a live capability (unknown or already dead).`);
}

async function addAgent(rest: string[], flags: Record<string, string>): Promise<CommandResult> {
  const id = rest[0];
  if (!id) return err('Usage: /add <id> [--home <path>] [--allow <p1,p2,...>]', 'INVALID_PAYLOAD');
  const home = flags.home || deriveHome(id);
  const allow = splitAllow(flags.allow);
  await client.ensureAgent(port(), { id, home, allowedPaths: allow });
  return ok([
    `Added agent '${id}' (home: ${home})`,
    ...(allow.length ? [`allowedPaths: ${allow.join(', ')}`] : []),
    `next: string agent use ${id}`,
  ].join('\n'));
}

async function useAgent(rest: string[], flags: Record<string, string>): Promise<CommandResult> {
  const id = rest[0];
  if (!id) return err('Usage: /use <id> [--local]', 'INVALID_PAYLOAD');
  const agents = await client.listAgents(port());
  const exists = agents.some(a => a.id === id);
  const local = flags.local === 'true';
  const file = local ? projectConfigPathForWrite(flags['project-dir']) : globalConfigPath();
  if (local) setCurrentAgentInFile(id, file);
  else setCurrentAgent(id, 'global');
  const configOverride = flags['config-override'] || process.env.STRING_CONFIG;
  return ok([
    `Current agent set to '${id}' (${local ? 'local' : 'global'}: ${file}).`,
    ...(local && configOverride
      ? [`Warning: STRING_CONFIG is set (${configOverride}), so future calls in this environment will read that config before this local file.`]
      : []),
    ...(!exists ? [`Note: agent '${id}' is not registered yet — run \`string agent add ${id}\` to set its home.`] : []),
  ].join('\n'));
}

async function currentAgent(): Promise<CommandResult> {
  const current = getCurrentAgent() ?? 'default';
  const agent = (await client.listAgents(port())).find(a => a.id === current);
  const home = agent ? agent.home : '(not registered)';
  return ok(`${current}\t${home}\tconfig: ${configPath()}`);
}

async function listAgents(): Promise<CommandResult> {
  const current = getCurrentAgent();
  const agents = await client.listAgents(port());
  if (agents.length === 0) return ok('No agents registered.');
  const lines = agents.map(a => {
    const marker = a.id === current ? '* ' : '  ';
    return `${marker}${a.id}\t${a.home}`;
  });
  return ok(lines.join('\n'));
}

async function setAgentHome(rest: string[]): Promise<CommandResult> {
  const [id, home] = rest;
  if (!id || !home) return err('Usage: /set-home <id> <path>', 'INVALID_PAYLOAD');
  await client.ensureAgent(port(), { id, home });
  return ok(`Set home for '${id}' -> ${home}`);
}

async function removeAgent(rest: string[]): Promise<CommandResult> {
  const id = rest[0];
  if (!id) return err('Usage: /rm <id>', 'INVALID_PAYLOAD');
  const deleted = await client.deleteAgent(port(), id);
  if (getCurrentAgent() === id) clearCurrentAgent();
  return ok(deleted ? `Removed agent '${id}'.` : `Agent '${id}' did not exist.`);
}

export async function cmdEventWebhook(args: string, loader: Loader): Promise<CommandResult> {
  const parsed = parsePosixFlags(args);
  if (parsed === null) return ok(eventHelp('slash'));
  const sub = parsed.rest[0] || 'show';
  const agentId = currentAgentId(loader);

  switch (sub) {
    case 'help':
    case '--help':
      return ok(eventHelp('slash'));
    case 'show':
    case 'create': {
      const info = await client.getAgentWebhook(port(), agentId);
      return ok(formatWebhook(agentId, info.webhook_url));
    }
    case 'rotate': {
      const info = await client.rotateAgentWebhook(port(), agentId);
      return ok(`Rotated local webhook for agent '${agentId}':\n${info.webhook_url}`);
    }
    default:
      return err(`Unknown webhook command: ${sub}\n\n${eventHelp('slash')}`, 'COMMAND_UNSUPPORTED');
  }
}

export async function cmdSystemHub(args: string, loader: Loader): Promise<CommandResult> {
  const parsed = parsePosixFlags(args);
  if (parsed === null) return ok(systemHelp('slash'));
  const sub = parsed.rest[0] || 'status';
  const p = port();

  switch (sub) {
    case 'help':
    case '--help':
      return ok(systemHelp('slash'));
    case 'status': {
      const info = await client.health(p);
      return ok(`stringd running on port ${p} — ${info.agents} agent(s), ${info.sessions} session(s)`);
    }
    case 'stop':
      setTimeout(() => { void client.shutdown(p).catch(() => {}); }, 10);
      return ok('stringd stopping');
    case 'restart':
      return err('Use `string --daemon stop` then run any string command to auto-start. In-process /restart is not available in v0.1.', 'COMMAND_UNSUPPORTED');
    default:
      return err(`Unknown system command: /${sub}\n\n${systemHelp('slash')}`, 'COMMAND_UNSUPPORTED');
  }
}

export async function renderEventWebhook(loader: Loader): Promise<string> {
  try {
    const agentId = currentAgentId(loader);
    const info = await client.getAgentWebhook(port(), agentId);
    return formatWebhook(agentId, info.webhook_url);
  } catch (e) {
    return `Webhook: unavailable (${(e as Error).message})`;
  }
}

function formatWebhook(agentId: string, url: string): string {
  return [
    `Local webhook for agent '${agentId}':`,
    url,
    '',
    'Send text with:',
    `  curl -X POST --data-binary @message.txt ${url}`,
  ].join('\n');
}

export function agentHelp(style: 'cli' | 'slash' = 'slash'): string {
  if (style === 'cli') {
    return [
      'Usage: string agent <command> [args]',
      '',
      'Commands:',
      '  string agent list                                      List agents',
      '  string agent current                                   Show current agent',
      '  string agent add <id> [--home <path>] [--allow <paths>] Register an agent',
      '  string agent use <id> [--local]                        Set current agent',
      '  string agent set-home <id> <path>                      Change agent home',
      '  string agent rm <id>                                   Remove an agent',
      '',
      '  string agent capability mint --path <prefix> --verbs <v1,v2> [--ttl 1h]',
      '                          [--single-use] [--agent <id>]   Mint a scoped fs capability',
      '  string agent capability list [--agent <id>]             List capabilities (no secrets)',
      '  string agent capability revoke <token_id>               Revoke a capability',
      '',
      "Slash/MCP form: string agent '/list'",
    ].join('\n');
  }
  return [
    'Agent hub commands:',
    '  /list                                            List agents',
    '  /current                                         Show current agent',
    '  /add <id> [--home <path>] [--allow <paths>]       Register an agent',
    '  /use <id> [--local]                              Set current agent',
    '  /set-home <id> <path>                            Change agent home',
    '  /rm <id>                                         Remove an agent',
    '  /capability mint --path <prefix> --verbs <v1,v2> [--ttl 1h] [--single-use] [--agent <id>]',
    '  /capability list [--agent <id>]                  List capabilities (no secrets)',
    '  /capability revoke <token_id>                    Revoke a capability',
  ].join('\n');
}

export function eventHelp(style: 'cli' | 'slash' = 'slash'): string {
  if (style === 'cli') {
    return [
      'Usage: string event <command> [args]',
      '',
      'Commands:',
      '  string event webhook show                Show current agent webhook URL',
      '  string event webhook rotate              Rotate current agent webhook token',
      '  string event list                        List pending events',
      '  string event list --all                  List pending and acked events',
      '  string event read <id>                   Read one event',
      '  string event ack <id>                    Acknowledge one event',
      '  string event clear [--all]               Clear acked or all events',
      '',
      "Slash/MCP form: string event '/webhook show'",
    ].join('\n');
  }
  return [
    'Event hub commands:',
    '  /events                          List pending events',
    '  /events.read <id>                Read one event',
    '  /events.ack <id>                 Acknowledge one event',
    '  /webhook show                    Show current agent webhook URL',
    '  /webhook rotate                  Rotate current agent webhook token',
  ].join('\n');
}

export function systemHelp(style: 'cli' | 'slash' = 'slash'): string {
  if (style === 'cli') {
    return [
      'Usage: string system <command>',
      '',
      'Commands:',
      '  string system status             Daemon health + port',
      '  string system stop               Stop the daemon',
      '',
      "Slash/MCP form: string system '/status'",
    ].join('\n');
  }
  return [
    'System hub commands:',
    '  /status                          Daemon health + port',
    '  /stop                            Stop the daemon',
  ].join('\n');
}
