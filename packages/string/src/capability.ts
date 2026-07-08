/**
 * String System API — capability tokens (#47 items 2–3).
 *
 * One verifier for both scoped bearer tokens and presigned URLs: a presigned
 * URL carries the same opaque secret in `?cap=`, and single-use is the
 * degenerate form (consumed by its first successful verify). Tokens are
 * opaque and stored daemon-side — revocation is a state change, no signing
 * secret to rotate.
 *
 * A capability is identity + scope in one value: agent workspace root,
 * path subtree, verb set, expiry. The system plane is data-only by
 * construction — the verb universe is PUT/GET/DELETE/STAT and nothing else.
 */
import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import path from 'path';

export const FS_VERBS = ['PUT', 'GET', 'DELETE', 'STAT'] as const;
export type FsVerb = (typeof FS_VERBS)[number];

export interface CapabilityRecord {
  /** Public id (`cap_...`) — safe to log/list; used for revocation. */
  tokenId: string;
  /** Bearer value (`caps_...`) presented by callers. Never logged. */
  secret: string;
  /** Workspace owner: fs paths resolve inside this agent's workspace. */
  agentId: string;
  /** Normalized workspace-relative subtree; '' grants the whole workspace. */
  pathPrefix: string;
  verbs: FsVerb[];
  /** ISO timestamp; the token is dead strictly after this instant. */
  expiresAt: string;
  /** Presigned/degenerate form: first successful verify consumes the token. */
  singleUse: boolean;
  createdAt: string;
  usedAt?: string;
  revokedAt?: string;
}

export type VerifyFailure =
  | 'unknown_token'
  | 'revoked'
  | 'expired'
  | 'already_used'
  | 'verb_not_allowed'
  | 'invalid_path'
  | 'path_outside_scope';

export type VerifyResult =
  | { ok: true; record: CapabilityRecord; path: string }
  | { ok: false; reason: VerifyFailure };

/**
 * Canonicalize a workspace-relative fs path. Returns null when the path can
 * never be legal: escapes the workspace (`..`), is absolute after stripping
 * the URL's leading slash, or smuggles separators/nulls. '' addresses the
 * workspace root (only meaningful for STAT of a prefix — callers decide).
 *
 * This is the lexical half of containment; the fs layer must still resolve
 * symlinks (realpath) before touching disk.
 */
export function normalizeFsPath(raw: string): string | null {
  if (raw.includes('\0') || raw.includes('\\')) return null;
  const stripped = raw.replace(/^\/+/, '');
  const norm = path.posix.normalize(stripped);
  if (norm === '.' || norm === '') return '';
  if (norm === '..' || norm.startsWith('../')) return null;
  if (norm.startsWith('/')) return null;
  return norm;
}

/** Subtree containment on normalized paths — segment-wise, so 'a/bc' ⊄ 'a/b'. */
export function pathWithinPrefix(target: string, prefix: string): boolean {
  if (prefix === '') return true;
  return target === prefix || target.startsWith(`${prefix}/`);
}

export interface MintSpec {
  agentId: string;
  /** Subtree to grant, workspace-relative. '' or '/' grants the workspace. */
  pathPrefix: string;
  verbs: FsVerb[];
  /** Lifetime in milliseconds from now. */
  ttlMs: number;
  singleUse?: boolean;
}

export class CapabilityStore {
  /** Keyed by secret — the value callers present. */
  private readonly bySecret = new Map<string, CapabilityRecord>();
  private readonly persistPath: string | null;
  private readonly now: () => number;

  constructor(opts?: { persistPath?: string; now?: () => number }) {
    this.persistPath = opts?.persistPath ?? null;
    this.now = opts?.now ?? Date.now;

    if (this.persistPath) {
      try {
        const data = JSON.parse(readFileSync(this.persistPath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const rec of data as CapabilityRecord[]) {
            if (rec && typeof rec.secret === 'string') this.bySecret.set(rec.secret, rec);
          }
        }
      } catch { /* file doesn't exist yet — that's fine */ }
    }
  }

