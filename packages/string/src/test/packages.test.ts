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

// (Previously: 'EnvStore — registry preserves env section'. Removed when env
// moved out of config.json to apps/<app>/env.json — the registry and env now
// live in different files, so the preservation invariant is automatic. The
// analogous "config.json preserves other fields" test against setPackage lives
// in env-store.test.ts.)

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

await section('/install — plain web page installs as URL shortcut by default', async () => {
  const http = await import('http');
  const tmpDir = fs.mkdtempSync('/tmp/string-install-web-link-');
  let version = 'v1';
  const appSource = () => [
    '---',
    'name: webboard',
    'namespace: agentnews',
    'type: app',
    '---',
    '# Web Board',
    '',
    `Current version: ${version}`,
  ].join('\n');

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/markdown' });
    res.end(appSource());
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/finance.md`;

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${url}`);
  const install = await b.exec('/install');
  assert(install.ok, `install ok. got: ${install.content}`);
  assert(install.content.includes('Linked app:webboard'), 'output shows linked app');

  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
  assert(config.apps?.webboard === url, 'registry stores the URL, not a local file');
  assert(!fs.existsSync(path.join(tmpDir, 'packages', 'webboard')), 'no local package copy');

  version = 'v2';
  const opened = await b.exec('/open app:webboard');
  server.close();

  assert(opened.ok, `open linked app ok. got: ${opened.content}`);
  assert(opened.content.includes('Current version: v2'), 'linked app re-fetches latest source');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/install --local — plain web page snapshots into packages dir', async () => {
  const http = await import('http');
  const tmpDir = fs.mkdtempSync('/tmp/string-install-web-local-');
  const appSource = [
    '---',
    'name: websnapshot',
    'namespace: agentnews',
    'type: app',
    '---',
    '# Web Snapshot',
    '',
    'Current version: v1',
  ].join('\n');

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/markdown' });
    res.end(appSource);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/snapshot.md`;

  const b = new Browser({ home: tmpDir });
  const install = await b.exec(`/install --local ${url}`);
  server.close();

  assert(install.ok, `install ok. got: ${install.content}`);
  assert(install.content.includes('Installed app:websnapshot'), 'output shows local install');

  const installedPath = path.join(tmpDir, 'packages', 'websnapshot', 'string.md');
  assert(fs.existsSync(installedPath), 'file copied to packages dir');
  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
  assert(config.apps?.websnapshot === `file://${installedPath}`, 'registry stores local file URI');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/install — GitHub blob URL installs locally by default', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-install-github-blob-local-');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://raw.githubusercontent.com/owner/repo/main/apps/foo/string.md') {
      return new Response([
        '---',
        'name: githubblob',
        'namespace: github-test',
        'type: app',
        '---',
        '# GitHub Blob',
        '',
        '```act.run',
        'CLI echo github-blob-local',
        '```',
      ].join('\n'), { status: 200, headers: { 'Content-Type': 'text/markdown' } });
    }
    return originalFetch(input);
  }) as typeof fetch;

  try {
    const b = new Browser({ home: tmpDir });
    const install = await b.exec('/install https://github.com/owner/repo/blob/main/apps/foo/string.md');
    assert(install.ok, `install ok. got: ${install.content}`);
    assert(install.content.includes('Installed app:githubblob'), 'GitHub blob installs locally');
    assert(!install.content.includes('Linked app:githubblob'), 'GitHub blob is not linked by default');

    const installedPath = path.join(tmpDir, 'packages', 'githubblob', 'string.md');
    assert(fs.existsSync(installedPath), 'GitHub blob copied to packages dir');
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
    assert(config.apps?.githubblob === `file://${installedPath}`, 'registry stores local file URI');

    const action = await b.exec('/act.run --', 'app:githubblob');
    assert(action.ok, `local GitHub install can run CLI. got: ${action.content}`);
    assert(action.content.includes('github-blob-local'), 'CLI output returned');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true });
  }
});

