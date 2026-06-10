import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

export type AgentEventStatus = 'pending' | 'ack';

export interface AgentEvent {
  id: string;
  agentId: string;
  receivedAt: string;
  source: 'local-webhook';
  text: string;
  status: AgentEventStatus;
  ackedAt?: string;
}

export interface EventSummary {
  id: string;
  receivedAt: string;
  source: string;
  status: AgentEventStatus;
  preview: string;
}

const EVENT_ID_PREFIX = 'evt_';
const EVENT_DIR = 'events';

export function createWebhookToken(): string {
  return `wh_${randomBytes(24).toString('base64url')}`;
}

export class EventStore {
  private readonly dir: string;

  constructor(private readonly home: string) {
    this.dir = path.join(home, EVENT_DIR);
  }

  async append(agentId: string, text: string, source: AgentEvent['source'] = 'local-webhook'): Promise<AgentEvent> {
    const trimmed = text.trimEnd();
    const event: AgentEvent = {
      id: `${EVENT_ID_PREFIX}${Date.now().toString(36)}_${randomBytes(5).toString('base64url')}`,
      agentId,
      receivedAt: new Date().toISOString(),
      source,
      text: trimmed,
      status: 'pending',
    };
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.eventPath(event.id), JSON.stringify(event, null, 2) + '\n', { mode: 0o600 });
    return event;
  }

  async list(opts: { includeAck?: boolean; limit?: number } = {}): Promise<EventSummary[]> {
    const events = await this.readAll();
    const filtered = opts.includeAck ? events : events.filter(e => e.status === 'pending');
    const limit = opts.limit ?? 50;
    return filtered
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, limit)
      .map(e => ({
        id: e.id,
        receivedAt: e.receivedAt,
        source: e.source,
        status: e.status,
        preview: previewText(e.text),
      }));
  }

  async read(id: string): Promise<AgentEvent | null> {
    if (!validEventId(id)) return null;
    try {
      const raw = await fs.readFile(this.eventPath(id), 'utf-8');
      return JSON.parse(raw) as AgentEvent;
    } catch {
      return null;
    }
  }

  async ack(id: string): Promise<AgentEvent | null> {
    const event = await this.read(id);
    if (!event) return null;
    if (event.status !== 'ack') {
      event.status = 'ack';
      event.ackedAt = new Date().toISOString();
      await fs.writeFile(this.eventPath(id), JSON.stringify(event, null, 2) + '\n', { mode: 0o600 });
    }
    return event;
  }

  async clear(opts: { all?: boolean } = {}): Promise<number> {
    const events = await this.readAll();
    let count = 0;
    for (const event of events) {
      if (!opts.all && event.status !== 'ack') continue;
      await fs.rm(this.eventPath(event.id), { force: true });
      count++;
    }
    return count;
  }

  private eventPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private async readAll(): Promise<AgentEvent[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const events: AgentEvent[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const event = await this.read(id);
      if (event) events.push(event);
    }
    return events;
  }
}

function validEventId(id: string): boolean {
  return /^evt_[a-z0-9]+_[a-zA-Z0-9_-]+$/.test(id);
}

function previewText(text: string): string {
  const line = text.split('\n').find(l => l.trim()) ?? '';
  const compact = line.trim().replace(/\s+/g, ' ');
  return compact.length > 80 ? compact.slice(0, 77) + '...' : compact;
}
