import type { Loader } from '../loader.js';
import type { CommandResult } from '../types.js';
import { EventStore } from '../events.js';
import { err, ok } from './helpers.js';

export async function cmdEvents(args: string, loader: Loader): Promise<CommandResult> {
  const trimmed = args.trim();
  if (!trimmed || trimmed === 'list') return renderEvents(loader);
  if (trimmed === '--help' || trimmed === '-h') return ok(EVENTS_HELP);

  const [sub, ...rest] = splitArgs(trimmed);
  switch (sub) {
    case 'list':
      return renderEvents(loader, { includeAck: rest.includes('--all') });
    case 'read':
      return readEvent(loader, rest[0]);
    case 'ack':
      return ackEvent(loader, rest[0]);
    case 'clear':
      return clearEvents(loader, { all: rest.includes('--all') });
    default:
      return err(`Unknown events command: ${sub}\n\n${EVENTS_HELP}`, 'COMMAND_UNSUPPORTED');
  }
}

export async function renderEvents(loader: Loader, opts: { includeAck?: boolean } = {}): Promise<CommandResult> {
  const store = new EventStore(loader.home);
  const events = await store.list({ includeAck: opts.includeAck, limit: 50 });
  const title = opts.includeAck ? 'Recent events' : 'Unacked events';
  const parts: string[] = [
    '# event inbox',
    '',
    'Agent-local text events delivered by String webhooks and other local sources.',
    '',
    `## ${title} (${events.length})`,
  ];

  if (events.length === 0) {
    parts.push('', '  (no events)');
  } else {
    // Naming the order matters: this list is newest-first, so reading it
    // top-to-bottom applies a later message (e.g. a retraction) BEFORE the
    // earlier one it refers to — the ordering hazard behind the replay
    // incidents. A naive reader can't compensate for an order it can't see.
    // (The event STREAM already replays oldest-first; this is the human list.)
    parts.push(
      '',
      'Order: newest-first — a later message (e.g. a retraction) can sit above the earlier one it refers to. Apply oldest→newest, or drain via the event stream, which replays oldest-first.',
      '',
    );
    const width = Math.max(...events.map(e => e.id.length));
    for (const event of events) {
      const status = event.status === 'ack' ? 'ack' : 'pending';
      parts.push(`  ${event.id.padEnd(width)}  ${status}  ${event.receivedAt}  ${event.preview}`);
    }
  }

  parts.push(
    '',
    '## Commands',
    '',
    'CLI:',
    '  string event list                 — list pending events',
    '  string event list --all           — list pending and acked events',
    '  string event read <id>            — read full event text',
    '  string event ack <id>             — mark an event handled',
    '  string event clear                — delete acked events',
    '  string event clear --all          — delete all events',
    '',
    'MCP/slash:',
    '  /events                         — list pending events',
    '  /events list --all              — list pending and acked events',
    '  /events.read <id>               — read full event text',
    '  /events.ack <id>                — mark an event handled',
    '  /events.clear                   — delete acked events',
    '  /events.clear --all             — delete all events',
  );
  return ok(parts.join('\n'));
}

async function readEvent(loader: Loader, id?: string): Promise<CommandResult> {
  if (!id) return err('Usage: /events.read <id>', 'INVALID_PAYLOAD');
  const event = await new EventStore(loader.home).read(id);
  if (!event) return err(`Event not found: ${id}`, 'NOT_FOUND');
  return ok([
    `Event ${event.id}`,
    '---',
    `receivedAt: ${event.receivedAt}`,
    `source: ${event.source}`,
    `status: ${event.status}`,
    '',
    event.text,
    '',
    `next: string event ack ${event.id}`,
    `MCP/slash: /events.ack ${event.id}`,
  ].join('\n'));
}

async function ackEvent(loader: Loader, id?: string): Promise<CommandResult> {
  if (!id) return err('Usage: /events.ack <id>', 'INVALID_PAYLOAD');
  const event = await new EventStore(loader.home).ack(id);
  if (!event) return err(`Event not found: ${id}`, 'NOT_FOUND');
  return ok(`Acked ${event.id}`);
}

async function clearEvents(loader: Loader, opts: { all?: boolean }): Promise<CommandResult> {
  const count = await new EventStore(loader.home).clear(opts);
  return ok(`Cleared ${count} event${count === 1 ? '' : 's'}`);
}

const EVENTS_HELP = [
  'CLI:',
  '  string event list                 — list pending events',
  '  string event list --all           — list pending and acked events',
  '  string event read <id>            — read full event text',
  '  string event ack <id>             — mark an event handled',
  '  string event clear                — delete acked events',
  '  string event clear --all          — delete all events',
  '',
  'MCP/slash:',
  '/events                         — list pending events',
  '/events list --all              — list pending and acked events',
  '/events.read <id>               — read full event text',
  '/events.ack <id>                — mark an event handled',
  '/events.clear                   — delete acked events',
  '/events.clear --all             — delete all events',
].join('\n');

function splitArgs(input: string): string[] {
  return input.split(/\s+/).filter(Boolean);
}
