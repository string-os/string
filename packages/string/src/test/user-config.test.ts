/**
 * Unit tests for client config + centralized user resolution.
 *
 * Covers: resolveUserId precedence, config.json load/save round-trip,
 * current-user get/set/clear, and back-compat (no config.json → default).
 * Each case isolates ~/.string/config.json via STRINGD_CONFIG so it never
 * touches the real user config.
 */
import fs from 'fs';
import path from 'path';
import {
  loadClientConfig,
  saveClientConfig,
  getCurrentUser,
  setCurrentUser,
  clearCurrentUser,
  resolveUserId,
} from '../config.js';
import { assert, section } from './runner.js';

/** Run `fn` with an isolated STRINGD_CONFIG + cleared STRINGD_USER. */
function withIsolatedConfig(fn: (configFile: string) => void): void {
  const dir = fs.mkdtempSync('/tmp/string-cfg-');
  const configFile = path.join(dir, 'config.json');
  const prevConfig = process.env.STRINGD_CONFIG;
  const prevUser = process.env.STRINGD_USER;
  process.env.STRINGD_CONFIG = configFile;
  delete process.env.STRINGD_USER;
  try {
    fn(configFile);
  } finally {
    if (prevConfig === undefined) delete process.env.STRINGD_CONFIG;
    else process.env.STRINGD_CONFIG = prevConfig;
    if (prevUser === undefined) delete process.env.STRINGD_USER;
    else process.env.STRINGD_USER = prevUser;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await section('config — load/save round-trip', async () => {
  withIsolatedConfig((configFile) => {
    // No file yet → empty config (back-compat).
    assert(Object.keys(loadClientConfig()).length === 0, 'missing config → empty object');
    assert(getCurrentUser() === undefined, 'no currentUser when no file');

    setCurrentUser('leo');
    assert(fs.existsSync(configFile), 'config.json written on set');

    // Persisted shape is a forward-compatible object.
    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    assert(onDisk.currentUser === 'leo', 'currentUser persisted to disk');
    assert(getCurrentUser() === 'leo', 'getCurrentUser reads back leo');

    // saveClientConfig merges, preserving unknown keys (forward-compat).
    saveClientConfig({ futureKey: 'x' } as any);
    const merged = loadClientConfig() as any;
    assert(merged.currentUser === 'leo', 'merge preserves currentUser');
    assert(merged.futureKey === 'x', 'merge preserves new key');
  });
});

await section('config — clearCurrentUser', async () => {
  withIsolatedConfig(() => {
    setCurrentUser('leo');
    assert(getCurrentUser() === 'leo', 'set leo');
    clearCurrentUser();
    assert(getCurrentUser() === undefined, 'cleared');
  });
});

await section('config — corrupt config → empty (back-compat)', async () => {
  withIsolatedConfig((configFile) => {
    fs.writeFileSync(configFile, 'not json{{');
    assert(Object.keys(loadClientConfig()).length === 0, 'corrupt file → empty');
    assert(getCurrentUser() === undefined, 'corrupt file → no currentUser');
  });
});

await section('config — resolveUserId precedence', async () => {
  withIsolatedConfig(() => {
    // 4. fallback: nothing set → 'default'.
    assert(resolveUserId() === 'default', 'no flag/env/config → default');
    assert(resolveUserId(null) === 'default', 'null flag → default');
    assert(resolveUserId('   ') === 'default', 'blank flag is ignored → default');

    // 3. config.currentUser beats default.
    setCurrentUser('leo');
    assert(resolveUserId() === 'leo', 'config.currentUser → leo');

    // 2. STRINGD_USER beats config.currentUser.
    process.env.STRINGD_USER = 'envuser';
    assert(resolveUserId() === 'envuser', 'STRINGD_USER overrides config');

    // 1. --user flag beats everything.
    assert(resolveUserId('flaguser') === 'flaguser', '--user overrides STRINGD_USER + config');

    delete process.env.STRINGD_USER;
    assert(resolveUserId() === 'leo', 'back to config.currentUser when env cleared');
    assert(resolveUserId('flaguser') === 'flaguser', '--user still wins over config');
  });
});