  mint(spec: MintSpec): CapabilityRecord {
    const agentId = spec.agentId.trim();
    if (!agentId) throw new Error('capability: agentId required');

    const pathPrefix = normalizeFsPath(spec.pathPrefix);
    if (pathPrefix === null) throw new Error(`capability: invalid pathPrefix: ${spec.pathPrefix}`);

    const verbs = [...new Set(spec.verbs)];
    if (verbs.length === 0) throw new Error('capability: at least one verb required');
    for (const verb of verbs) {
      if (!FS_VERBS.includes(verb)) {
        // Refuse-by-construction: exec/app/tool verbs can never enter the
        // system plane through a capability.
        throw new Error(`capability: verb not on the system plane: ${verb}`);
      }
    }

    if (!Number.isFinite(spec.ttlMs) || spec.ttlMs <= 0) {
      throw new Error('capability: ttlMs must be a positive duration');
    }

    const nowMs = this.now();
    const record: CapabilityRecord = {
      tokenId: `cap_${randomBytes(8).toString('base64url')}`,
      secret: `caps_${randomBytes(24).toString('base64url')}`,
      agentId,
      pathPrefix,
      verbs,
      expiresAt: new Date(nowMs + spec.ttlMs).toISOString(),
      singleUse: spec.singleUse ?? false,
      createdAt: new Date(nowMs).toISOString(),
    };
    this.bySecret.set(record.secret, record);
    this._save();
    return record;
  }

  /**
   * The single verifier (bearer and presigned forms both land here).
   * A successful verify of a single-use token consumes it in the same
   * synchronous step — two racing calls can never both pass.
   */
  verify(secret: string, request: { verb: FsVerb | string; path: string }): VerifyResult {
    const record = this.bySecret.get(secret);
    if (!record) return { ok: false, reason: 'unknown_token' };
    if (record.revokedAt) return { ok: false, reason: 'revoked' };
    if (this.now() > Date.parse(record.expiresAt)) return { ok: false, reason: 'expired' };
    if (record.usedAt) return { ok: false, reason: 'already_used' };

    if (!FS_VERBS.includes(request.verb as FsVerb) || !record.verbs.includes(request.verb as FsVerb)) {
      return { ok: false, reason: 'verb_not_allowed' };
    }

    const target = normalizeFsPath(request.path);
    if (target === null) return { ok: false, reason: 'invalid_path' };
    if (!pathWithinPrefix(target, record.pathPrefix)) {
      return { ok: false, reason: 'path_outside_scope' };
    }

    if (record.singleUse) {
      record.usedAt = new Date(this.now()).toISOString();
      this._save();
    }
    return { ok: true, record, path: target };
  }

  /** Revoke by public token id. Returns whether a live token was revoked. */
  revoke(tokenId: string): boolean {
    for (const record of this.bySecret.values()) {
      if (record.tokenId === tokenId && !record.revokedAt) {
        record.revokedAt = new Date(this.now()).toISOString();
        this._save();
        return true;
      }
    }
    return false;
  }

  /** Revoke every live token scoped to an agent (agent-delete hook). */
  revokeAllForAgent(agentId: string): number {
    let revoked = 0;
    for (const record of this.bySecret.values()) {
      if (record.agentId === agentId && !record.revokedAt) {
        record.revokedAt = new Date(this.now()).toISOString();
        revoked++;
      }
    }
    if (revoked > 0) this._save();
    return revoked;
  }

  /** Public views only — secrets are never listed back out. */
  list(): Array<Omit<CapabilityRecord, 'secret'>> {
    return [...this.bySecret.values()].map(({ secret: _secret, ...rest }) => rest);
  }

  private _save(): void {
    if (!this.persistPath) return;
    // Dead tokens (expired/consumed/revoked) are kept for 7 days for
    // debuggability, then dropped so the store cannot grow without bound.
    const cutoff = this.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [secret, rec] of this.bySecret) {
      const deadAt = rec.revokedAt ?? rec.usedAt ?? rec.expiresAt;
      const deadMs = Date.parse(deadAt);
      const isDead = !!rec.revokedAt || !!rec.usedAt || this.now() > Date.parse(rec.expiresAt);
      if (isDead && Number.isFinite(deadMs) && deadMs < cutoff) this.bySecret.delete(secret);
    }
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true, mode: 0o700 });
      writeFileSync(
        this.persistPath,
        JSON.stringify([...this.bySecret.values()], null, 2) + '\n',
        { mode: 0o600 },
      );
    } catch (e) {
      console.error(`[CapabilityStore] Failed to save: ${e}`);
    }
  }
}
