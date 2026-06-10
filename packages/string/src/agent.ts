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

  constructor(initialAgents: Agent[] = [], persistPath?: string) {
    this.persistPath = persistPath ?? null;

    // Load from file first, then overlay any initial agents.
    if (this.persistPath) {
      try {
        const data = JSON.parse(readFileSync(this.persistPath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const agent of data) this.agents.set(agent.id, agent);
        }
      } catch { /* file doesn't exist yet — that's fine */ }
    }

    for (const agent of initialAgents) {
      this.register(agent);
    }
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
