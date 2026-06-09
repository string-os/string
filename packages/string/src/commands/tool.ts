/**
 * /tool command handler — tool resolution and execution.
 */

import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Loader } from '../loader.js';
import { resolve } from '../resolver.js';
import type { Session } from '../session.js';
import type { CommandResult, LoadedDocument } from '../types.js';
import { deriveEnvScope } from '../env-store.js';
import type { EnvScope } from '../env-store.js';
import { ok, err } from './helpers.js';
import { executeAction } from './action.js';
import { buildContextVars } from './context-vars.js';

/**
 * Resolve a tool name to a loaded SFMD document.
 * Search order: ./tools/{name}.md → ~/.string/tools/{name}.md → frontmatter name scan → registry
 */
export async function resolveTool(name: string, loader: Loader): Promise<LoadedDocument | null> {
  // 1. Workspace-local: ./tools/{name}.md
  const localPath = `./tools/${name}.md`;
  try {
    const loaded = await loader.load(localPath);
    return resolve(loaded.uri, loaded.source, loader);
  } catch { /* not found */ }

  // 2. Global: ~/.string/tools/{name}.md
  const globalPath = path.join(os.homedir(), '.string', 'tools', `${name}.md`);
  try {
    const loaded = await loader.load(globalPath);
    return resolve(loaded.uri, loaded.source, loader);
  } catch { /* not found */ }

  // 3. Frontmatter name matching: scan ./tools/*.md
  try {
    const toolsDir = path.resolve(loader.home, 'tools');
    const entries = await fsPromises.readdir(toolsDir);
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const filePath = path.join(toolsDir, entry);
      try {
        const loaded = await loader.load(filePath);
        const doc = await resolve(loaded.uri, loaded.source, loader);
        if (doc.frontmatter.name === name) return doc;
      } catch { /* skip unreadable files */ }
    }
  } catch { /* tools dir doesn't exist */ }

  // 4. Registry: check config.json tools section
  const registeredUri = loader.envStore.getPackage('tools', name);
  if (registeredUri) {
    try {
      const loaded = await loader.load(registeredUri);
      return resolve(loaded.uri, loaded.source, loader);
    } catch { /* registered but file missing */ }
  }

  return null;
}

// buildContextVars moved to ./context-vars.ts (shared by tools and app actions).
// Re-exported here for backward compatibility with any external importer.
export { buildContextVars };

/**
 * Validate that required env vars are set (from frontmatter.env).
 * Returns error message string or null if all OK.
 * Uses EnvStore (file-backed) instead of process.env.
 *
 * Frontmatter env format (parsed as array of objects):
 *   env:
 *     - REQUIRED_VAR: "description"
 *     - OPTIONAL_VAR: "description"
 *       default: fallback_value
 *
 * Parsed as: [{ REQUIRED_VAR: "description" }, { OPTIONAL_VAR: "description", default: "fallback_value" }]
 */
export function validateEnv(doc: LoadedDocument, loader: Loader, scope: EnvScope): string | null {
  const envDefs = doc.frontmatter.env;
  if (!envDefs || !Array.isArray(envDefs)) return null;

  for (const entry of envDefs) {
    if (typeof entry === 'string') {
      if (!loader.envStore.get(entry, scope)) {
        return `ERROR(ENV_REQUIRED): tool requires $${entry}`;
      }
    } else if (typeof entry === 'object' && entry !== null) {
      const obj = entry as Record<string, unknown>;
      // Check if this entry has a 'default' sibling key
      const hasDefault = 'default' in obj;
      for (const [name, meta] of Object.entries(obj)) {
        if (name === 'default') continue;
        if (!loader.envStore.get(name, scope) && !hasDefault) {
          const desc = typeof meta === 'string' ? meta : name;
          return `ERROR(ENV_REQUIRED): tool requires $${name} — "${desc}"`;
        }
      }
    }
  }
  return null;
}

/**
 * /tool:name[.act] handler
 */
export async function cmdTool(
  toolName: string,
  subAction: string | undefined,
  args: string,
  session: Session,
  loader: Loader,
): Promise<CommandResult> {
  // 1. Resolve tool file
  const toolDoc = await resolveTool(toolName, loader);
  if (!toolDoc) return err(`Tool not found: ${toolName}`, 'NOT_FOUND');

  // 2. Validate env requirements
  const envScope = deriveEnvScope(session.name);
  const envError = validateEnv(toolDoc, loader, envScope);
  if (envError) return err(envError, 'INVALID_PAYLOAD');

  // 3. Determine which action to run
  let actionId: string;
  if (subAction) {
    actionId = subAction;
  } else {
    const defaultId = toolDoc.frontmatter.default as string | undefined;
    if (!defaultId) {
      const available = toolDoc.actions.map(a => a.id).join(', ') || 'none';
      return err(`No default action for tool:${toolName}. Available: ${available}`, 'INVALID_PAYLOAD');
    }
    actionId = defaultId;
  }

  // 4. Find the action
  const action = toolDoc.actions.find(a => a.id === actionId);
  if (!action) {
    const available = toolDoc.actions.map(a => a.id).join(', ') || 'none';
    return err(`Action "${actionId}" not found in tool:${toolName}. Available: ${available}`, 'NOT_FOUND');
  }

  // 5. Build context variables
  const contextVars = buildContextVars(session, loader, args);

  // 6. Execute action with context vars as extra env
  return executeAction(action, args, session, loader, contextVars, toolDoc.uri);
}
