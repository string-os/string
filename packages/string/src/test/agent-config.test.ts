/**
 * Unit tests for client config + centralized agent resolution.
 *
 * Covers: resolveAgentId precedence, config.json load/save round-trip,
 * current-agent get/set/clear, and back-compat (no config.json → default).
 * Each case isolates ~/.string/config.json via STRING_CONFIG so it never
 * touches the real agent config.
 */
import fs from 'fs';
import path from 'path';
import {
  configPath,
  loadClientConfig,
  saveClientConfig,
  getCurrentAgent,
  setCurrentAgent,
  clearCurrentAgent,
  resolveAgentId,
} from '../config.js';
import { assert, section } from './runner.js';

/** Run `fn` with an isolated STRING_CONFIG + cleared STRING_AGENT_ID. */
function withIsolatedConfig(fn: (configFile: string) => void): void {
  const dir = fs.mkdtempSync('/tmp/string-cfg-');
  const configFile = path.join(dir, 'config.json');
  const prevConfig = process.env.STRING_CONFIG;
  const prevUser = process.env.STRING_AGENT_ID;
  process.env.STRING_CONFIG = configFile;
  delete process.env.STRING_AGENT_ID;
  try {
    fn(configFile);
  } finally {
    if (prevConfig === undefined) delete process.env.STRING_CONFIG;
    else process.env.STRING_CONFIG = prevConfig;
    if (prevUser === undefined) delete process.env.STRING_AGENT_ID;
    else process.env.STRING_AGENT_ID = prevUser;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Run `fn` with isolated project-local config discovery. */
function withProjectConfig(fn: (root: string) => void): void {
  const root = fs.mkdtempSync('/tmp/string-project-cfg-');
  const prevConfig = process.env.STRING_CONFIG;
  const prevProject = process.env.STRING_PROJECT_DIR;
  const prevClaudeProject = process.env.CLAUDE_PROJECT_DIR;
  const prevAgent = process.env.STRING_AGENT_ID;
  delete process.env.STRING_CONFIG;
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env.STRING_AGENT_ID;
  process.env.STRING_PROJECT_DIR = root;
  try {
    fn(root);
  } finally {
    if (prevConfig === undefined) delete process.env.STRING_CONFIG;
    else process.env.STRING_CONFIG = prevConfig;
    if (prevProject === undefined) delete process.env.STRING_PROJECT_DIR;
    else process.env.STRING_PROJECT_DIR = prevProject;
    if (prevClaudeProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevClaudeProject;
    if (prevAgent === undefined) delete process.env.STRING_AGENT_ID;
    else process.env.STRING_AGENT_ID = prevAgent;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await section('config — load/save round-trip', async () => {
  withIsolatedConfig((configFile) => {
    // No file yet → empty config (back-compat).
    assert(Object.keys(loadClientConfig()).length === 0, 'missing config → empty object');
    assert(getCurrentAgent() === undefined, 'no currentAgent when no file');

    setCurrentAgent('leo');
    assert(fs.existsSync(configFile), 'config.json written on set');

    // Persisted shape is a forward-compatible object.
    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    assert(onDisk.currentAgent === 'leo', 'currentAgent persisted to disk');
    assert(getCurrentAgent() === 'leo', 'getCurrentAgent reads back leo');

    // saveClientConfig merges, preserving unknown keys (forward-compat).
    saveClientConfig({ futureKey: 'x' } as any);
    const merged = loadClientConfig() as any;
    assert(merged.currentAgent === 'leo', 'merge preserves currentAgent');
    assert(merged.futureKey === 'x', 'merge preserves new key');
  });
});

await section('config — clearCurrentAgent', async () => {
  withIsolatedConfig(() => {
    setCurrentAgent('leo');
    assert(getCurrentAgent() === 'leo', 'set leo');
    clearCurrentAgent();
    assert(getCurrentAgent() === undefined, 'cleared');
  });
});

await section('config — corrupt config → empty (back-compat)', async () => {
  withIsolatedConfig((configFile) => {
    fs.writeFileSync(configFile, 'not json{{');
    assert(Object.keys(loadClientConfig()).length === 0, 'corrupt file → empty');
    assert(getCurrentAgent() === undefined, 'corrupt file → no currentAgent');
  });
});

await section('config — resolveAgentId precedence', async () => {
  withIsolatedConfig(() => {
    // 4. fallback: nothing set → 'default'.
    assert(resolveAgentId() === 'default', 'no flag/env/config → default');
    assert(resolveAgentId(null) === 'default', 'null flag → default');
    assert(resolveAgentId('   ') === 'default', 'blank flag is ignored → default');

    // 3. config.currentAgent beats default.
    setCurrentAgent('leo');
    assert(resolveAgentId() === 'leo', 'config.currentAgent → leo');

    // 2. STRING_AGENT_ID beats config.currentAgent.
    process.env.STRING_AGENT_ID = 'env-agent';
    assert(resolveAgentId() === 'env-agent', 'STRING_AGENT_ID overrides config');

    // 1. --agent flag beats everything.
    assert(resolveAgentId('flag-agent') === 'flag-agent', '--agent overrides STRING_AGENT_ID + config');

    delete process.env.STRING_AGENT_ID;
    assert(resolveAgentId() === 'leo', 'back to config.currentAgent when env cleared');
    assert(resolveAgentId('flag-agent') === 'flag-agent', '--agent still wins over config');
  });
});

await section('config — project-local .string/config.json', async () => {
  withProjectConfig((root) => {
    const localDir = path.join(root, '.string');
    const localConfig = path.join(localDir, 'config.json');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(localConfig, JSON.stringify({ currentAgent: 'project-agent' }));

    assert(configPath() === localConfig, 'project-local config path selected');
    assert(getCurrentAgent() === 'project-agent', 'project-local currentAgent used');
    assert(resolveAgentId() === 'project-agent', 'project-local agent beats default');

    process.env.STRING_AGENT_ID = 'env-agent';
    assert(resolveAgentId() === 'env-agent', 'env still beats project-local config');
    assert(resolveAgentId('flag-agent') === 'flag-agent', 'flag still beats env');
  });
});

await section('config — .string directory makes local saves explicit', async () => {
  withProjectConfig((root) => {
    const localDir = path.join(root, '.string');
    const localConfig = path.join(localDir, 'config.json');
    fs.mkdirSync(localDir, { recursive: true });

    assert(configPath() === localConfig, '.string dir selects local config path');
    setCurrentAgent('workspace-agent');
    assert(fs.existsSync(localConfig), 'setCurrentAgent writes project-local config');
    assert(getCurrentAgent() === 'workspace-agent', 'project-local saved agent reads back');
  });
});
