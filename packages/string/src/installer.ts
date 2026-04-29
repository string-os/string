/**
 * String — Package Installer
 * Installs apps/tools by copying source to ~/.string/packages/ and registering in config.json.
 */

import fs from 'fs/promises';
import path from 'path';
import type { Loader } from './loader.js';
import { resolve } from './resolver.js';

export interface InstallResult {
  name: string;
  type: 'app' | 'tool';
  localUri: string; // file:// URI to installed copy
}

/**
 * Install a package (app or tool) from a local path or URL.
 *
 * Flow:
 * 1. Load the source document via loader
 * 2. Parse frontmatter for type/name
 * 3. Copy to ~/.string/packages/{name}/string.md
 * 4. Register in config.json
 */
export async function installPackage(
  source: string,
  opts: { type?: 'app' | 'tool' },
  loader: Loader,
): Promise<InstallResult> {
  // Directory source → look for string.md (the App/Tool root marker)
  let loadSource = source;
  try {
    const localPath = source.startsWith('file://')
      ? new URL(source).pathname
      : (path.isAbsolute(source) ? source : path.resolve(loader.home, source));
    const stat = await fs.stat(localPath);
    if (stat.isDirectory()) {
      loadSource = path.join(localPath, 'string.md');
    }
  } catch { /* not a local path or doesn't exist — let loader handle it */ }

  // Load and resolve the document
  const loaded = await loader.load(loadSource);
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

  // Determine name: frontmatter.name > filename.
  // Both paths go through the same sanitizer — frontmatter is attacker-controlled
  // input (you install packages from other people's repos) and must not contain
  // '..', '/', or any char that could escape ~/.string/packages/.
  const sanitizeName = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  const rawName = typeof doc.frontmatter.name === 'string' && doc.frontmatter.name
    ? doc.frontmatter.name
    : path.basename(source, '.md');
  const name = sanitizeName(rawName);
  if (!name) {
    throw new Error(`Invalid package name: "${rawName}" — must contain [a-zA-Z0-9_-]`);
  }

  // Copy to ~/.string/packages/{name}/
  // The package root is always string.md (parallel to skill.md). When multiple
  // files exist, string.md marks "this is the entry point of a String unit."
  // If the source is a local file, copy all sibling .md files so multi-file
  // apps (string.md + submolts.md + profile.md etc.) work after install.
  const packagesDir = path.join(loader.home, '.string', 'packages', name);
  await fs.mkdir(packagesDir, { recursive: true });
  const destFile = path.join(packagesDir, 'string.md');
  await fs.writeFile(destFile, loaded.source, 'utf-8');

  if (loaded.uri.startsWith('file://')) {
    const sourceDir = path.dirname(new URL(loaded.uri).pathname);
    const sourceBasename = path.basename(new URL(loaded.uri).pathname);
    try {
      const entries = await fs.readdir(sourceDir);
      for (const entry of entries) {
        if (entry === sourceBasename) continue;
        if (entry === 'string.md') continue;
        if (!entry.endsWith('.md')) continue;
        const srcPath = path.join(sourceDir, entry);
        const stat = await fs.stat(srcPath);
        if (!stat.isFile()) continue;
        await fs.copyFile(srcPath, path.join(packagesDir, entry));
      }
    } catch { /* non-local or unreadable — skip */ }
  }

  // Register in config.json
  const registryType = type === 'app' ? 'apps' : 'tools';
  const localUri = `file://${destFile}`;
  loader.envStore.setPackage(registryType as 'apps' | 'tools', name, localUri);

  return { name, type, localUri };
}
