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
 * 3. Copy to ~/.string/packages/{name}/index.md
 * 4. Register in config.json
 */
export async function installPackage(
  source: string,
  opts: { type?: 'app' | 'tool' },
  loader: Loader,
): Promise<InstallResult> {
  // Load and resolve the document
  const loaded = await loader.load(source);
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

  // Determine name: frontmatter.name > filename
  const name = typeof doc.frontmatter.name === 'string' && doc.frontmatter.name
    ? doc.frontmatter.name
    : path.basename(source, '.md').replace(/[^a-zA-Z0-9_-]/g, '-');

  // Copy to ~/.string/packages/{name}/index.md
  const packagesDir = path.join(loader.home, '.string', 'packages', name);
  await fs.mkdir(packagesDir, { recursive: true });
  const destFile = path.join(packagesDir, 'index.md');
  await fs.writeFile(destFile, loaded.source, 'utf-8');

  // Register in config.json
  const registryType = type === 'app' ? 'apps' : 'tools';
  const localUri = `file://${destFile}`;
  loader.envStore.setPackage(registryType as 'apps' | 'tools', name, localUri);

  return { name, type, localUri };
}
