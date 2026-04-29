/**
 * EnvStore tests: CRUD, scope, deriveEnvScope, /set $VAR, $var resolve, cache
 */
import fs from 'fs';
import path from 'path';
import { Browser, EnvStore, deriveEnvScope } from '../index.js';
import { assert, section } from './runner.js';

await section('EnvStore — global get/set/delete', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-envstore-');
  const store = new EnvStore(tmpDir);

  // Initially empty
  assert(store.get('FOO') === undefined, 'get returns undefined for unset var');

  // Set
  store.set('FOO', 'bar');
  assert(store.get('FOO') === 'bar', 'get returns set value');

  // Persisted to disk
  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
  assert(config.env.FOO === 'bar', 'persisted to config.json');

  // Delete
  const deleted = store.delete('FOO');
  assert(deleted, 'delete returns true');
  assert(store.get('FOO') === undefined, 'deleted var is gone');

  // Delete non-existent
  assert(!store.delete('NOPE'), 'delete non-existent returns false');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('EnvStore — app and config scope', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-envstore-scope-');
  const store = new EnvStore(tmpDir);

  // Set at different scopes
  store.set('API_KEY', 'global-key');
  store.set('API_KEY', 'app-key', { app: 'weather' });
  store.set('API_KEY', 'config-key', { app: 'weather', config: 'korea' });
  store.set('LANG', 'ko', { app: 'weather' });

  // Resolution cascade
  assert(store.get('API_KEY') === 'global-key', 'global scope');
  assert(store.get('API_KEY', { app: 'weather' }) === 'app-key', 'app overrides global');
  assert(store.get('API_KEY', { app: 'weather', config: 'korea' }) === 'config-key', 'config overrides app');
  assert(store.get('LANG', { app: 'weather', config: 'korea' }) === 'ko', 'cascade up to app scope');
  assert(store.get('LANG') === undefined, 'app var not in global');

  // getAll merges
  const all = store.getAll({ app: 'weather', config: 'korea' });
  assert(all.API_KEY === 'config-key', 'getAll: config wins');
  assert(all.LANG === 'ko', 'getAll: app var included');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('EnvStore — config.json preserves other fields', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-envstore-preserve-');
  fs.mkdirSync(tmpDir, { recursive: true });
  // Write config with extra fields
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    theme: 'dark',
    env: { EXISTING: 'kept' },
  }, null, 2));

  const store = new EnvStore(tmpDir);
  store.set('NEW_VAR', 'hello');

  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
  assert(config.theme === 'dark', 'other config fields preserved');
  assert(config.env.EXISTING === 'kept', 'existing env vars preserved');
  assert(config.env.NEW_VAR === 'hello', 'new var added');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('deriveEnvScope — scope from session name', async () => {
  const s1 = deriveEnvScope('file:main');
  assert(s1.app === undefined && s1.config === undefined, 'file topic → empty scope');

  const s2 = deriveEnvScope('app:weather');
  assert(s2.app === 'weather' && s2.config === undefined, 'app topic → app scope');

  const s3 = deriveEnvScope('app:weather:korea');
  assert(s3.app === 'weather' && s3.config === 'korea', 'app:config → full scope');

  const s4 = deriveEnvScope('bash:dev');
  assert(s4.app === undefined, 'bash topic → empty scope');
});

await section('/set $VAR — persistent env via command', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-set-env-');
  const b = new Browser({ home: tmpDir });

  // Set a persistent $var
  const r1 = await b.exec('/set $API_KEY = "my-secret-key"');
  assert(r1.ok, 'set $var ok');
  assert(r1.content.includes('$API_KEY'), 'output shows $var name');
  assert(r1.content.includes('my-secret-key'), 'output shows value');
  assert(r1.content.includes('global'), 'shows global scope');

  // Verify persisted to disk
  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
  assert(config.env.API_KEY === 'my-secret-key', 'persisted to config.json');

  // /set with no args shows both session and env vars
  await b.exec('/set {session_var} = "temp"');
  const r2 = await b.exec('/set');
  assert(r2.ok, 'list vars ok');
  assert(r2.content.includes('{session_var}'), 'shows session var');
  assert(r2.content.includes('$API_KEY'), 'shows persistent env var');

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
  // Set via EnvStore
  await b.exec('/set $API_KEY = "resolved-value"');
  await b.exec(`/open ${path.join(tmpDir, 'test.md')}`);

  const r = await b.exec('/act.show --');
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

  store.set('A', '1');
  store.set('B', '2');
  assert(store.get('A') === '1', 'cached A');

  // Create a new store (simulates daemon restart)
  const store2 = new EnvStore(tmpDir);
  assert(store2.get('A') === '1', 'reloaded A from disk');
  assert(store2.get('B') === '2', 'reloaded B from disk');

  fs.rmSync(tmpDir, { recursive: true });
});