await section('/install — raw GitHub URL installs locally by default', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-install-raw-github-local-');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://raw.githubusercontent.com/owner/repo/main/apps/bar/string.md') {
      return new Response([
        '---',
        'name: rawgithub',
        'namespace: github-test',
        'type: app',
        '---',
        '# Raw GitHub',
      ].join('\n'), { status: 200, headers: { 'Content-Type': 'text/markdown' } });
    }
    return originalFetch(input);
  }) as typeof fetch;

  try {
    const b = new Browser({ home: tmpDir });
    const install = await b.exec('/install https://raw.githubusercontent.com/owner/repo/main/apps/bar/string.md');
    assert(install.ok, `install ok. got: ${install.content}`);
    assert(install.content.includes('Installed app:rawgithub'), 'raw GitHub installs locally');
    assert(fs.existsSync(path.join(tmpDir, 'packages', 'rawgithub', 'string.md')), 'raw GitHub copied to packages dir');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true });
  }
});

await section('/install — --link and --local conflict', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-install-link-local-conflict-');
  const b = new Browser({ home: tmpDir });
  const r = await b.exec('/install --link --local https://example.com/app.md');
  assert(!r.ok, 'conflicting flags fail');
  assert(r.content.includes('Choose either --link or --local'), 'error explains conflict');

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

await section('/uninstall — deregisters but LEAVES files by default (S1 data-loss fix)', async () => {
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
  // Install first (source is outside packages/ → copied in, not in-place)
  const r1 = await b.exec(`/install --tool ${toolSource}`);
  assert(r1.ok, 'install ok');

  // Plain uninstall: deregister only, files must survive.
  const r2 = await b.exec('/uninstall bye');
  assert(r2.ok, 'uninstall ok');
  assert(r2.content.includes('Uninstalled tool:bye'), 'uninstall output correct');
  assert(r2.content.includes('Files left in place'), `default uninstall reports files kept: ${r2.content}`);

  // Removed from registry...
  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
  assert(config.tools?.bye === undefined, 'removed from registry');
  // ...but the files remain (the whole point of the S1 fix).
  const packagesDir = path.join(tmpDir, 'packages', 'bye');
  assert(fs.existsSync(packagesDir), 'package directory left in place on plain uninstall');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/uninstall --purge — deletes files of a copied install', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-uninstall-purge-');
  const toolSource = path.join(tmpDir, 'bye.md');
  fs.writeFileSync(toolSource, ['---', 'name: bye', 'type: tool', '---', '```act.bye', 'CLI echo bye', '```'].join('\n'));

  const b = new Browser({ home: tmpDir });
  assert((await b.exec(`/install --tool ${toolSource}`)).ok, 'install ok');
  const packagesDir = path.join(tmpDir, 'packages', 'bye');
  assert(fs.existsSync(packagesDir), 'installed dir exists');

  const r = await b.exec('/uninstall bye --purge');
  assert(r.ok, 'purge uninstall ok');
  assert(r.content.includes('Purged files'), `--purge reports deletion: ${r.content}`);
  assert(!fs.existsSync(packagesDir), 'copied package dir removed by --purge');
  // The original external source is untouched — --purge only deletes the copy.
  assert(fs.existsSync(toolSource), 'external source untouched');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/uninstall --purge — REFUSES to delete an in-place app source (the agent-message case)', async () => {
  const home = fs.mkdtempSync('/tmp/string-uninstall-inplace-');
  // Author the app directly under {home}/packages/inplaceapp/ — source IS the
  // install dir. A --purge here would destroy the author's own source.
  const appDir = path.join(home, 'packages', 'inplaceapp');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'string.md'),
    ['---', 'name: inplaceapp', 'type: app', '---', '# In-place', '```act.hi', 'CLI echo hi', '```'].join('\n'));

  const b = new Browser({ home });
  assert((await b.exec(`/install ${path.join(appDir, 'string.md')}`)).ok, 'in-place install ok');

  // provenance must record inPlace=true
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf-8'));
  assert(config.packageMeta?.apps?.inplaceapp?.inPlace === true, 'install recorded inPlace=true');

  const r = await b.exec('/uninstall inplaceapp --purge');
  assert(r.ok, 'uninstall still succeeds (deregisters)');
  assert(r.content.includes('Refused to --purge'), `--purge refused on in-place source: ${r.content}`);
  // Files MUST survive — this is the exact failure that wiped agent-message.
  assert(fs.existsSync(path.join(appDir, 'string.md')), 'in-place source NOT deleted');
  // But it is deregistered.
  const cfg2 = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf-8'));
  assert(cfg2.apps?.inplaceapp === undefined, 'deregistered from config');

  fs.rmSync(home, { recursive: true, force: true });
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

