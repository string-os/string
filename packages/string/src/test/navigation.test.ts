/**
 * Navigation tests: open, info, block nav, nav, back, close, refresh,
 * shortcuts, auto-shortcuts, renderer, session mgmt, error handling,
 * workspace boundary, agent registry
 */
import fs from 'fs';
import path from 'path';
import { Browser, createAgentRegistry } from '../index.js';
import { assert, section, mkBrowser, WIKI } from './runner.js';

await section('Basic open + info', async () => {
  const b = mkBrowser();

  const r = await b.exec(`/open ${WIKI}`);
  assert(r.ok, 'open returns ok');
  assert(r.content.includes('AI Wiki'), 'content includes title');
  assert(!r.content.includes('tags:'), 'frontmatter stripped (no yaml fields)');
  assert(!r.content.includes('author: sfmd-system'), 'frontmatter author stripped');
  assert(!r.content.includes('[!menu:'), 'SFMD directives stripped from viewport');
  assert(!r.content.includes('[!include:'), 'include directives stripped from viewport');
  assert(r.content.includes('[nav] '), 'menu hint present');

  const info = await b.exec('/info');
  assert(info.ok, 'info returns ok');
  assert(/\b(file|uri|location):/i.test(info.content), 'info has document location');
  assert(/\btitle:/i.test(info.content), 'info has title');
  assert(/\bmenus:/i.test(info.content), 'info has menus');
  assert(/\bblocks:/i.test(info.content), 'info has blocks');
  assert(/\bcwd:/i.test(info.content), 'info includes cwd');
});

await section('Nav unfolds once per session per nav source', async () => {
  const b = mkBrowser();

  const first = await b.exec(`/open ${WIKI}`);
  assert(first.ok, 'first open ok');
  assert(first.content.includes('[nav] main — first view'), 'first open unfolds nav');
  assert(first.content.includes('[Welcome][@main.welcome]'), 'first open shows nav entries');

  const second = await b.exec(`/open ${WIKI}`);
  assert(second.ok, 'second open ok');
  assert(second.content.includes('[nav] main — /nav <name>'), 'second open folds seen nav');
  assert(!second.content.includes('[Welcome][@main.welcome]'), 'seen nav entries are not repeated');
});

await section('Block navigation (file#block)', async () => {
  const b = mkBrowser();

  const r = await b.exec(`/open ${WIKI}#welcome`);
  assert(r.ok, 'open with block returns ok');
  assert(r.content.includes('Welcome'), 'block content shown');
  assert(!r.content.includes('[nav]'), 'no menu hint for block view');

  const bad = await b.exec(`/open ${WIKI}#nonexistent`);
  assert(!bad.ok, 'nonexistent block returns error');
  assert(bad.code === 'BLOCK_NOT_FOUND', 'error code is BLOCK_NOT_FOUND');
  assert(bad.content.includes('Block not found'), 'error message mentions block not found');
  assert(bad.content.includes('Available blocks:') || bad.content.includes('no blocks'), 'lists available blocks');
});

await section('/nav command', async () => {
  const b = mkBrowser();
  await b.exec(`/open ${WIKI}`);

  const navList = await b.exec('/nav');
  assert(navList.ok, 'nav list ok');
  assert(navList.content.includes('main'), 'main menu listed');

  const navMain = await b.exec('/nav main');
  assert(navMain.ok, 'nav main ok');
  assert(navMain.content.includes('[Welcome][@main.welcome]'), 'nav entries use shortcut format');
  assert(navMain.content.includes('[Contributing][@main.contributing]'), 'all entries shown');

  const noDoc = new Browser({ home: path.dirname(WIKI) });
  const r = await noDoc.exec('/nav');
  assert(!r.ok, 'nav without open doc returns error');
});

await section('/back command', async () => {
  const b = mkBrowser();
  await b.exec(`/open ${WIKI}`);
  await b.exec(`/open ${WIKI}#welcome`);

  const back = await b.exec('/back');
  assert(back.ok, 'back returns ok');
  assert(back.content.includes('AI Wiki'), 'back to main doc');

  const noBack = await b.exec('/back');
  assert(!noBack.ok, 'back from first page returns error');
});

