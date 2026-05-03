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
  store.setPackage('apps', 'weather', 'file:///path/to/weather/string.md');
  assert(store.getPackage('apps', 'weather') === 'file:///path/to/weather/string.md', 'getPackage returns set value');

  store.setPackage('tools', 'translate', 'file:///path/to/translate/string.md');
  assert(store.getPackage('tools', 'translate') === 'file:///path/to/translate/string.md', 'tools registry works');

  // List
  const apps = store.listPackages('apps');
  assert(apps.weather === 'file:///path/to/weather/string.md', 'listPackages includes app');
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
  const configPath = path.join(tmpDir, 'config.json');
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
  const installedPath = path.join(tmpDir, 'packages', 'greet', 'string.md');
  assert(fs.existsSync(installedPath), 'file copied to packages dir');

  // Verify registered in config.json
  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
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
  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
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
  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
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
  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
  assert(config.tools?.bye === undefined, 'removed from registry');

  // Verify files deleted
  const packagesDir = path.join(tmpDir, 'packages', 'bye');
  assert(!fs.existsSync(packagesDir), 'package directory removed');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/uninstall — closes zombie sessions (Round 2 #3a)', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-uninstall-zombie-');
  const appSource = path.join(tmpDir, 'translate.md');
  fs.writeFileSync(appSource, [
    '---',
    'name: translate',
    'type: app',
    '---',
    '',
    '# Translate',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const r1 = await b.exec(`/install --app ${appSource}`);
  assert(r1.ok, 'install ok');

  // Open the app in two sessions — both now point at the package's string.md.
  // Without cleanup, /uninstall would leave them both with stale currentUri.
  const open1 = await b.exec('/open app:translate', 'main');
  assert(open1.ok, 'open in main ok');
  const open2 = await b.exec('/open app:translate', 'tab2');
  assert(open2.ok, 'open in tab2 ok');

  // Sanity: both sessions are pointed at the package
  const sessMain = b.session('main');
  const sessTab2 = b.session('tab2');
  assert(sessMain.currentUri?.includes('packages/translate') ?? false, 'main session points at package');
  assert(sessTab2.currentUri?.includes('packages/translate') ?? false, 'tab2 session points at package');

  const r2 = await b.exec('/uninstall translate', 'main');
  assert(r2.ok, 'uninstall ok');
  assert(r2.content.includes('Closed'), `uninstall reports closed sessions: ${r2.content}`);
  assert(r2.content.includes('main') && r2.content.includes('tab2'), 'both session names listed');

  // Sessions are fully removed from /topics — not left as doc-less shells.
  // (Earlier revision called session.close() but kept the Map entry; reviewer
  // flagged the resulting zombie shells as un-cleanable.)
  const remaining = b.listSessions();
  assert(!remaining.includes('main'), `main session removed; got: ${remaining.join(', ')}`);
  assert(!remaining.includes('tab2'), `tab2 session removed; got: ${remaining.join(', ')}`);
  assert(sessMain.currentUri === null, 'previously-held main session ref is doc-closed');
  assert(sessTab2.currentUri === null, 'previously-held tab2 session ref is doc-closed');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/uninstall — leaves unrelated sessions alone (Round 2 #3a)', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-uninstall-spare-');
  const appSource = path.join(tmpDir, 'translate.md');
  fs.writeFileSync(appSource, [
    '---', 'name: translate', 'type: app', '---', '', '# Translate',
  ].join('\n'));
  const otherDoc = path.join(tmpDir, 'unrelated.md');
  fs.writeFileSync(otherDoc, '# Unrelated');

  const b = new Browser({ home: tmpDir });
  const r1 = await b.exec(`/install --app ${appSource}`);
  assert(r1.ok, 'install ok');

  const o1 = await b.exec('/open app:translate', 'pkg-tab');
  assert(o1.ok, 'open package ok');
  const o2 = await b.exec(`/open ${otherDoc}`, 'other-tab');
  assert(o2.ok, 'open unrelated ok');

  const r2 = await b.exec('/uninstall translate');
  assert(r2.ok, 'uninstall ok');

  // pkg-tab fully removed; other-tab still in the Map and still has its doc.
  const remaining = b.listSessions();
  assert(!remaining.includes('pkg-tab'), `pkg-tab removed; got: ${remaining.join(', ')}`);
  assert(remaining.includes('other-tab'), `other-tab kept; got: ${remaining.join(', ')}`);
  assert(b.session('other-tab').currentUri !== null, 'unrelated session untouched');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/open app:<missing> — fail-fast with clear error (Round 2 #3b)', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-open-missing-');
  const b = new Browser({ home: tmpDir });

  const r = await b.exec('/open app:translate');
  assert(!r.ok, 'open missing app fails');
  assert(
    r.content.includes("App 'translate' is not installed"),
    `error names the missing app: ${r.content}`
  );
  assert(
    r.content.includes('/install'),
    `error suggests /install: ${r.content}`
  );
  // Must NOT leak the literal-colon path resolution error
  assert(
    !r.content.includes('packages/translate/app:translate'),
    `error must not surface literal-colon path: ${r.content}`
  );

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/open tool:<missing> — fail-fast with clear error (Round 2 #3b)', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-open-missing-tool-');
  // Install one app so the "Installed apps:" hint isn't the empty branch
  const appSource = path.join(tmpDir, 'present.md');
  fs.writeFileSync(appSource, ['---', 'name: present', 'type: app', '---', '# Present'].join('\n'));
  const b = new Browser({ home: tmpDir });
  await b.exec(`/install --app ${appSource}`);

  const r = await b.exec('/open tool:missing');
  assert(!r.ok, 'open missing tool fails');
  assert(r.content.includes("Tool 'missing' is not installed"), `error: ${r.content}`);

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
  const pkgDir = path.join(tmpDir, 'packages', 'greeter');
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
  fs.writeFileSync(path.join(pkgDir, 'string.md'), toolContent);

  // Register in config.json
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    tools: { greeter: `file://${path.join(pkgDir, 'string.md')}` },
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
  const pkgDir = path.join(tmpDir, 'packages', 'weather');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'string.md'), [
    '---',
    'name: "@string/weather"',
    'title: Weather App',
    'version: 1.2.0',
    'type: app',
    '---',
    '# Weather',
  ].join('\n'));
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    apps: { weather: `file://${path.join(pkgDir, 'string.md')}` },
  }, null, 2));

  const b = new Browser({ home: tmpDir });
  await b.exec('/open weather', 'app:weather');
  const info = await b.exec('/info', 'app:weather');
  assert(info.ok, 'info ok');
  assert(info.content.includes('app:       weather'), 'shows app: weather');
  assert(info.content.includes('name:      @string/weather'), 'shows full name');
  assert(info.content.includes('version:   1.2.0'), 'shows version');
  assert(!info.content.includes('/packages/weather'), 'hides internal path');
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
  const pkgDir = path.join(tmpDir, 'packages', 'myapp');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'string.md'), [
    '---',
    'name: myapp',
    'type: app',
    '---',
    '# My App',
    'Welcome to my app.',
  ].join('\n'));

  // Register
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    apps: { myapp: `file://${path.join(pkgDir, 'string.md')}` },
  }, null, 2));

  const b = new Browser({ home: tmpDir });
  const r = await b.exec('/open myapp');
  assert(r.ok, 'open installed app ok');
  assert(r.content.includes('My App'), 'app content shown');

  fs.rmSync(tmpDir, { recursive: true });
});

