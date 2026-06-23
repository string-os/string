/**
 * String — Package Installer
 * Installs apps/tools by registering them in config.json and, when needed,
 * staging a local copy under {home}/packages/.
 * `home` here is the String agent's home (already a String-only directory).
 */

import fs from 'fs/promises';
import path from 'path';
import type { Loader } from './loader.js';
import { resolve } from './resolver.js';
import { parseGithubUrl, synthesizeGithubSource } from './github-installer.js';

export interface InstallResult {
  name: string;
  type: 'app' | 'tool';
  localUri: string; // file:// URI to installed copy, or remote URL when linked
  linked?: boolean; // true when registered as URL shortcut (--link or manifest.delivery=link)
}

/**
 * Read the `delivery` hint from a String Install Manifest, if the loaded
 * rawSource happens to be one. Generic across registries — only inspects
 * shape `{ files: [...], delivery: ... }`, no vendor-specific fields.
 *
 * Returns 'link' | 'local' | undefined.
 */
function readManifestDelivery(rawSource: string | undefined): 'link' | 'local' | undefined {
  if (!rawSource) return undefined;
  try {
    const m = JSON.parse(rawSource);
    if (!m || !Array.isArray(m.files)) return undefined;
    if (m.delivery === 'link') return 'link';
    if (m.delivery === 'local' || m.delivery === 'any') return 'local';
  } catch { /* not JSON — not a manifest */ }
  return undefined;
}

function isInstallManifest(rawSource: string | undefined): boolean {
  if (!rawSource) return false;
  try {
    const m = JSON.parse(rawSource);
    return Boolean(m && Array.isArray(m.files));
  } catch {
    return false;
  }
}

/**
 * Recursively strip write permission bits from every file under `dir`,
 * preserving read + execute. Directories are left writable so the install can
 * still be removed/replaced by /uninstall + reinstall. Best-effort: a chmod
 * failure (e.g. odd FS) must not fail the install.
 */
async function stripWriteBits(dir: string): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await stripWriteBits(full);
    } else if (entry.isFile()) {
      try {
        const { mode } = await fs.stat(full);
        await fs.chmod(full, mode & ~0o222);
      } catch { /* best-effort */ }
    }
  }
}

function isGithubInstallSource(source: string): boolean {
  if (parseGithubUrl(source)) return true;
  try {
    const url = new URL(source);
    return url.hostname === 'raw.githubusercontent.com';
  } catch {
    return false;
  }
}

/**
 * Read the canonical (namespace, name) identity from an installed package's
 * string.md, if it exists. Used to detect collisions: two apps with the same
 * local name but different (namespace, name) are different apps colliding,
 * not the same app being re-installed.
 *
 * Returns null on any read/parse failure — callers fall back to URI comparison.
 */
