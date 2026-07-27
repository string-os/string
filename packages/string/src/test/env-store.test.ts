/**
 * EnvStore tests: CRUD, scope, deriveEnvScope, /set $VAR, $var resolve, cache
 */
import fs from 'fs';
import path from 'path';
import { Browser, EnvStore, deriveEnvScope } from '../index.js';
import { assert, section } from './runner.js';

await section('EnvStore — app-scope get/set/delete', async () => {
  // Global env was dropped — every $var lives in an app (or app+config) scope.
  // This section covers the basic CRUD path against an app scope, plus the
  // guard that rejects a scope-less set.
  const tmpDir = fs.mkdtempSync('/tmp/string-envstore-');
  const store = new EnvStore(tmpDir);
  const scope = { app: 'test' };

  // Initially empty
  assert(store.get('FOO', scope) === undefined, 'get returns undefined for unset var');

  // Set
  store.set('FOO', 'bar', scope);
  assert(store.get('FOO', scope) === 'bar', 'get returns set value');

  // Persisted to disk under apps/<app>/env.json (not config.json)
  const envFile = path.join(tmpDir, 'apps', 'test', 'env.json');
  const persisted = JSON.parse(fs.readFileSync(envFile, 'utf-8'));
  assert(persisted.FOO === 'bar', 'persisted to apps/test/env.json');

  // Delete
  const deleted = store.delete('FOO', scope);
  assert(deleted, 'delete returns true');
  assert(store.get('FOO', scope) === undefined, 'deleted var is gone');

  // Delete non-existent
  assert(!store.delete('NOPE', scope), 'delete non-existent returns false');

  // Scope-less set is rejected — no global env.
  let threw = false;
  try { store.set('GLOBAL', 'x'); } catch { threw = true; }
  assert(threw, 'set without app scope throws');
  assert(store.get('GLOBAL') === undefined, 'get without scope returns undefined');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('EnvStore — app and config scope', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-envstore-scope-');
  const store = new EnvStore(tmpDir);

  // Set at app + config scopes (no global path)
  store.set('API_KEY', 'app-key', { app: 'weather' });
  store.set('API_KEY', 'config-key', { app: 'weather', config: 'korea' });
  store.set('LANG', 'ko', { app: 'weather' });

  // Resolution cascade
  assert(store.get('API_KEY') === undefined, 'no global scope — undefined without app');
  assert(store.get('API_KEY', { app: 'weather' }) === 'app-key', 'app scope');
  assert(store.get('API_KEY', { app: 'weather', config: 'korea' }) === 'config-key', 'config overrides app');
  assert(store.get('LANG', { app: 'weather', config: 'korea' }) === 'ko', 'cascade up to app scope');
  assert(store.get('LANG', { app: 'other' }) === undefined, 'app var not visible in other app');

  // getAll merges
  const all = store.getAll({ app: 'weather', config: 'korea' });
  assert(all.API_KEY === 'config-key', 'getAll: config wins');
  assert(all.LANG === 'ko', 'getAll: app var included');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('EnvStore — config.json preserves other fields', async () => {
  // config.json no longer carries env vars (those live in apps/<app>/env.json),
  // but it still carries the package registry. The preservation guarantee
  // applies there: writing one section must not clobber unrelated fields.
  const tmpDir = fs.mkdtempSync('/tmp/string-envstore-preserve-');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    theme: 'dark',
    apps: { existing: 'file:///old-app/string.md' },
  }, null, 2));

  const store = new EnvStore(tmpDir);
  store.setPackage('apps', 'new-app', 'file:///new-app/string.md');

  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
  assert(config.theme === 'dark', 'unrelated config fields preserved');
  assert(config.apps.existing === 'file:///old-app/string.md', 'existing apps entries preserved');
  assert(config.apps['new-app'] === 'file:///new-app/string.md', 'new package registered');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('deriveEnvScope — scope from session name', async () => {
  const s1 = deriveEnvScope('main');
  assert(s1.app === undefined && s1.config === undefined, 'tab topic → empty scope');

  const s2 = deriveEnvScope('app:weather');
  assert(s2.app === 'weather' && s2.config === undefined, 'app topic → app scope');

  const s3 = deriveEnvScope('app:weather:korea');
  assert(s3.app === 'weather' && s3.config === 'korea', 'app:config → full scope');

  const s4 = deriveEnvScope('bash:dev');
  assert(s4.app === undefined, 'bash topic → empty scope');

  const s5 = deriveEnvScope('app');
  assert(s5.app === undefined, 'app hub → empty scope');
});

await section('/set $VAR — persistent env via command', async () => {
  // Persistent $vars are app-scoped — /set $VAR from a tab session is rejected.
  // Run everything in an app: topic so the var lands in apps/<app>/env.json.
  const tmpDir = fs.mkdtempSync('/tmp/string-set-env-');
  const b = new Browser({ home: tmpDir });

  const r1 = await b.exec('/set $API_KEY = "my-secret-key"', 'app:test');
  assert(r1.ok, 'set $var ok');
  assert(r1.content.includes('$API_KEY'), 'output shows $var name');
  assert(r1.content.includes('my-secret-key'), 'output shows value');
  assert(r1.content.includes('test'), 'shows app scope');

  // Persisted to apps/<app>/env.json (not config.json)
  const envFile = path.join(tmpDir, 'apps', 'test', 'env.json');
  const env = JSON.parse(fs.readFileSync(envFile, 'utf-8'));
  assert(env.API_KEY === 'my-secret-key', 'persisted to apps/test/env.json');

  // /set with no args shows both session and env vars in scope
  await b.exec('/set {session_var} = "temp"', 'app:test');
  const r2 = await b.exec('/set', 'app:test');
  assert(r2.ok, 'list vars ok');
  assert(r2.content.includes('{session_var}'), 'shows session var');
  assert(r2.content.includes('$API_KEY'), 'shows persistent env var');

  // /set $VAR from a tab topic is rejected with a guiding message
  const r3 = await b.exec('/set $TAB_VAR = "x"', 'main');
  assert(!r3.ok, '/set $var from tab topic rejected');
  assert(r3.content.includes('app-scoped'), 'rejection message mentions app scope');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/set $VAR — app scope', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-set-env-app-');
  const b = new Browser({ home: tmpDir });

  // Set in app scope (session = "app:myapp")
  const r = await b.exec('/set $APP_TOKEN = "app-tok"', 'app:myapp');
  assert(r.ok, 'set in app scope ok');
  assert(r.content.includes('myapp'), 'shows app scope');

  // Verify stored in app env file
  const envFile = path.join(tmpDir, 'apps', 'myapp', 'env.json');
  const env = JSON.parse(fs.readFileSync(envFile, 'utf-8'));
  assert(env.APP_TOKEN === 'app-tok', 'stored in app env file');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('$var resolved from EnvStore in CLI action', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-envresolve-');
  fs.writeFileSync(path.join(tmpDir, 'test.md'), [
    '# Test',
    '',
    '```act.show',
    'CLI echo "key=$API_KEY"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  // Persistent env is app-scoped — set and run from the same app: topic.
  await b.exec('/set $API_KEY = "resolved-value"', 'app:envtest');
  await b.exec(`/open ${path.join(tmpDir, 'test.md')}`, 'app:envtest');

  const r = await b.exec('/act.show --', 'app:envtest');
  assert(r.ok, 'action ok');
  assert(r.content.includes('key=resolved-value'), '$var resolved from EnvStore');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('$var unresolved stays as-is', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-envunresolved-');
  // Use printf with single quotes so bash doesn't further resolve the $var
  fs.writeFileSync(path.join(tmpDir, 'test.md'), [
    '# Test',
    '',
    '```act.show',
    "CLI printf 'val=%s' '$NONEXISTENT'",
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'test.md')}`);

  const r = await b.exec('/act.show --');
  assert(r.ok, 'action ok');
  assert(r.content.includes('val=$NONEXISTENT'), 'unresolved $var stays as-is');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('EnvStore — cache and reload', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-envstore-cache-');
  const store = new EnvStore(tmpDir);
  const scope = { app: 'test' };

  store.set('A', '1', scope);
  store.set('B', '2', scope);
  assert(store.get('A', scope) === '1', 'cached A');

  // Create a new store (simulates daemon restart)
  const store2 = new EnvStore(tmpDir);
  assert(store2.get('A', scope) === '1', 'reloaded A from disk');
  assert(store2.get('B', scope) === '2', 'reloaded B from disk');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('EnvStore — package meta roundtrip, isolated from registry, cleared on delete', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-pkgmeta-');
  const store = new EnvStore(tmpDir);

  store.setPackage('apps', 'foo', 'file:///x/foo/string.md');
  store.setPackageMeta('apps', 'foo', { source: '/x/foo', inPlace: true });

  const meta = store.getPackageMeta('apps', 'foo');
  assert(meta?.inPlace === true && meta?.source === '/x/foo', 'meta roundtrips');
  // Registry API is unaffected — still a plain URI string.
  assert(store.getPackage('apps', 'foo') === 'file:///x/foo/string.md', 'registry URI intact');

  // Survives a fresh store (persisted to disk).
  const store2 = new EnvStore(tmpDir);
  assert(store2.getPackageMeta('apps', 'foo')?.inPlace === true, 'meta reloaded from disk');

  // Deleting the package clears its meta in the same write.
  store2.deletePackage('apps', 'foo');
  assert(store2.getPackageMeta('apps', 'foo') === undefined, 'meta cleared on deletePackage');
  const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
  assert(cfg.packageMeta?.apps?.foo === undefined, 'meta gone from config on disk');

  fs.rmSync(tmpDir, { recursive: true });
});