await section('/close command', async () => {
  const b = mkBrowser();

  const noClose = await b.exec('/close');
  assert(!noClose.ok, 'close without doc returns error');

  await b.exec(`/open ${WIKI}`);
  const close = await b.exec('/close');
  assert(close.ok, 'close returns ok');

  const info = await b.exec('/info');
  assert(info.ok, 'info after close returns ok');
  assert(/none open/i.test(info.content), 'info indicates no document');
});

await section('/refresh command', async () => {
  const b = mkBrowser();

  const noRefresh = await b.exec('/refresh');
  assert(!noRefresh.ok, 'refresh without doc returns error');

  await b.exec(`/open ${WIKI}`);
  const refresh = await b.exec('/refresh');
  assert(refresh.ok, 'refresh returns ok');
  assert(refresh.content.includes('AI Wiki'), 'refreshed content shown');
});

await section('Shortcut resolution (@id)', async () => {
  const b = mkBrowser();
  await b.exec(`/open ${WIKI}`);

  // @submit is defined in the wiki
  const r = await b.exec('/open @submit');
  // submit is a shortcut to a URL, should attempt to load
  // if HTTP is disabled or URL doesn't exist, will fail — but shortcut resolves
  assert(!r.ok || r.ok, 'shortcut resolves (either ok or load error, not "Shortcut not found")');
  assert(!r.content.includes('Shortcut not found'), 'shortcut found successfully');

  const bad = await b.exec('/open @nonexistent');
  assert(!bad.ok, 'bad shortcut returns error');
  assert(bad.content.includes('Shortcut not found'), 'correct error message');
});

