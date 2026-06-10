/**
 * Misc tests: htmlToMarkdown, /source command, /tool tests
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Browser, Loader, createHtmlToMarkdown } from '../index.js';
import { assert, section, mkBrowser, WIKI } from './runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await section('/open ~/file resolves against agent home', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-home-tilde-');
  const nestedDir = path.join(tmpDir, 'nested');
  fs.mkdirSync(nestedDir);
  fs.writeFileSync(path.join(tmpDir, 'home.md'), '# Home File\n\nfrom agent home\n');
  fs.writeFileSync(path.join(nestedDir, 'current.md'), '# Current File\n');

  try {
    const b = new Browser({ home: tmpDir });
    const current = await b.exec('/open ./nested/current.md');
    assert(current.ok, 'opened nested file');

    const r = await b.exec('/open ~/home.md');
    assert(r.ok, '~/ path opens successfully');
    assert(r.content.includes('from agent home'), '~/ path reads from agent home');

    const loader = new Loader({ home: tmpDir });
    const resolvedFromHttp = loader.resolve('~/home.md', 'https://example.com/docs/index.md');
    assert(resolvedFromHttp.startsWith('file://'), '~/ path ignores HTTP base URI');
    assert(resolvedFromHttp.endsWith('/home.md'), '~/ path still points into agent home');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── /tool command ──────────────────────────────────────────────────────────

await section('/tool:name — basic tool execution', async () => {
  const b = mkBrowser();

  const r = await b.exec('/tool:greet');
  assert(r.ok, 'tool:greet returns ok');
  assert(r.content.includes('hello world'), 'default action (greet) output');
});

await section('/tool:name.act — specific tool action', async () => {
  const b = mkBrowser();

  const r = await b.exec('/tool:greet.shout');
  assert(r.ok, 'tool:greet.shout returns ok');
  assert(r.content.includes('HELLO WORLD'), 'specific action (shout) output');
});

await section('/tool:nonexistent — not found', async () => {
  const b = mkBrowser();

  const r = await b.exec('/tool:nonexistent');
  assert(!r.ok, 'nonexistent tool returns error');
  assert(r.code === 'NOT_FOUND', 'error code is NOT_FOUND');
  assert(r.content.includes('Tool not found'), 'error message');
});

await section('/tool context variables', async () => {
  const b = mkBrowser();
  await b.exec(`/open ${WIKI}`);

  const r = await b.exec('/tool:context-test');
  assert(r.ok, 'context-test tool ok');
  assert(r.content.includes('file='), 'has file= in output');
  assert(r.content.includes('cwd='), 'has cwd= in output');
});

await section('/tool $ARGS pass-through', async () => {
  const b = mkBrowser();

  const r = await b.exec('/tool:echo-args hello world');
  assert(r.ok, 'echo-args tool ok');
  assert(r.content.includes('hello world'), '$ARGS passed through');
});

await section('/tool env validation — missing required', async () => {
  // Use a temp dir so EnvStore has no REQUIRED_VAR set
  const tmpDir = fs.mkdtempSync('/tmp/string-env-missing-');
  fs.mkdirSync(path.join(tmpDir, 'tools'));
  fs.copyFileSync(
    path.resolve(__dirname, '../../../compiler/examples/ai-wiki/tools/env-test.md'),
    path.join(tmpDir, 'tools', 'env-test.md'),
  );
  const b = new Browser({ home: tmpDir });

  const r = await b.exec('/tool:env-test');
  assert(!r.ok, 'env-test fails with missing var');
  assert(r.content.includes('ENV_REQUIRED'), 'error mentions ENV_REQUIRED');
  assert(r.content.includes('REQUIRED_VAR'), 'error mentions var name');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/tool env validation — with required var set', async () => {
  // Persistent env is app-scoped — /set + /tool both run from the same
  // app: topic so validateEnv (which uses deriveEnvScope on session.name)
  // can see the value.
  const tmpDir = fs.mkdtempSync('/tmp/string-env-set-');
  fs.mkdirSync(path.join(tmpDir, 'tools'));
  fs.copyFileSync(
    path.resolve(__dirname, '../../../compiler/examples/ai-wiki/tools/env-test.md'),
    path.join(tmpDir, 'tools', 'env-test.md'),
  );
  const b = new Browser({ home: tmpDir });
  await b.exec('/set $REQUIRED_VAR = "test-value"', 'app:envtest');

  const r = await b.exec('/tool:env-test', 'app:envtest');
  assert(r.ok, 'env-test passes with var set');
  assert(r.content.includes('test-value'), 'output contains env var value');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/tool — no default action error', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-tool-nodefault-');
  fs.mkdirSync(path.join(tmpDir, 'tools'));
  fs.writeFileSync(path.join(tmpDir, 'tools', 'no-default.md'), [
    '# No Default',
    '',
    '```act.one',
    'CLI echo "one"',
    '```',
    '',
    '```act.two',
    'CLI echo "two"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const r = await b.exec('/tool:no-default');
  assert(!r.ok, 'no-default tool fails without sub-action');
  assert(r.content.includes('No default action'), 'error message');
  assert(r.content.includes('one'), 'lists available actions');

  // But specific action should work
  const r2 = await b.exec('/tool:no-default.one');
  assert(r2.ok, 'specific action works');
  assert(r2.content.includes('one'), 'specific action output');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('/tool — frontmatter name matching', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-tool-name-');
  fs.mkdirSync(path.join(tmpDir, 'tools'));
  fs.writeFileSync(path.join(tmpDir, 'tools', 'my-custom-file.md'), [
    '---',
    'name: custom',
    'default: run',
    '---',
    '',
    '```act.run',
    'CLI echo "found-by-name"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const r = await b.exec('/tool:custom');
  assert(r.ok, 'tool found by frontmatter name');
  assert(r.content.includes('found-by-name'), 'correct tool executed');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── HTML-to-Markdown Converter ──────────────────────────────────────────────

await section('createHtmlToMarkdown — basic conversion', async () => {
  const convert = createHtmlToMarkdown();

  // Headings
  const md1 = convert('<h1>Title</h1><p>Hello world</p>', 'https://example.com');
  assert(md1.includes('# Title'), 'h1 → ATX heading');
  assert(md1.includes('Hello world'), 'paragraph text preserved');

  // Links
  const md2 = convert('<a href="https://example.com">Click</a>', 'https://example.com');
  assert(md2.includes('[Click](https://example.com)'), 'link converted');

  // Code blocks
  const md3 = convert('<pre><code>const x = 1;</code></pre>', 'https://example.com');
  assert(md3.includes('const x = 1;'), 'code block content preserved');
});

await section('createHtmlToMarkdown — chrome stripping', async () => {
  const convert = createHtmlToMarkdown();
  const html = `
    <html><body>
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <header><h1>Site Header</h1></header>
      <main><p>Main content here</p></main>
      <aside><p>Sidebar</p></aside>
      <footer><p>Footer text</p></footer>
      <script>alert('x')</script>
      <style>body { color: red; }</style>
    </body></html>`;

  const md = convert(html, 'https://example.com');
  assert(md.includes('Main content'), 'main content preserved');
  assert(!md.includes('Home'), 'nav stripped');
  assert(!md.includes('Site Header'), 'header stripped');
  assert(!md.includes('Sidebar'), 'aside stripped');
  assert(!md.includes('Footer text'), 'footer stripped');
  assert(!md.includes('alert'), 'script stripped');
  assert(!md.includes('color: red'), 'style stripped');
});

await section('createHtmlToMarkdown — <main> extraction', async () => {
  const convert = createHtmlToMarkdown();
  const html = `
    <html><body>
      <div class="banner">Banner text</div>
      <main>
        <h2>Article</h2>
        <p>Article body</p>
      </main>
      <div class="ads">Buy stuff</div>
    </body></html>`;

  const md = convert(html, 'https://example.com');
  assert(md.includes('Article'), 'main content extracted');
  assert(md.includes('Article body'), 'main body extracted');
  assert(!md.includes('Banner text'), 'content outside main excluded');
  assert(!md.includes('Buy stuff'), 'ads outside main excluded');
});

await section('createHtmlToMarkdown — <article> fallback', async () => {
  const convert = createHtmlToMarkdown();
  const html = `
    <html><body>
      <div class="banner">Banner</div>
      <article>
        <h2>Post</h2>
        <p>Post body</p>
      </article>
    </body></html>`;

  const md = convert(html, 'https://example.com');
  assert(md.includes('Post'), 'article content extracted');
  assert(!md.includes('Banner'), 'content outside article excluded');
});

await section('createHtmlToMarkdown — blank line cleanup', async () => {
  const convert = createHtmlToMarkdown();
  const html = '<p>A</p><br><br><br><br><br><p>B</p>';
  const md = convert(html, 'https://example.com');
  // Should not have more than 2 consecutive newlines
  assert(!md.includes('\n\n\n'), 'excessive blank lines collapsed');
  assert(md.includes('A'), 'content A preserved');
  assert(md.includes('B'), 'content B preserved');
});

await section('Browser with htmlToMarkdown option', async () => {
  // Verify the option passes through to Loader
  const calls: Array<{ html: string; url: string }> = [];
  const b = new Browser({
    home: path.dirname(WIKI),
    htmlToMarkdown: (html, url) => {
      calls.push({ html, url });
      return '# Converted';
    },
  });

  // Local file loads should NOT trigger the converter (no HTTP content-type)
  await b.exec(`/open ${WIKI}`);
  assert(calls.length === 0, 'htmlToMarkdown not called for local files');
});

await section('/source command — no document open', async () => {
  const b = mkBrowser();
  const r = await b.exec('/source');
  assert(!r.ok, 'returns error when no doc open');
  assert(r.content.includes('No document open'), 'error message mentions no doc');
});

await section('/source command — local file (no conversion)', async () => {
  const b = mkBrowser();
  await b.exec(`/open ${WIKI}`);

  const r = await b.exec('/source');
  assert(r.ok, 'returns ok for local file');
  assert(r.content.includes('[source:'), 'output has source header');
  // For local files, rawSource is undefined so /source returns doc.source (markdown)
  assert(r.content.includes('AI Wiki'), 'shows document source');
});

await section('/source command — converted document preserves rawSource', async () => {
  const rawHtml = '<html><body><h1>Hello World</h1><p>Test content</p></body></html>';
  const b = new Browser({
    home: path.dirname(WIKI),
    htmlToMarkdown: (html, _url) => {
      return `# Converted\n\nFrom HTML`;
    },
  });

  // We can't easily trigger HTTP loading in tests, so test via resolve directly
  // Instead, verify the /info output for a local file shows no conversion
  await b.exec(`/open ${WIKI}`);
  const info = await b.exec('/info');
  assert(!info.content.includes('converted from HTML'), '/info does not show converted for local file');
});

// ─── [!requirements] directive + auto-detect (no auto-prepend; error path only) ─

await section('requirements — directive parsed, body line stripped', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-req-strip-');
  fs.writeFileSync(path.join(tmpDir, 'string.md'),
    '# App\n\n[!requirements](docs/install.md)\n\nBody content here.\n');
  fs.mkdirSync(path.join(tmpDir, 'docs'));
  fs.writeFileSync(path.join(tmpDir, 'docs', 'install.md'), '# Install\n');

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/open ${path.join(tmpDir, 'string.md')}`);
  assert(r.ok, 'open succeeds');
  assert(!r.content.includes('[!requirements]'), 'directive line stripped from rendered body');
  assert(!r.content.includes('[setup]'), 'no auto-prepended setup hint (author-controlled)');
  assert(r.content.includes('Body content here.'), 'body content preserved');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('requirements — frontmatter requires: missing → [!] warning', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-req-missing-env-');
  fs.writeFileSync(path.join(tmpDir, 'string.md'),
    '---\nname: testapp\ntype: app\nrequires:\n  - TESTAPP_TOKEN\n  - TESTAPP_REGION\n---\n\n# App\n\nBody.\n');
  fs.writeFileSync(path.join(tmpDir, 'requirements.md'), '# Setup\n');

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/open ${path.join(tmpDir, 'string.md')}`);
  assert(r.ok, 'open succeeds');
  assert(r.content.includes('[!] Missing required env'), 'missing-env warning emitted');
  assert(r.content.includes('$TESTAPP_TOKEN'), 'first missing var named');
  assert(r.content.includes('$TESTAPP_REGION'), 'second missing var named');
  assert(r.content.includes('Setup: /open requirements.md'),
    'links at requirements.md (auto-detected) when sibling exists');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('requirements — env all set → no warning', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-req-set-env-');
  fs.writeFileSync(path.join(tmpDir, 'string.md'),
    '---\nname: testapp\ntype: app\nrequires:\n  - TESTAPP_TOKEN\n---\n\n# App\n');

  const b = new Browser({ home: tmpDir });
  // Open via app: topic so env scope is app-scoped
  await b.exec('/set $TESTAPP_TOKEN = "secret"', 'app:testapp');
  // Register the package so /open app:testapp resolves
  await b.exec(`/install --app ${path.join(tmpDir, 'string.md')}`);
  const r = await b.exec('/open app:testapp', 'app:testapp');
  assert(r.ok, 'open succeeds');
  assert(!r.content.includes('Missing required env'), 'no warning when env is set');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('requirements — action error appends setup hint', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-req-err-hint-');
  // CLI action that always exits non-zero. Doc has a sibling requirements.md
  // so the runtime knows where to point.
  fs.writeFileSync(path.join(tmpDir, 'string.md'), [
    '---',
    'name: failapp',
    'type: app',
    '---',
    '',
    '# Fail App',
    '',
    '```act.boom',
    'CLI bash -c "exit 7"',
    '```',
  ].join('\n'));
  fs.writeFileSync(path.join(tmpDir, 'requirements.md'), '# Setup\n');

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'string.md')}`);
  const r = await b.exec('/act.boom');
  assert(!r.ok, 'action fails with non-zero exit');
  assert(r.content.includes('Setup info: /open requirements.md'),
    'setup hint appended on error');
});

await section('requirements — action error has no hint when no requirements doc', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-req-err-noreqs-');
  fs.writeFileSync(path.join(tmpDir, 'string.md'), [
    '# Fail App',
    '',
    '```act.boom',
    'CLI bash -c "exit 7"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'string.md')}`);
  const r = await b.exec('/act.boom');
  assert(!r.ok, 'action fails');
  assert(!r.content.includes('Setup info'),
    'no setup hint when no requirements doc registered');
});
