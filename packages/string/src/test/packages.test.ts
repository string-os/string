/**
 * Package tests: registry, /install, /uninstall, resolveTool,
 * /info app/file topic, installed app open
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Browser, EnvStore } from '../index.js';
import { assert, section, mkBrowser, WIKI } from './runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Package Registry (EnvStore) ─────────────────────────────────────────────

await section('EnvStore — package registry CRUD', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-registry-');
  const store = new EnvStore(tmpDir);

  // Initially empty
  assert(store.getPackage('apps', 'weather') === undefined, 'getPackage returns undefined for unset');
  assert(Object.keys(store.listPackages('apps')).length === 0, 'listPackages empty initially');

  // Set
  store.setPackage('apps', 'weather', 'file:///path/to/weather/index.md');
  assert(store.getPackage('apps', 'weather') === 'file:///path/to/weather/index.md', 'getPackage returns set value');

  store.setPackage('tools', 'translate', 'file:///path/to/translate/index.md');
  assert(store.getPackage('tools', 'translate') === 'file:///path/to/translate/index.md', 'tools registry works');

  // List
  const apps = store.listPackages('apps');
  assert(apps.weather === 'file:///path/to/weather/index.md', 'listPackages includes app');
  assert(Object.keys(apps).length === 1, 'listPackages correct count');

  // Delete
  assert(store.deletePackage('apps', 'weather'), 'deletePackage returns true');
  assert(store.getPackage('apps', 'weather') === undefined, 'deleted package is gone');
  assert(!store.deletePackage('apps', 'weather'), 'deletePackage non-existent returns false');

  // Verify tools not affected
  assert(store.getPackage('tools', 'translate') !== undefined, 'tools unaffected by apps delete');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('EnvStore — registry preserves env section', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-registry-preserve-');
  const store = new EnvStore(tmpDir);

  // Set an env var first
  store.set('API_KEY', 'secret123');
  // Then set a package
  store.setPackage('apps', 'myapp', 'file:///app.md');

  // Verify both sections present
  const configPath = path.join(tmpDir, '.string', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  assert(config.env.API_KEY === 'secret123', 'env section preserved after setPackage');
  assert(config.apps.myapp === 'file:///app.md', 'apps section present');

  // And the reverse: setting env preserves apps
  store.set('NEW_VAR', 'val');
  const config2 = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  assert(config2.apps.myapp === 'file:///app.md', 'apps section preserved after set env');
  assert(config2.env.NEW_VAR === 'val', 'new env var added');

  fs.rmSync(tmpDir, { recursive: true });
});

// ─── /install, /uninstall Commands ───────────────────────────────────────────

await section('/install --tool — local .md file', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-install-tool-');
  const toolSource = path.join(tmpDir, 'greet.md');
  fs.writeFileSync(toolSource, [
    '---',
    'name: greet',
    'type: tool',
    'default: greet',
    '---',
    '',
    '```act.greet',
    'CLI echo "hello"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/install --tool ${toolSource}`);
  assert(r.ok, 'install ok');
  assert(r.content.includes('Installed tool:greet'), 'output shows installed type:name');
  assert(r.content.includes('/tool:greet'), 'output shows use hint');

  // Verify file was copied
  const installedPath = path.join(tmpDir, '.string', 'packages', 'greet', 'index.md');
  assert(fs.existsSync(installedPath), 'file copied to packages dir');

  // Verify registered in config.json
  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, '.string', 'config.json'), 'utf-8'));
  assert(typeof config.tools?.greet === 'string', 'registered in config.json tools');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/install --app — local .md file', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-install-app-');
  const appSource = path.join(tmpDir, 'weather.md');
  fs.writeFileSync(appSource, [
    '---',
    'name: weather',
    'type: app',
    'default: fetch',
    '---',
    '# Weather App',
    '',
    '```act.fetch',
    'GET https://api.example.com/weather',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/install --app ${appSource}`);
  assert(r.ok, 'install app ok');
  assert(r.content.includes('Installed app:weather'), 'output shows app:weather');
  assert(r.content.includes('/open app:weather'), 'output shows app use hint');

  // Verify registered
  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, '.string', 'config.json'), 'utf-8'));
  assert(typeof config.apps?.weather === 'string', 'registered in config.json apps');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/install — auto type from frontmatter', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-install-auto-');
  const toolSource = path.join(tmpDir, 'translator.md');
  fs.writeFileSync(toolSource, [
    '---',
    'name: translator',
    'type: tool',
    '---',
    '# Translator',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/install ${toolSource}`);
  assert(r.ok, 'install auto type ok');
  assert(r.content.includes('tool:translator'), 'auto-detected as tool from frontmatter');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/install — no args, current doc as source', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-install-current-');
  const docPath = path.join(tmpDir, 'myutil.md');
  fs.writeFileSync(docPath, [
    '---',
    'name: myutil',
    'type: tool',
    'default: run',
    '---',
    '# My Util',
    '',
    '```act.run',
    'CLI echo "util running"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${docPath}`);

  // /install with no source → installs current document
  const r = await b.exec('/install');
  assert(r.ok, 'install current doc ok');
  assert(r.content.includes('tool:myutil'), 'detected as tool from current doc');

  // Verify registered
  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, '.string', 'config.json'), 'utf-8'));
  assert(typeof config.tools?.myutil === 'string', 'registered in tools');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/install --app — no source, current doc', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-install-current-app-');
  const docPath = path.join(tmpDir, 'dashboard.md');
  fs.writeFileSync(docPath, [
    '---',
    'name: dashboard',
    '---',
    '# Dashboard',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${docPath}`);

  // No type in frontmatter, but --app flag
  const r = await b.exec('/install --app');
  assert(r.ok, 'install --app current doc ok');
  assert(r.content.includes('app:dashboard'), 'installed as app');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/install — no source, no doc open → error', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-install-nodoc-');
  const b = new Browser({ home: tmpDir });

  const r = await b.exec('/install');
  assert(!r.ok, 'install with no source and no doc fails');
  assert(r.content.includes('No source specified'), 'error message correct');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/install — type missing → error with hint', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-install-notype-');
  const source = path.join(tmpDir, 'noname.md');
  fs.writeFileSync(source, [
    '---',
    'name: mystery',
    '---',
    '# No type',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/install ${source}`);
  assert(!r.ok, 'install without type fails');
  assert(r.content.includes('Cannot determine package type'), 'error mentions type');
  assert(r.content.includes('--app'), 'error suggests --app');
  assert(r.content.includes('--tool'), 'error suggests --tool');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/uninstall — removes package', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-uninstall-');
  const toolSource = path.join(tmpDir, 'bye.md');
  fs.writeFileSync(toolSource, [
    '---',
    'name: bye',
    'type: tool',
    '---',
    '```act.bye',
    'CLI echo bye',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  // Install first
  const r1 = await b.exec(`/install --tool ${toolSource}`);
  assert(r1.ok, 'install ok');

  // Uninstall
  const r2 = await b.exec('/uninstall bye');
  assert(r2.ok, 'uninstall ok');
  assert(r2.content.includes('Uninstalled tool:bye'), 'uninstall output correct');

  // Verify removed from registry
  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, '.string', 'config.json'), 'utf-8'));
  assert(config.tools?.bye === undefined, 'removed from registry');

  // Verify files deleted
  const packagesDir = path.join(tmpDir, '.string', 'packages', 'bye');
  assert(!fs.existsSync(packagesDir), 'package directory removed');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/uninstall — not found', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-uninstall-nf-');
  const b = new Browser({ home: tmpDir });

  const r = await b.exec('/uninstall nonexistent');
  assert(!r.ok, 'uninstall non-existent fails');
  assert(r.content.includes('Package not found'), 'error message correct');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('resolveTool — registry fallback', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-resolve-tool-');

  // Install a tool into registry (manually to avoid needing the command)
  const pkgDir = path.join(tmpDir, '.string', 'packages', 'greeter');
  fs.mkdirSync(pkgDir, { recursive: true });
  const toolContent = [
    '---',
    'name: greeter',
    'type: tool',
    'default: greet',
    '---',
    '',
    '```act.greet',
    'CLI echo "hello from registry"',
    '```',
  ].join('\n');
  fs.writeFileSync(path.join(pkgDir, 'index.md'), toolContent);

  // Register in config.json
  const configDir = path.join(tmpDir, '.string');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    tools: { greeter: `file://${path.join(pkgDir, 'index.md')}` },
  }, null, 2));

  const b = new Browser({ home: tmpDir });

  // /tool:greeter should resolve via registry
  const r = await b.exec('/tool:greeter --');
  assert(r.ok, 'tool resolved from registry');
  assert(r.content.includes('hello from registry'), 'tool output correct');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/info — app topic shows logical name, hides path', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-info-app-');

  // Create installed app with full metadata
  const pkgDir = path.join(tmpDir, '.string', 'packages', 'weather');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'index.md'), [
    '---',
    'name: "@string/weather"',
    'title: Weather App',
    'version: 1.2.0',
    'type: app',
    '---',
    '# Weather',
  ].join('\n'));
  const configDir = path.join(tmpDir, '.string');
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    apps: { weather: `file://${path.join(pkgDir, 'index.md')}` },
  }, null, 2));

  const b = new Browser({ home: tmpDir });
  await b.exec('/open weather', 'app:weather');
  const info = await b.exec('/info', 'app:weather');
  assert(info.ok, 'info ok');
  assert(info.content.includes('app:       weather'), 'shows app: weather');
  assert(info.content.includes('name:      @string/weather'), 'shows full name');
  assert(info.content.includes('version:   1.2.0'), 'shows version');
  assert(!info.content.includes('.string/packages'), 'hides internal path');
  assert(!info.content.includes('cwd:'), 'no cwd for app topic');
  assert(info.content.includes('Weather App'), 'title shown');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/info — file topic shows path and cwd', async () => {
  const b = mkBrowser();
  await b.exec(`/open ${WIKI}`);
  const info = await b.exec('/info');
  assert(info.ok, 'info ok');
  assert(info.content.includes('file:'), 'shows file:');
  assert(info.content.includes('cwd:'), 'shows cwd');
});

await section('installed app — /open bare name', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-open-app-');

  // Create an app file in packages
  const pkgDir = path.join(tmpDir, '.string', 'packages', 'myapp');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'index.md'), [
    '---',
    'name: myapp',
    'type: app',
    '---',
    '# My App',
    'Welcome to my app.',
  ].join('\n'));

  // Register
  const configDir = path.join(tmpDir, '.string');
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    apps: { myapp: `file://${path.join(pkgDir, 'index.md')}` },
  }, null, 2));

  const b = new Browser({ home: tmpDir });
  const r = await b.exec('/open myapp');
  assert(r.ok, 'open installed app ok');
  assert(r.content.includes('My App'), 'app content shown');

  fs.rmSync(tmpDir, { recursive: true });
});