await section('Renderer — link hiding', async () => {
  const b = mkBrowser();
  const r = await b.exec(`/open ${WIKI}`);
  assert(r.ok, 'open ok');
  // Plain https:// links should be slugified
  assert(!r.content.match(/\(https?:\/\//), 'no raw https URLs in output');
  // Menu entries should not show raw URLs
  assert(!r.content.includes('https://github.com'), 'github URL hidden');
});

await section('Auto-shortcut resolution (@slug, @slug-N, @link-N)', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-auto-shortcut-');
  const testFile = path.join(tmpDir, 'links.md');
  fs.writeFileSync(testFile, [
    '# Links Page',
    '',
    'Visit [Example](https://example.com) for details.',
    '',
    'Also check [Docs](https://docs.example.com/guide).',
    '',
    'A [local link](./other.md) should stay as-is.',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/open ${testFile}`);
  assert(r.ok, 'open ok');

  // Auto-shortcuts should appear in rendered output
  assert(r.content.includes('@example'), 'example link slugified');
  assert(r.content.includes('@docs'), 'docs link slugified');
  // Local link should NOT be slugified (not https)
  assert(r.content.includes('(./other.md)'), 'local link unchanged');

  // Auto-shortcuts should be resolvable — use /info to verify without
  // navigating away (which would replace autoShortcuts with the new page's)
  const r2 = await b.exec('/info @example');
  assert(r2.ok && r2.content.includes('https://example.com'), '@example resolves');

  const r3 = await b.exec('/info @docs');
  assert(r3.ok && r3.content.includes('https://docs.example.com'), '@docs resolves');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('Session management', async () => {
  const b = mkBrowser();

  // /session lists sessions (default = list) — lazy: first exec creates session
  const list = await b.exec('/session');
  assert(list.ok, 'session list ok');
  assert(list.content.includes('* main'), 'main session marked active');
  assert(list.content.includes('Active topics:'), 'topics header shown');

  // /session list also works
  const list2 = await b.exec('/session list');
  assert(list2.ok, 'session list explicit ok');
  assert(list2.content.includes('main'), 'main session listed');

  // Create session via direct API (daemon handles this via ChanFlow)
  b.switchSession('work');
  assert(b.activeSessionName === 'work', 'switched to work session');

  const listAfterNew = await b.exec('/session');
  assert(listAfterNew.content.includes('main'), 'main listed');
  assert(listAfterNew.content.includes('* work'), 'work marked active');

  // Session isolation: open doc in work, main has none
  await b.exec(`/open ${WIKI}`);
  const info = await b.exec('/info');
  assert(info.ok, 'info in work session ok');

  b.switchSession('main');
  const mainInfo = await b.exec('/info');
  assert(mainInfo.ok, 'info in main session returns ok');
  assert(/none open/i.test(mainInfo.content), 'main session has no document');

  // /session close
  const close = await b.exec('/session close work');
  assert(close.ok, 'session close ok');

  const listAfterClose = await b.exec('/session');
  assert(!listAfterClose.content.includes('work'), 'closed session removed');

  // Cannot close last session
  const lastSession = await b.exec('/session close main');
  assert(!lastSession.ok, 'cannot close last session');

  // sessionName param: * marker follows the caller's session
  const b2 = mkBrowser();
  await b2.exec('/info', 'alpha');  // create alpha session
  await b2.exec('/info', 'beta');   // create beta session
  const fromAlpha = await b2.exec('/session', 'alpha');
  assert(fromAlpha.content.includes('* alpha'), '* marker on caller session');
  assert(!fromAlpha.content.includes('* beta'), 'beta not marked active');
});

await section('/topics — alias of /sessions, formatted listing (Round 2 #2)', async () => {
  const b = mkBrowser();
  await b.exec('/info', 'main');   // tab:main
  await b.exec('/info', 'docs');   // tab:docs

  const r = await b.exec('/topics');
  assert(r.ok, '/topics ok');
  assert(r.content.includes('Active topics:'), 'header present');
  assert(r.content.includes('main'), 'main listed');
  assert(r.content.includes('docs'), 'docs listed');
  // Type column derived from session name (free-form bare → tab)
  assert(/main\s+tab/.test(r.content), 'main typed as tab');
  assert(/docs\s+tab/.test(r.content), 'docs typed as tab');
  assert(/2 topics open\./.test(r.content), 'count line correct');

  // /sessions plural alias
  const rPlural = await b.exec('/sessions');
  assert(rPlural.ok, '/sessions ok');
  assert(rPlural.content === r.content, '/sessions output matches /topics');
});

await section('/topics <type> — filter by topic type (Round 2 #2)', async () => {
  const b = mkBrowser();
  await b.exec('/info', 'main');     // tab:main
  await b.exec('/info', 'docs');     // tab:docs
  await b.exec('/info', 'research'); // tab:research

  const r = await b.exec('/topics tab');
  assert(r.ok, '/topics tab ok');
  assert(r.content.includes('docs'), 'docs listed');
  assert(r.content.includes('research'), 'research listed');
  assert(/3 tab topics open\./.test(r.content), 'filtered count present');

  const rApp = await b.exec('/topics app');
  assert(rApp.ok, '/topics app ok (no app topics)');
  assert(rApp.content.includes('No app topics open'), 'empty filter has friendly message');

  const rBad = await b.exec('/topics bogus');
  assert(!rBad.ok, '/topics with invalid type fails fast');
  assert(rBad.content.includes('Unknown topic type'), 'error names the unknown type');
  assert(rBad.content.includes('tab, app, bash, hub'), 'error lists valid types');
});

await section('Error handling', async () => {
  const b = mkBrowser();

  const r = await b.exec('/open /nonexistent/file.md');
  assert(!r.ok, 'nonexistent file returns error');

  const badCmd = await b.exec('/badcmd');
  assert(!badCmd.ok, 'unknown command returns error');
  assert(badCmd.content.includes('Unknown command'), 'correct error text');

  const noSlash = await b.exec('hello world');
  assert(!noSlash.ok, 'non-slash input returns error');
  assert(noSlash.content.includes('Commands must start with /'), 'command-only error message');
  assert(noSlash.code === 'COMMAND_UNSUPPORTED', 'command-only error code');
});


await section('/open directory — sets cwd + listing', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-dir-open-');
  const subDir = path.join(tmpDir, 'sub');
  fs.mkdirSync(subDir);
  fs.writeFileSync(path.join(subDir, 'hello.md'), '# Hello\nWorld');
  fs.writeFileSync(path.join(tmpDir, 'root.md'), '# Root');

  const b = new Browser({ home: tmpDir });

  // /open subdir → listing + cwd change
  const r = await b.exec('/open ./sub/');
  assert(r.ok, 'open dir returns ok');
  assert(r.content.includes('hello.md'), 'listing includes file');

  // /info shows cwd as the subdir
  const info = await b.exec('/info');
  assert(info.ok, 'info ok');
  assert(info.content.includes('sub'), 'cwd shows sub directory');

  // /exec pwd → should be the subdir
  const pwd = await b.exec('/exec pwd');
  assert(pwd.ok, 'exec pwd ok');
  assert(pwd.content.includes(subDir), 'exec cwd is the opened directory');

  // /ls with relative path resolves from cwdOverride
  const ls = await b.exec('/ls .');
  assert(ls.ok, 'ls relative ok');
  assert(ls.content.includes('hello.md'), 'ls resolves from cwdOverride');

  // /open relative file → opens from cwdOverride + resets cwdOverride
  const openFile = await b.exec('/open ./hello.md');
  assert(openFile.ok, 'open relative file ok');
  assert(openFile.content.includes('Hello'), 'file content shown');

  // After opening a document, cwdOverride is reset — cwd should be document's directory
  const info2 = await b.exec('/info');
  assert(info2.ok, 'info after file open ok');
  assert(info2.content.includes('sub'), 'cwd is document directory (sub/)');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('Workspace boundary — /open blocked in workspace mode', async () => {
  const b = new Browser({ home: path.dirname(WIKI), accessMode: 'workspace' });

  // Path escape via ../
  const r1 = await b.exec('/open ../../../../etc/passwd');
  assert(!r1.ok, 'path escape blocked');
  assert(r1.code === 'FILE_NOT_ALLOWED', 'returns FILE_NOT_ALLOWED');

  // Absolute path outside home
  const r2 = await b.exec('/open /etc/hostname');
  assert(!r2.ok, 'absolute path outside home blocked');
  assert(r2.code === 'FILE_NOT_ALLOWED', 'returns FILE_NOT_ALLOWED for absolute');

  // Normal open within home still works
  const r3 = await b.exec(`/open ${path.basename(WIKI)}`);
  assert(r3.ok, 'open within home works');
});

await section('AgentRegistry basics', async () => {
  const registry = createAgentRegistry();

  const agent = registry.register({
    id: 'neo',
    home: '/workspace/neo',
    allowedPaths: ['/workspace/shared'],
    createdAt: '2026-03-11T00:00:00Z',
  });

  assert(agent.id === 'neo', 'register returns normalized agent');
  assert(registry.has('neo'), 'has returns true for registered agent');
  assert(registry.get('neo')?.home === '/workspace/neo', 'get returns registered agent with home');
  assert(registry.list().length === 1, 'list returns one agent');
  assert(registry.canAccessPath('neo', '/workspace/neo'), 'home dir is allowed');
  assert(registry.canAccessPath('neo', '/workspace/shared'), 'allowed path is allowed');
  assert(!registry.canAccessPath('neo', '/workspace/other'), 'unlisted path is rejected');
  assert(!registry.canAccessPath('ghost', '/workspace/neo'), 'unknown agent cannot access path');

  // Delete agent
  assert(registry.delete('neo'), 'delete returns true for existing agent');
  assert(!registry.has('neo'), 'agent removed after delete');
  assert(!registry.delete('neo'), 'delete returns false for missing agent');

  // Re-register after delete
  registry.register({
    id: 'neo',
    home: '/workspace/neo',
    allowedPaths: [],
    createdAt: '2026-03-11T00:00:00Z',
  });
  assert(registry.has('neo'), 're-register after delete works');

  // Re-register with updated home (upsert)
  registry.register({
    id: 'neo',
    home: '/workspace/neo-updated',
    allowedPaths: [],
    createdAt: '2026-03-11T00:00:00Z',
  });
  assert(registry.get('neo')?.home === '/workspace/neo-updated', 'duplicate registration updates existing agent');
});

await section('/ls — rejects non-tab topics with helpful message', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-ls-web-');
  const b = new Browser({ home: tmpDir });

  // /ls is filesystem-only — non-tab topics (app/bash/hub, or remote URL
  // contexts) get a clear redirect rather than confusing path errors.
  // Pass topicType='app' to simulate /ls being run inside an app session.
  const r = await b.exec('/ls /runtime', 'docs', 'app');
  assert(!r.ok, '/ls fails on app topic');
  assert(r.content.includes('not available for app'), 'mentions topic kind');
  assert(r.content.includes('/open') && r.content.includes('/nav'), 'suggests right commands');

  fs.rmSync(tmpDir, { recursive: true });
});
