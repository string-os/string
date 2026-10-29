/**
 * Boot diagnostics on AgentRegistry: loadedFromStore / loadedCount /
 * loadedWithWebhookToken / storePath. These back the daemon's startup
 * `agents.store.loaded` log, which makes a restart that boots an EMPTY registry
 * (the data dir was lost/relocated across an upgrade, so every webhook token is
 * silently re-minted on first use and every stale caller 401s) observable at
 * startup instead of surfacing hours or days later as unexplained 401s.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Agent } from '../index.js';
import { createAgentRegistry } from '../index.js';
import { assert, section } from './runner.js';

function mkStoreDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'string-store-'));
}
function agent(id: string, withToken: boolean): Agent {
  return { id, home: `/h/${id}`, allowedPaths: [], createdAt: 't', ...(withToken ? { webhookToken: `wh_${id}` } : {}) };
}

await section('agent store — loads counts and token-count from a populated store', async () => {
  const dir = mkStoreDir();
  const store = path.join(dir, 'agents.json');
  fs.writeFileSync(store, JSON.stringify([agent('a', true), agent('b', true), agent('c', false)]));
  try {
    const reg = createAgentRegistry([], store);
    assert(reg.loadedFromStore === true, 'loadedFromStore true when the file parses as an array');
    assert(reg.loadedCount === 3, 'loadedCount counts every persisted agent');
    assert(reg.loadedWithWebhookToken === 2, 'loadedWithWebhookToken counts only agents carrying a token');
    assert(reg.storePath === store, 'storePath echoes the persist path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await section('agent store — a missing file boots an EMPTY registry (the outage signature)', async () => {
  const dir = mkStoreDir();
  const store = path.join(dir, 'absent.json');
  try {
    const reg = createAgentRegistry([], store);
    assert(reg.loadedFromStore === false, 'loadedFromStore false when the store is absent');
    assert(reg.loadedCount === 0, 'loadedCount 0 on a fresh/empty boot');
    assert(reg.loadedWithWebhookToken === 0, 'no tokens loaded on a fresh boot');
    assert(reg.storePath === store, 'storePath still echoes the (absent) path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await section('agent store — counts reflect the STORE, not initialAgents overlaid after load', async () => {
  const dir = mkStoreDir();
  const store = path.join(dir, 'agents.json');
  fs.writeFileSync(store, JSON.stringify([agent('a', true)]));
  try {
    const reg = createAgentRegistry([agent('b', true)], store);
    assert(reg.loadedCount === 1, 'loadedCount excludes initialAgents overlaid after the store load');
    assert(reg.loadedWithWebhookToken === 1, 'loadedWithWebhookToken excludes the overlay');
    assert(reg.list().length === 2, 'the overlay is still registered (the load snapshot is diagnostic, not a cap)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await section('agent store — an in-memory registry (no persist path) reports no store', async () => {
  const reg = createAgentRegistry([]);
  assert(reg.storePath === null, 'storePath null without a persist path');
  assert(reg.loadedFromStore === false, 'loadedFromStore false without a persist path');
  assert(reg.loadedCount === 0, 'loadedCount 0 without a persist path');
});