async function readInstalledIdentity(
  fileUri: string,
): Promise<{ namespace: string; name: string } | null> {
  if (!fileUri.startsWith('file://')) return null;
  try {
    const filePath = new URL(fileUri).pathname;
    const content = await fs.readFile(filePath, 'utf-8');
    // Cheap frontmatter parse: avoid full SFMD resolve to keep collision check
    // free of side effects (resolve fetches dependencies, runs imports, etc.).
    const m = content.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return null;
    const ns = m[1].match(/^namespace:\s*(.+?)\s*$/m)?.[1];
    const nm = m[1].match(/^name:\s*(.+?)\s*$/m)?.[1];
    if (!ns || !nm) return null;
    return { namespace: ns.replace(/^["']|["']$/g, ''), name: nm.replace(/^["']|["']$/g, '') };
  } catch {
    return null;
  }
}

/**
 * Install a package (app or tool) from a local path or URL.
 *
 * Flow:
 * 1. Load the source document via loader
 * 2. Parse frontmatter for type/name
 * 3. Link HTTP markdown pages by default, or copy local/manifest sources
 * 4. Register in config.json
 *
 * --link: register the source URL directly without copying files locally.
 *         /open app:name will fetch from the URL each time. Useful for
 *         external apps where the publisher wants their own server to
 *         remain the canonical source.
 *
 * --local: force a URL source to be copied into packages/{name}/. Useful for
 *          intentionally snapshotting a web page or installing a trusted
 *          single-file remote app with local CLI actions.
 *
 * --as <local-name>: override the registry key (default: frontmatter.name).
 *         Used to install two apps that share a `name` but differ by
 *         `namespace` (e.g. cookbook/weather and stringhub/weather).
 *         Without --as, the second install errors out instead of silently
 *         overwriting the first.
 */
export async function installPackage(
  source: string,
  opts: { type?: 'app' | 'tool'; link?: boolean; local?: boolean; as?: string },
  loader: Loader,
): Promise<InstallResult> {
  // --link only makes sense for http(s) URLs. Check up-front so an agent who
  // typed `--link ./local-file.md` gets a clear "needs URL" error instead of
  // the loader's generic "File not found" (which sent us down a dead end).
  if (opts.link && !source.startsWith('http://') && !source.startsWith('https://')) {
    throw new Error('--link requires an http(s) URL source.');
  }

  // GitHub URL shortcut: recognize browser-bar URLs (tree/blob) and `gh:` short
  // form, then enumerate via the Contents API and synthesize an in-memory
  // install manifest. The rest of the installer reuses the manifest pipeline
  // unchanged. Single-file (`blob`) URLs collapse to a raw URL and fall
  // through to the normal HTTP load.
  let loadSource = source;
  let loaded: import('./loader.js').LoadResult;
  const ghParsed = parseGithubUrl(source);
  const githubInstallSource = isGithubInstallSource(source);
  if (ghParsed) {
    const ghResult = await synthesizeGithubSource(ghParsed, loader);
    if ('singleFileRawUrl' in ghResult) {
      loadSource = ghResult.singleFileRawUrl;
      loaded = await loader.load(loadSource);
    } else {
      loaded = ghResult;
    }
  } else {
    // Directory source → look for string.md (the App/Tool root marker)
    try {
      const localPath = source.startsWith('file://')
        ? new URL(source).pathname
        : (path.isAbsolute(source) ? source : path.resolve(loader.home, source));
      const stat = await fs.stat(localPath);
      if (stat.isDirectory()) {
        loadSource = path.join(localPath, 'string.md');
      }
    } catch { /* not a local path or doesn't exist — let loader handle it */ }
    loaded = await loader.load(loadSource);
  }
  const doc = await resolve(loaded.uri, loaded.source, loader);

  // Determine type: explicit flag > frontmatter > error
  let type: 'app' | 'tool';
  if (opts.type) {
    type = opts.type;
  } else if (doc.frontmatter.type === 'app' || doc.frontmatter.type === 'tool') {
    type = doc.frontmatter.type as 'app' | 'tool';
  } else {
    const displayName = typeof doc.frontmatter.name === 'string'
      ? doc.frontmatter.name
      : path.basename(source, '.md');
    throw new Error(
      `Cannot determine package type for "${displayName}".\n` +
      `The document does not specify whether it is an app or a tool.\n` +
      `To install explicitly:\n` +
      `  /install --app ${source}\n` +
      `  /install --tool ${source}`
    );
  }

  // Determine name: opts.as > frontmatter.name > filename.
  // Both paths go through the same sanitizer — frontmatter is attacker-controlled
  // input (you install packages from other people's repos) and must not contain
  // '..', '/', or any char that could escape {home}/packages/.
  const sanitizeName = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  const rawFrontmatterName = typeof doc.frontmatter.name === 'string' && doc.frontmatter.name
    ? doc.frontmatter.name
    : path.basename(source, '.md');
  const rawName = opts.as ?? rawFrontmatterName;
  const name = sanitizeName(rawName);
  if (!name) {
    throw new Error(
      opts.as
        ? `Invalid --as value: "${rawName}" — must contain [a-zA-Z0-9_-]`
        : `Invalid package name: "${rawName}" — must contain [a-zA-Z0-9_-]`
    );
  }

  const registryType = type === 'app' ? 'apps' : 'tools';

  // Collision check: refuse to silently overwrite a different app installed
  // under the same local name. This is common in marketplaces where multiple
  // publishers ship apps with the same `name` field (cookbook/weather vs
  // stringhub/weather both declare `name: weather`).
  //
  // Re-install of the SAME app (matching identity) is allowed — that's how
  // version upgrades work.
  //
  // Identity check, in order of reliability:
  //   1. Local install: read installed string.md frontmatter → (namespace, name)
  //   2. Link install: registry stores the source URL → string compare
  //   3. Cross-mode or unparseable: treat as collision (force --as)
  for (const t of ['apps', 'tools'] as const) {
    const existingUri = loader.envStore.getPackage(t, name);
    if (!existingUri) continue;

    let isReinstall = false;
    if (existingUri.startsWith('file://')) {
      const existingId = await readInstalledIdentity(existingUri);
      const newNs = typeof doc.frontmatter.namespace === 'string' ? doc.frontmatter.namespace : undefined;
      const newNm = typeof doc.frontmatter.name === 'string' ? doc.frontmatter.name : undefined;
      if (existingId && newNs && newNm && existingId.namespace === newNs && existingId.name === newNm) {
        isReinstall = true;
      }
    } else {
      // existing entry is link-mode — compare source URLs directly
      isReinstall = existingUri === source;
    }

    if (!isReinstall) {
      const altName = opts.as ? `${name}-2` : `${name}-2`;
      throw new Error(
        `An ${t === 'apps' ? 'app' : 'tool'} named "${name}" is already installed.\n` +
        `Refusing to overwrite a different package with the same local name.\n` +
        `\n` +
        `To install both side-by-side, choose a different local name with --as:\n` +
        `  /install --as ${altName} ${source}\n` +
        `\n` +
        `Or remove the existing one first:\n` +
        `  /uninstall ${name}`
      );
    }
  }

  // De-dupe: if any existing registry entry already points to the URI we're
  // about to register, remove it. Catches the case where the same source URL
  // is re-installed and the resolved name differs (e.g. frontmatter changed).
  // Without this, both the old and new names linger in config.json.
  const removeDuplicates = (newUri: string) => {
    for (const t of ['apps', 'tools'] as const) {
      for (const [otherName, uri] of Object.entries(loader.envStore.listPackages(t))) {
        if (uri === newUri && otherName !== name) {
          loader.envStore.deletePackage(t, otherName);
        }
      }
    }
  };

  // Install mode priority (first non-null wins):
  //   1. opts.link / opts.local — explicit CLI flags
  //   2. manifest.delivery — publisher hint baked into the install manifest
  //      ("link" → register URL, "local"/"any" → download)
  //   3. plain http(s) markdown page — link by default, because the web page
  //      is the canonical app surface and /open app:name should re-fetch it
  //   4. default — local copy (local paths, GitHub install sources, and
  //      manifest-local installs)
  //
  // Treating manifest.delivery as advisory keeps the daemon registry-agnostic:
  // any HTTP source emitting a generic { files: [...], delivery: ... } JSON
  // gets the same handling. Plain markdown web pages are different: they are
  // already the app surface, so installing them records a URL shortcut.
  // GitHub URLs are package sources, not web app surfaces, so they install
  // locally by default and can run CLI actions after review.
  const manifestDelivery = readManifestDelivery(loaded.rawSource);
  const manifestSource = isInstallManifest(loaded.rawSource);
  const httpSource = source.startsWith('http://') || source.startsWith('https://');
  const shouldLink = opts.link
    ?? (opts.local ? false : undefined)
    ?? (manifestDelivery !== undefined ? manifestDelivery === 'link' : (!manifestSource && httpSource && !githubInstallSource));

  // Link mode: register the URL directly, skip local file copy.
  // /open will re-fetch from the URL each time. (Scheme check runs above so
  // a non-URL source fails before we waste a loader.load round-trip.)
  if (shouldLink) {
    if (!httpSource) {
      throw new Error('Link installs require an http(s) URL source.');
    }
    removeDuplicates(source);
    await fs.rm(path.join(loader.home, 'packages', name), { recursive: true, force: true });
    loader.envStore.setPackage(registryType as 'apps' | 'tools', name, source);
    return { name, type, localUri: source, linked: true };
  }

  // Atomic install: stage everything into packages/{name}.tmp/, then atomic
  // rename to packages/{name}/. This guarantees that a failed install (bad
  // manifest path, network drop mid-fetch, disk full halfway through) leaves
  // no partial files in the live package directory. Any orphan tmp dir from
  // a crashed prior run is cleared up-front.
  const packagesDir = path.join(loader.home, 'packages', name);
  const stagingDir = path.join(loader.home, 'packages', `.${name}.tmp`);
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });

  try {
    const stagedString = path.join(stagingDir, 'string.md');
    await fs.writeFile(stagedString, loaded.source, 'utf-8');

    // Multi-file install branches:
    //   1. file://  — copy sibling .md files from the source directory.
    //   2. http(s):// + JSON manifest — loader preserved original bundle in
    //      loaded.rawSource. Iterate files[] and fetch each url (skip string.md
    //      which is already written from loaded.source).
    if (loaded.uri.startsWith('file://')) {
      const sourceDir = path.dirname(new URL(loaded.uri).pathname);
      const sourceBasename = path.basename(new URL(loaded.uri).pathname);
      // Copy sibling files recursively, preserving subdirectory structure so
      // multi-file apps that keep their nav menu in `nav/main.md` (or any other
      // subdir) install intact. Skips the entry doc, an extra string.md, any
      // dotfile/dot-directory (.git, .DS_Store, .env, ...), and symlinks (avoids
      // loops). Non-.md siblings — .sh/.py/.js helpers, .json configs — are
      // copied with mode preserved so CLI actions can call them
      // (e.g. `CLI ./helper.sh {arg}`).
      const copyTree = async (relDir: string): Promise<void> => {
        const entries = await fs.readdir(path.join(sourceDir, relDir));
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          const rel = relDir ? path.join(relDir, entry) : entry;
          if (rel === sourceBasename || rel === 'string.md') continue;
          const srcPath = path.join(sourceDir, rel);
          const stat = await fs.lstat(srcPath);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) {
            await copyTree(rel);
          } else if (stat.isFile()) {
            const dest = path.join(stagingDir, rel);
            await fs.mkdir(path.dirname(dest), { recursive: true });
            await fs.copyFile(srcPath, dest);
            await fs.chmod(dest, stat.mode);
          }
        }
      };
      try {
        await copyTree('');
      } catch { /* non-local or unreadable — skip */ }
    } else if (loaded.rawSource) {
      let manifest: { files?: unknown[] } | null = null;
      try { manifest = JSON.parse(loaded.rawSource); } catch { /* not a manifest */ }

      if (manifest && Array.isArray(manifest.files)) {
        // Phase 1: validate every entry's path BEFORE any fetch or write.
        // A single bad path aborts the install before we touch the network.
        const writableEntries: { path: string; content?: string; url?: string }[] = [];
        for (const file of manifest.files) {
          if (!file || typeof (file as { path?: unknown }).path !== 'string') continue;
          const f = file as { path: string; content?: string; url?: string };
          if (f.path === 'string.md') continue; // already staged
          if (f.path.includes('..') || f.path.startsWith('/') || f.path.startsWith('\\')) {
            throw new Error(`Security violation: invalid file path "${f.path}"`);
          }
          if (typeof f.content !== 'string' && typeof f.url !== 'string') continue;
          writableEntries.push(f);
        }

        // Phase 2: fetch + write each validated entry into staging dir.
        // Any error here aborts the whole install via the outer catch, which
        // wipes stagingDir — so the live packages/{name}/ never sees a
        // partial state.
        for (const f of writableEntries) {
          const dest = path.join(stagingDir, f.path);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          let content: string;
          if (typeof f.content === 'string') {
            content = f.content;
          } else {
            const r = await fetch(f.url!, { headers: { Accept: 'text/markdown, text/plain' } });
            if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${f.path} (${f.url})`);
            content = await r.text();
          }
          await fs.writeFile(dest, content, 'utf-8');
          // Shebang detection: if the file starts with `#!`, mark it executable
          // so CLI actions can invoke it directly (e.g. `CLI ./helper {arg}`).
          // Local-file installs already preserve mode; this covers manifest
          // installs where the source has no transferable file mode.
          if (content.startsWith('#!')) {
            await fs.chmod(dest, 0o755);
          }
        }
      }
    }

    // Atomic swap: remove old install (if any) and rename staging into place.
    // Two-step because POSIX rename only atomically replaces a non-existent
    // target or a single file; replacing a directory requires explicit rm first.
    await fs.rm(packagesDir, { recursive: true, force: true });
    await fs.rename(stagingDir, packagesDir);
    // Make the installed source read-only: an app's CLI actions run with cwd =
    // its own dir, so without this an action could silently mutate its own
    // source. Apps write to $STRING_WORK_DIR instead. We strip *write* bits only
    // (preserve read + execute, so helper scripts like `./kanban` still run) and
    // leave directories writable so /uninstall + reinstall can still remove files.
    await stripWriteBits(packagesDir);
  } catch (err) {
    // Any failure: drop the staging dir so we leave no partial bytes behind.
    // The live packages/{name}/ is untouched (we haven't renamed yet).
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  // Register in config.json
  const destFile = path.join(packagesDir, 'string.md');
  const localUri = `file://${destFile}`;
  removeDuplicates(localUri);
  loader.envStore.setPackage(registryType as 'apps' | 'tools', name, localUri);

  return { name, type, localUri };
}
