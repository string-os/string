import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface Agent {
  id: string;
  home: string;
  allowedPaths: string[];
  createdAt: string;
  webhookToken?: string;
}

export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();
  private readonly persistPath: string | null;

  // Boot diagnostics, set once at construction and never mutated: whether the
  // persisted store was read as an array, how many agents it held, and how many
  // of those carried a webhook token. The daemon logs these at startup so a
  // restart that boots an EMPTY registry — e.g. the data dir was not preserved
  // across an upgrade, which silently re-mints every token on first webhook use
  // and 401s every stale caller — is visible immediately instead of surfacing
  // hours or days later as unexplained 401s.
  readonly loadedFromStore: boolean;
  readonly loadedCount: number;
  readonly loadedWithWebhookToken: number;

  constructor(initialAgents: Agent[] = [], persistPath?: string) {
    this.persistPath = persistPath ?? null;

    // Load from file first, then overlay any initial agents.
    let loadedFromStore = false;
    if (this.persistPath) {
      try {
        const data = JSON.parse(readFileSync(this.persistPath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const agent of data) this.agents.set(agent.id, agent);
          loadedFromStore = true;
        }
      } catch { /* file doesn't exist yet — that's fine */ }
    }
    // Snapshot the store-load outcome BEFORE overlaying initialAgents, so it
    // reflects what persistence actually yielded.
    this.loadedFromStore = loadedFromStore;
    this.loadedCount = this.agents.size;
    this.loadedWithWebhookToken = [...this.agents.values()].filter(a => !!a.webhookToken).length;

    for (const agent of initialAgents) {
      this.register(agent);
    }
  }

  /** Absolute path of the JSON store backing this registry, or null if in-memory only. */
  get storePath(): string | null {
    return this.persistPath;
  }

  register(agent: Agent): Agent {
    const id = agent.id.trim();
    if (!id) throw new Error('agent.id required');

    const normalized: Agent = {
      ...agent,
      id,
      allowedPaths: [...agent.allowedPaths],
      webhookToken: agent.webhookToken,
    };

    this.agents.set(id, normalized);
    this._save();
    return normalized;
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  list(): Agent[] {
    return [...this.agents.values()];
  }

  delete(id: string): boolean {
    const ok = this.agents.delete(id);
    if (ok) this._save();
    return ok;
  }

  canAccessPath(agentId: string, targetPath: string): boolean {
    const agent = this.get(agentId);
    if (!agent) return false;
    return [agent.home, ...agent.allowedPaths].includes(targetPath);
  }

  private _save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true, mode: 0o700 });
      writeFileSync(this.persistPath, JSON.stringify(this.list(), null, 2) + '\n', { mode: 0o600 });
    } catch (e) {
      console.error(`[AgentRegistry] Failed to save: ${e}`);
    }
  }
}

export function createAgentRegistry(agents: Agent[] = [], persistPath?: string): AgentRegistry {
  return new AgentRegistry(agents, persistPath);
}
