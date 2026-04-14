import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface User {
  id: string;
  home: string;
  allowedPaths: string[];
  createdAt: string;
}

export class UserRegistry {
  private readonly users = new Map<string, User>();
  private readonly persistPath: string | null;

  constructor(initialUsers: User[] = [], persistPath?: string) {
    this.persistPath = persistPath ?? null;

    // Load from file first, then overlay any initial users
    if (this.persistPath) {
      try {
        const data = JSON.parse(readFileSync(this.persistPath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const u of data) this.users.set(u.id, u);
        }
      } catch { /* file doesn't exist yet — that's fine */ }
    }

    for (const user of initialUsers) {
      this.register(user);
    }
  }

  register(user: User): User {
    const id = user.id.trim();
    if (!id) throw new Error('user.id required');

    const normalized: User = {
      ...user,
      id,
      allowedPaths: [...user.allowedPaths],
    };

    this.users.set(id, normalized);
    this._save();
    return normalized;
  }

  get(id: string): User | undefined {
    return this.users.get(id);
  }

  has(id: string): boolean {
    return this.users.has(id);
  }

  list(): User[] {
    return [...this.users.values()];
  }

  delete(id: string): boolean {
    const ok = this.users.delete(id);
    if (ok) this._save();
    return ok;
  }

  canAccessPath(userId: string, targetPath: string): boolean {
    const user = this.get(userId);
    if (!user) return false;
    return [user.home, ...user.allowedPaths].includes(targetPath);
  }

  private _save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(this.list(), null, 2) + '\n');
    } catch (e) {
      console.error(`[UserRegistry] Failed to save: ${e}`);
    }
  }
}

export function createUserRegistry(users: User[] = [], persistPath?: string): UserRegistry {
  return new UserRegistry(users, persistPath);
}