await section('install upsert — re-install of a no-namespace app overwrites (S3 fix)', async () => {
  // The exact case that forced /uninstall in the authoring loop: an app with no
  // `namespace:` frontmatter could never be re-installed (collision check needed
  // a matching namespace). It must now upsert.
  const tmpDir = fs.mkdtempSync('/tmp/string-upsert-nons-');
  const src = path.join(tmpDir, 'crew-ops.md');
  const write = (v: string) => fs.writeFileSync(src,
    ['---', 'name: crew-ops', 'type: app', '---', `# Crew ops ${v}`, '```act.hi', `CLI echo ${v}`, '```'].join('\n'));

  const b = new Browser({ home: tmpDir });
  write('v1');
  const r1 = await b.exec(`/install ${src}`);
  assert(r1.ok, `first install ok: ${r1.content}`);

  // Edit and re-install from the SAME source — must succeed, no /uninstall needed.
  write('v2');
  const r2 = await b.exec(`/install ${src}`);
  assert(r2.ok, `re-install of no-namespace app upserts: ${r2.content}`);
  const installed = fs.readFileSync(path.join(tmpDir, 'packages', 'crew-ops', 'string.md'), 'utf-8');
  assert(installed.includes('Crew ops v2'), 'installed definition updated to v2');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('install upsert — reinstall reloads an open session (S3 stale-def fix)', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-upsert-reload-');
  const src = path.join(tmpDir, 'reloadapp.md');
  const write = (v: string) => fs.writeFileSync(src,
    ['---', 'name: reloadapp', 'type: app', '---', `# Reload ${v}`].join('\n'));

  const b = new Browser({ home: tmpDir });
  write('v1');
  assert((await b.exec(`/install ${src}`)).ok, 'install ok');
  assert((await b.exec('/open app:reloadapp', 'main')).ok, 'open ok');
  assert(b.session('main').currentUri?.includes('packages/reloadapp') ?? false, 'session points at app');

  write('v2');
  const r = await b.exec(`/install ${src}`, 'other');
  assert(r.ok, 'reinstall ok');
  assert(r.content.includes('Reloaded') && r.content.includes('main'),
    `reinstall reports the reloaded session: ${r.content}`);

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

await section('Install makes app source read-only (write bits stripped, execute preserved)', async () => {
  const home = fs.mkdtempSync('/tmp/string-ro-install-');
  const src = path.join(home, 'src', 'rotest');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'string.md'), ['---','name: rotest','type: app','---','# ro','```act.go','CLI ./run.sh','```'].join('\n'));
  fs.writeFileSync(path.join(src, 'run.sh'), '#!/bin/bash\necho ran\n');
  fs.chmodSync(path.join(src, 'run.sh'), 0o755);

  const b = new Browser({ home });
  await b.exec(`/install ${path.join(src, 'string.md')}`);
  const pkg = path.join(home, 'packages', 'rotest');

  assert(!(fs.statSync(path.join(pkg, 'string.md')).mode & 0o222), 'string.md has no write bits');
  const sh = fs.statSync(path.join(pkg, 'run.sh')).mode;
  assert(!!(sh & 0o100) && !(sh & 0o222), 'executable helper keeps exec bit, loses write bit');

  assert((await b.exec('/act.go', 'app:rotest')).content.includes('ran'), 'executable helper still runs after read-only');

  // uninstall --purge + reinstall still work despite read-only files
  await b.exec('/uninstall rotest --purge');
  assert(!fs.existsSync(pkg), 'uninstall --purge removes read-only package');
  assert((await b.exec(`/install ${path.join(src, 'string.md')}`)).ok, 'reinstall over read-only works');

  fs.rmSync(home, { recursive: true, force: true });
});