// ─── Name Collision (P0 #3 from external review) ────────────────────────────

// Helper: build a "weather" app under namespace `ns`, return its file path.
function writeWeatherApp(dir: string, ns: string, version = '1.0.0'): string {
  const p = path.join(dir, `${ns}-weather.md`);
  fs.writeFileSync(p, [
    '---',
    'name: weather',
    `namespace: ${ns}`,
    'type: app',
    `version: ${version}`,
    '---',
    `# Weather (${ns})`,
  ].join('\n'));
  return p;
}

await section('install collision — same name, different namespace → refused with --as hint', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-collision-a-');
  const cookbookSrc = writeWeatherApp(tmpDir, 'cookbook');
  const stringhubSrc = writeWeatherApp(tmpDir, 'stringhub');

  const b = new Browser({ home: tmpDir });
  const r1 = await b.exec(`/install ${cookbookSrc}`);
  assert(r1.ok, `first install ok: ${r1.content}`);
  assert(r1.content.includes('Installed app:weather'), 'first install registered');

  // Second install with same `name: weather` but different namespace → refused
  const r2 = await b.exec(`/install ${stringhubSrc}`);
  assert(!r2.ok, `second install must fail. got: ${r2.content}`);
  assert(r2.content.includes('already installed'), 'error mentions already installed');
  assert(r2.content.includes('--as'), 'error suggests --as override');
  assert(r2.content.includes('/uninstall weather'), 'error suggests /uninstall as alternative');

  // Cookbook install must still be intact (not overwritten)
  const installed = fs.readFileSync(path.join(tmpDir, 'packages', 'weather', 'string.md'), 'utf-8');
  assert(installed.includes('namespace: cookbook'), 'first install untouched');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('install collision — re-install of same (namespace,name) is allowed', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-collision-reinstall-');
  const v1 = writeWeatherApp(tmpDir, 'cookbook', '1.0.0');

  const b = new Browser({ home: tmpDir });
  const r1 = await b.exec(`/install ${v1}`);
  assert(r1.ok, 'first install ok');

  // Bump version, write at SAME source path (simulates publisher pushing v2)
  fs.writeFileSync(v1, [
    '---',
    'name: weather',
    'namespace: cookbook',
    'type: app',
    'version: 2.0.0',
    '---',
    '# Weather (cookbook v2)',
  ].join('\n'));

  const r2 = await b.exec(`/install ${v1}`);
  assert(r2.ok, `re-install of same identity ok. got: ${r2.content}`);
  assert(r2.content.includes('Installed app:weather'), 'still installed');

  // The new content should overwrite (it's the same app upgrading)
  const installed = fs.readFileSync(path.join(tmpDir, 'packages', 'weather', 'string.md'), 'utf-8');
  assert(installed.includes('version: 2.0.0'), 'upgraded to v2');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('install --as <name> — installs colliding apps side-by-side', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-collision-as-');
  const cookbookSrc = writeWeatherApp(tmpDir, 'cookbook');
  const stringhubSrc = writeWeatherApp(tmpDir, 'stringhub');

  const b = new Browser({ home: tmpDir });
  const r1 = await b.exec(`/install ${cookbookSrc}`);
  assert(r1.ok, 'first install ok');

  // Second install under a different local name
  const r2 = await b.exec(`/install --as weather-stringhub ${stringhubSrc}`);
  assert(r2.ok, `second install with --as ok. got: ${r2.content}`);
  assert(r2.content.includes('Installed app:weather-stringhub'), 'registered under custom name');

  // Both registry entries should exist
  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
  assert(typeof config.apps?.weather === 'string', 'cookbook weather still registered');
  assert(typeof config.apps?.['weather-stringhub'] === 'string', 'stringhub registered under --as name');

  // Both package directories exist with correct content
  const cookbookContent = fs.readFileSync(path.join(tmpDir, 'packages', 'weather', 'string.md'), 'utf-8');
  const stringhubContent = fs.readFileSync(path.join(tmpDir, 'packages', 'weather-stringhub', 'string.md'), 'utf-8');
  assert(cookbookContent.includes('namespace: cookbook'), 'cookbook package intact');
  assert(stringhubContent.includes('namespace: stringhub'), 'stringhub package at custom path');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('install --as <name> — colliding --as value also detected', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-collision-as-collide-');
  const cookbookSrc = writeWeatherApp(tmpDir, 'cookbook');
  const stringhubSrc = writeWeatherApp(tmpDir, 'stringhub');

  const b = new Browser({ home: tmpDir });
  await b.exec(`/install ${cookbookSrc}`);
  // Installing stringhub with --as weather (same as already-taken name) → still refused
  const r = await b.exec(`/install --as weather ${stringhubSrc}`);
  assert(!r.ok, `--as value that already exists must also collide. got: ${r.content}`);
  assert(r.content.includes('already installed'), 'collision error fires');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('install --as — bare flag without value is rejected', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-collision-as-bare-');
  const src = writeWeatherApp(tmpDir, 'cookbook');

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/install --as ${src}`);
  // bareFlags doesn't include "as" since flag has a value (the source path).
  // But the resulting `as` would consume the source. parsePosixFlags treats
  // `--as <path>` as `as=<path>` which is what we want. The actual bare-flag
  // case is `/install --as` with no token after — usage error.
  // Here we instead verify what happens when --as eats the source token:
  // installer treats <path> as the local name and there's no source → "no doc open"
  assert(!r.ok, '--as eating the source produces a clear error');
});

// ─── Install atomicity (Round 2 #1) ─────────────────────────────────────────

await section('install — manifest with traversal path leaves no partial files', async () => {
  // Round 2 review #1: a manifest mixing a valid file (string.md) with a
  // path-traversal file (../../../etc/passwd) was rejected, but the valid
  // file already landed in packages/{name}/string.md before validation
  // tripped on the bad entry. This is a disk-hygiene + boundary-trust bug.
  // Fix: stage to packages/.{name}.tmp/, validate all paths first, then
  // atomic-rename. Failure must wipe staging and leave packages/ untouched.
  const http = await import('http');
  const tmpDir = fs.mkdtempSync('/tmp/string-atomic-install-');

  const manifest = {
    files: [
      { path: 'string.md',                content: '---\nname: atomtest\nnamespace: cookbook\ntype: app\n---\n# OK' },
      { path: '../../../etc/passwd',      content: 'pwned' },
      { path: 'lib/helper.md',            content: '# helper' },
    ],
    delivery: 'local',
  };
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manifest));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/install http://127.0.0.1:${port}/manifest.json`);
  server.close();

  assert(!r.ok, 'install must fail with traversal entry');
  assert(r.content.includes('Security violation'), 'error mentions security violation');
  assert(r.content.includes('../../../etc/passwd'), 'error names the offending path');

  // Live package directory must NOT exist (no partial bytes leaked).
  const liveDir = path.join(tmpDir, 'packages', 'atomtest');
  assert(!fs.existsSync(liveDir), `live packages/atomtest must not exist; got ${fs.existsSync(liveDir)}`);

  // Staging dir must also be cleaned up.
  const stageDir = path.join(tmpDir, 'packages', '.atomtest.tmp');
  assert(!fs.existsSync(stageDir), 'staging dir should be cleaned up');

  // Registry must NOT have it either. config.json may not exist at all if
  // no successful install ever wrote it — that's also fine.
  const cfgPath = path.join(tmpDir, 'config.json');
  const config = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) : {};
  assert(!config.apps?.atomtest, 'registry must not list a half-installed app');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('install — traversal-first ordering still leaves no partial files', async () => {
  // Reverse the order: traversal entry comes BEFORE the valid one. With the
  // old interleaved validate-write loop this also leaked, just in a different
  // way. With phase-1 validation it can't happen regardless of ordering.
  const http = await import('http');
  const tmpDir = fs.mkdtempSync('/tmp/string-atomic-install-r-');

  const manifest = {
    files: [
      { path: '/etc/passwd',     content: 'absolute-path-pwn' },
      { path: 'string.md',       content: '---\nname: atomtest2\nnamespace: cookbook\ntype: app\n---\n# OK' },
    ],
    delivery: 'local',
  };
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manifest));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/install http://127.0.0.1:${port}/manifest.json`);
  server.close();

  assert(!r.ok, 'install must fail with absolute-path entry');
  assert(r.content.includes('Security violation'), 'error mentions security violation');
  assert(!fs.existsSync(path.join(tmpDir, 'packages', 'atomtest2')), 'no live dir');
  assert(!fs.existsSync(path.join(tmpDir, 'packages', '.atomtest2.tmp')), 'no staging dir');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('install — manifest missing string.md errors with clear cause (Round 2 #4)', async () => {
  // Round 2 review #4: a manifest like {"files":[{"path":"index.md",...}]}
  // (publisher accidentally used the old name) fell through with the raw
  // JSON as the SFMD source, eventually failing with "Cannot determine
  // package type" — a misleading hint that sent users to add --app, which
  // doesn't fix anything. We now error at manifest-detection time with the
  // real cause.
  const http = await import('http');
  const tmpDir = fs.mkdtempSync('/tmp/string-manifest-no-entry-');

  const badManifest = {
    files: [
      { path: 'index.md',  content: '---\nname: oops\n---\n# Wrong name' },
      { path: 'helper.md', content: '# helper' },
    ],
    delivery: 'local',
  };
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(badManifest));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/install http://127.0.0.1:${port}/manifest.json`);
  server.close();

  assert(!r.ok, 'install must fail on missing string.md entry');
  assert(r.content.includes('missing a "string.md" entry'), `error names the real cause. got: ${r.content}`);
  // Critical: the error must NOT misdirect to package-type recovery.
  assert(!r.content.includes('Cannot determine package type'), 'no misleading "package type" message');
  assert(!r.content.includes('--app'), 'no misleading --app suggestion');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('install — successful manifest install creates live dir, removes staging', async () => {
  // Happy-path verification: when the manifest is clean, the staging dir
  // must NOT linger and the live dir must contain all files.
  const http = await import('http');
  const tmpDir = fs.mkdtempSync('/tmp/string-atomic-install-h-');

  const manifest = {
    files: [
      { path: 'string.md',     content: '---\nname: cleanapp\nnamespace: cookbook\ntype: app\n---\n# Clean' },
      { path: 'lib/util.md',   content: '# util' },
      { path: 'requirement.md', content: '# none' },
    ],
    delivery: 'local',
  };
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manifest));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/install http://127.0.0.1:${port}/manifest.json`);
  server.close();

  assert(r.ok, `install ok. got: ${r.content}`);
  const liveDir = path.join(tmpDir, 'packages', 'cleanapp');
  assert(fs.existsSync(path.join(liveDir, 'string.md')), 'string.md present');
  assert(fs.existsSync(path.join(liveDir, 'lib', 'util.md')), 'nested file present');
  assert(fs.existsSync(path.join(liveDir, 'requirement.md')), 'requirement.md present');
  assert(!fs.existsSync(path.join(tmpDir, 'packages', '.cleanapp.tmp')), 'staging cleaned');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('install collision — cross-registry (app name vs tool name)', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-collision-cross-');
  const appSrc = path.join(tmpDir, 'mything-app.md');
  fs.writeFileSync(appSrc, [
    '---', 'name: mything', 'namespace: alice', 'type: app', '---', '# App',
  ].join('\n'));
  const toolSrc = path.join(tmpDir, 'mything-tool.md');
  fs.writeFileSync(toolSrc, [
    '---', 'name: mything', 'namespace: bob', 'type: tool', '---', '# Tool',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const r1 = await b.exec(`/install ${appSrc}`);
  assert(r1.ok, 'app installed');

  // Tool with same `name: mything` would write to packages/mything/ on disk —
  // collides regardless of registry type. Refuse.
  const r2 = await b.exec(`/install ${toolSrc}`);
  assert(!r2.ok, 'cross-registry collision refused');
  assert(r2.content.includes('already installed'), 'collision message present');

  fs.rmSync(tmpDir, { recursive: true });
});
