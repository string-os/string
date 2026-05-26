/**
 * GitHub URL recognizer for `/install`.
 *
 * Lets agents and humans install a String app directly from a GitHub URL —
 * the kind a browser address bar shows — without manually constructing raw
 * URLs or authoring an install manifest. Three URL forms:
 *
 *   /install https://github.com/owner/repo
 *   /install https://github.com/owner/repo/tree/<ref>/<path>
 *   /install https://github.com/owner/repo/blob/<ref>/<path>/string.md
 *   /install gh:owner/repo[/<path>][@<ref>]
 *
 * `tree` and repo-root forms enumerate files via the GitHub Contents API and
 * synthesize an in-memory install manifest pointing at `raw.githubusercontent.com`
 * URLs. `blob` forms collapse to a single raw URL — the existing single-file
 * install path handles them.
 *
 * Anonymous GitHub API quota is 60 req/hr/IP. Set `GITHUB_TOKEN` to raise it to
 * 5000 req/hr (the same env Octokit / gh CLI read).
 */
import type { Loader } from './loader.js';

export interface ParsedGithubUrl {
  /** Where the URL ultimately resolves: a directory (tree) or a single file (blob). */
  kind: 'tree' | 'blob';
  owner: string;
  repo: string;
  /** Branch/tag/sha. `null` means "default branch" (resolved later via API). */
  ref: string | null;
  /** Repo-relative path. `''` for repo root; for `blob` includes the filename. */
  path: string;
}

/**
 * Parse a GitHub URL into its parts, or return `null` if the URL isn't a
 * GitHub form we handle. Pure; no network.
 */
export function parseGithubUrl(input: string): ParsedGithubUrl | null {
  const s = input.trim();

  // gh:owner/repo[/path][@ref] — short form. The `@ref` suffix sticks to the
  // end of either the repo or the path, so split it off first.
  if (s.startsWith('gh:')) {
    let rest = s.slice('gh:'.length);
    let ref: string | null = null;
    const atIdx = rest.lastIndexOf('@');
    if (atIdx > 0 && !rest.slice(atIdx).includes('/')) {
      ref = rest.slice(atIdx + 1) || null;
      rest = rest.slice(0, atIdx);
    }
    const parts = rest.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repo, ...pathParts] = parts;
    return { kind: 'tree', owner, repo, ref, path: pathParts.join('/') };
  }

  // https://github.com/owner/repo[/tree|blob/<ref>[/<path>]]
  let url: URL;
  try { url = new URL(s); } catch { return null; }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;

  const segs = url.pathname.split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const [owner, repo, kind, ref, ...rest] = segs;

  // /owner/repo — repo root, tree-style, ref will be resolved to default_branch.
  if (segs.length === 2) {
    return { kind: 'tree', owner, repo, ref: null, path: '' };
  }

  if (kind !== 'tree' && kind !== 'blob') return null;
  if (!ref) return null;

  return {
    kind: kind as 'tree' | 'blob',
    owner,
    repo,
    ref,
    path: rest.join('/'),
  };
}

/** Resolve a `ref: null` to the repo's default branch (one API call, cached per process). */
const defaultBranchCache = new Map<string, string>();
async function resolveDefaultBranch(owner: string, repo: string): Promise<string> {
  const key = `${owner}/${repo}`;
  const cached = defaultBranchCache.get(key);
  if (cached) return cached;
  const r = await ghFetch(`https://api.github.com/repos/${owner}/${repo}`);
  if (!r.ok) throw new Error(`GitHub: cannot resolve ${owner}/${repo} (HTTP ${r.status})`);
  const data = (await r.json()) as { default_branch?: string };
  const branch = data.default_branch || 'main';
  defaultBranchCache.set(key, branch);
  return branch;
}

/**
 * GitHub fetch with optional auth + a clear UA. The User-Agent header is
 * required by the GitHub REST API; without it requests are rejected.
 */
function ghFetch(url: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': '@string-os/string installer',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { headers });
}

interface ContentsEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  size: number;
}

/** What `synthesizeGithubSource` returns to the installer. Mirrors `Loaded`. */
export interface GithubLoaded {
  /** Stable identity for resolve() / registry — the raw URL of string.md. */
  uri: string;
  /** SFMD source for the root string.md (frontmatter + body). */
  source: string;
  /** In-memory install manifest JSON. Installer reads `files[]` from this. */
  rawSource: string;
}

/**
 * Turn a parsed GitHub URL into a `Loaded` shape the installer can consume.
 * Performs at most three HTTP calls (default branch lookup if needed, dir
 * listing, string.md fetch). Single-file `blob` URLs return early after one
 * fetch and skip manifest synthesis.
 */
export async function synthesizeGithubSource(
  parsed: ParsedGithubUrl,
  _loader: Loader,
): Promise<GithubLoaded | { singleFileRawUrl: string }> {
  const ref = parsed.ref || (await resolveDefaultBranch(parsed.owner, parsed.repo));
  const rawBase = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${ref}`;

  // Single file: hand the raw URL back; installer's existing single-file path
  // already does the right thing with it.
  if (parsed.kind === 'blob') {
    return { singleFileRawUrl: `${rawBase}/${parsed.path}` };
  }

  // Directory: enumerate non-dir entries via the Contents API. Symlinks and
  // submodules are skipped — we'd be installing a reference, not a file.
  const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/${parsed.path}?ref=${encodeURIComponent(ref)}`;
  const listing = await ghFetch(apiUrl);
  if (listing.status === 404) {
    throw new Error(
      `GitHub: path "${parsed.path}" not found in ${parsed.owner}/${parsed.repo}@${ref}.`,
    );
  }
  if (listing.status === 403) {
    throw new Error(
      `GitHub API rate-limited (HTTP 403). Set GITHUB_TOKEN env to raise the limit to 5000 req/hr.`,
    );
  }
  if (!listing.ok) {
    throw new Error(`GitHub: listing failed (HTTP ${listing.status}) for ${apiUrl}`);
  }
  const entries = (await listing.json()) as ContentsEntry[];
  if (!Array.isArray(entries)) {
    throw new Error(
      `GitHub: expected a directory listing at ${parsed.path}; got a single file. Use the blob URL form for single-file installs.`,
    );
  }

  const files = entries.filter(e => e.type === 'file');
  if (!files.some(f => f.name === 'string.md')) {
    const have = files.map(f => f.name).join(', ') || '(empty)';
    throw new Error(
      `No string.md found at ${parsed.owner}/${parsed.repo}/${parsed.path} (@${ref}) — not a String app.\n` +
      `Directory contents: ${have}`,
    );
  }

  // string.md content goes into `loaded.source` so the installer parses
  // frontmatter (type/name/namespace) directly, without a fetch round-trip.
  const stringMdRawUrl = `${rawBase}/${parsed.path}/string.md`;
  const stringMdRes = await fetch(stringMdRawUrl);
  if (!stringMdRes.ok) {
    throw new Error(`GitHub: failed to fetch string.md (HTTP ${stringMdRes.status})`);
  }
  const stringMdSource = await stringMdRes.text();

  // Build the manifest. Only top-level files for v1 — most String apps are
  // flat. Subdirectory recursion lands in a follow-up if a real app needs it.
  const manifest = {
    files: files.map(f => ({
      path: f.name,
      url: `${rawBase}/${parsed.path}/${f.name}`,
    })),
    delivery: 'local' as const,
  };

  return {
    uri: stringMdRawUrl,
    source: stringMdSource,
    rawSource: JSON.stringify(manifest),
  };
}
