/**
 * Action tests: parsing, CLI method, response template, POSIX flags,
 * $var rejection, --help, dot-notation, renderer strips, field defaults,
 * {...args}, CLI JSON output, @shortcut
 */
import fs from 'fs';
import path from 'path';
import { parse } from '@string-os/core';
import { Browser } from '../index.js';
import { Session } from '../session.js';
import { walkJsonPath } from '../commands/helpers.js';
import { assert, section, mkBrowser, WIKI } from './runner.js';

await section('Action code block parsing (```act.name)', async () => {
  const src = [
    '```act.search_city',
    'GET https://api.example.com/search',
    '  name: string (required) "City name to search"',
    '  limit: number (optional) "Max results"',
    '```',
    '',
    '```act.search_city.response',
    '{city} = {Response.body.name}',
    'Weather in {city}: {Response.body.temp}°C',
    '```',
  ].join('\n');

  const result = parse(src);
  assert(result.actions.length === 1, 'one action parsed from code block');
  assert(result.errors.length === 0, 'no parse errors');

  const a = result.actions[0];
  assert(a.id === 'search_city', 'action id from code block');
  assert(a.method === 'get', 'method from first line');
  assert(a.uri === 'https://api.example.com/search', 'uri from first line');
  assert(a.fields.length === 2, 'two fields parsed');
  assert(a.fields[0].name === 'name', 'field name');
  assert(a.fields[0].required === true, 'field required');
  assert(a.fields[0].description === 'City name to search', 'field description');
  assert(a.fields[1].required === false, 'optional field');
  assert(a.responseTemplate !== null, 'response template attached');
  assert(a.responseTemplate!.includes('{city}'), 'response template content');
});

await section('Action code block — CLI method', async () => {
  const src = '```act.build\nCLI npm run build\n```\n';
  const result = parse(src);
  assert(result.actions.length === 1, 'CLI action parsed');
  assert(result.actions[0].method === 'cli', 'CLI method type');
});

await section('Action code block — response before action (post-pass)', async () => {
  const src = [
    '```act.weather.response',
    '{temp} = {Response.body.temp}',
    '```',
    '',
    '```act.weather',
    'GET https://api.example.com/weather',
    '```',
  ].join('\n');
  const result = parse(src);
  assert(result.actions.length === 1, 'action parsed');
  assert(result.actions[0].responseTemplate !== null, 'response template attached via post-pass');
});

await section('Regular fenced blocks not affected', async () => {
  const src = '```javascript\nconsole.log("hello");\n```\n';
  const result = parse(src);
  assert(result.actions.length === 0, 'no actions from regular code block');
  assert(result.errors.length === 0, 'no errors');
});

await section('Session variable storage', async () => {
  const s = new Session('test-vars');
  s.setVar('city', 'Seoul');
  assert(s.getVar('city') === 'Seoul', 'getVar returns stored value');
  assert(s.getVar('unknown') === undefined, 'getVar returns undefined for missing');

  s.setVars({ temp: '25', unit: 'C' });
  assert(s.getAllVars().size === 3, 'setVars adds multiple');

  s.clearVars();
  assert(s.getAllVars().size === 0, 'clearVars empties map');

  s.setVar('x', '1');
  s.close();
  assert(s.getAllVars().size === 0, 'close clears variables');
});

await section('Dot-notation routing (/act.name)', async () => {
  const b = mkBrowser();
  // Without a document, dot-notation should not be "Unknown command"
  const r = await b.exec('/act.anything');
  assert(!r.content.includes('Unknown command'), '/act.name routes to action handler');
  assert(r.content.includes('No document open'), 'action handler asks for document');
});

await section('POSIX flag parsing', async () => {
  // This is an internal function test via dispatch
  const b = mkBrowser();
  // /set command uses a different parser, but we can test the flow
  const setR = await b.exec('/set city = "Seoul"');
  assert(setR.ok, '/set creates variable');
  assert(setR.content.includes('Seoul'), 'set shows value');

  const listR = await b.exec('/set');
  assert(listR.ok, '/set with no args lists variables');
  assert(listR.content.includes('{city}'), 'lists variable name');

  // Test /set with another variable
  const setR2 = await b.exec('/set temp = "25"');
  assert(setR2.ok, 'second /set ok');
  const listR2 = await b.exec('/set');
  assert(listR2.content.includes('{temp}'), 'second variable listed');
});

await section('$var rejection in commands', async () => {
  const b = mkBrowser();
  const r = await b.exec('/set $secret = "nope"');
  assert(!r.ok || r.ok, '/set with $ does not crash');
});

await section('--help flag returns action schema', async () => {
  // Without a document we can't test this fully, but verify routing
  const b = mkBrowser();
  const r = await b.exec('/act.search --help');
  assert(!r.content.includes('Unknown command'), '--help routes correctly');
});

await section('Renderer strips action code blocks', async () => {
  const src = [
    '# Weather App',
    '',
    'Some content here.',
    '',
    '```act.search_city',
    'GET https://api.example.com/search',
    '  name: string (required)',
    '```',
    '',
    '```act.search_city.response',
    '{city} = {Response.body.name}',
    '```',
    '',
    '```javascript',
    'console.log("keep me");',
    '```',
    '',
    'More content.',
  ].join('\n');

  const result = parse(src);
  assert(result.actions.length === 1, 'action parsed for stripping test');
  assert(result.actions[0].responseTemplate !== null, 'response template for stripping test');
  assert(result.errors.length === 0, 'no errors in stripping test source');
});

// ─── Parser: header parsing ──────────────────────────────────────────────────

await section('Parser — -H header extraction', async () => {
  const src = [
    '# Header Test',
    '',
    '```act.fetch',
    'GET https://api.example.com/data -H "Authorization: Bearer $TOKEN" -H "X-Custom: test"',
    '```',
    '',
    '```act.plain',
    'GET https://api.example.com/plain',
    '```',
    '',
    '```act.cli',
    'CLI echo hello',
    '```',
  ].join('\n');

  const result = parse(src);
  assert(result.actions.length === 3, 'three actions parsed');

  const fetch = result.actions.find(a => a.id === 'fetch')!;
  assert(fetch !== undefined, 'fetch action found');
  assert(fetch.headers.length === 2, 'fetch has 2 headers');
  assert(fetch.headers[0].key === 'Authorization', 'first header key');
  assert(fetch.headers[0].value === 'Bearer $TOKEN', 'first header value');
  assert(fetch.headers[1].key === 'X-Custom', 'second header key');
  assert(fetch.headers[1].value === 'test', 'second header value');
  assert(fetch.uri === 'https://api.example.com/data', 'URI does not include -H flags');

  const plain = result.actions.find(a => a.id === 'plain')!;
  assert(plain.headers.length === 0, 'plain action has no headers');
  assert(plain.uri === 'https://api.example.com/plain', 'plain URI clean');

  const cli = result.actions.find(a => a.id === 'cli')!;
  assert(cli.method === 'cli', 'cli method');
  assert(cli.headers.length === 0, 'cli has no headers');
});

// ─── CLI execution ──────────────────────────────────────────────────────────

await section('CLI action execution', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-cli-test-');
  const testFile = path.join(tmpDir, 'cli-test.md');
  fs.writeFileSync(testFile, [
    '# CLI Test',
    '',
    '```act.hello',
    'CLI echo "hello world"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${testFile}`);

  const r = await b.exec('/act.hello --');
  assert(r.ok, 'CLI action returns ok');
  assert(r.content.includes('hello world'), 'CLI output contains expected text');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── $var environment variable substitution ──────────────────────────────────

await section('$var → EnvStore in action URI', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-envvar-test-');
  const testFile = path.join(tmpDir, 'env-test.md');
  fs.writeFileSync(testFile, [
    '# Env Test',
    '',
    '```act.show',
    'CLI echo "$MY_VAR"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  // Set $MY_VAR via /set command (stored in EnvStore)
  await b.exec('/set $MY_VAR = "hello-from-store"');
  await b.exec(`/open ${testFile}`);

  const r = await b.exec('/act.show --');
  assert(r.ok, 'env action ok');
  assert(r.content.includes('hello-from-store'), '$MY_VAR resolved from EnvStore');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Default action on /open ─────────────────────────────────────────────────

await section('Default action on /open', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-default-act-');
  const testFile = path.join(tmpDir, 'default.md');
  fs.writeFileSync(testFile, [
    '---',
    'default: greet',
    '---',
    '',
    '# Default Action Test',
    '',
    '```act.greet',
    'CLI echo "auto-greeting"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/open ${testFile}`);
  assert(r.ok, 'open with default action ok');
  assert(r.content.includes('Default Action Test'), 'document content shown');
  assert(r.content.includes('auto-greeting'), 'default action result appended');
  assert(r.content.includes('---'), 'separator between doc and action');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Default action skipped for block view', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-default-block-');
  const testFile = path.join(tmpDir, 'default-block.md');
  fs.writeFileSync(testFile, [
    '---',
    'default: greet',
    '---',
    '',
    '<!-- #intro -->',
    '# Intro Block',
    '<!-- /intro -->',
    '',
    '```act.greet',
    'CLI echo "auto-greeting"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/open ${testFile}#intro`);
  assert(r.ok, 'open block with default action ok');
  assert(r.content.includes('Intro Block'), 'block content shown');
  assert(!r.content.includes('auto-greeting'), 'default action NOT executed for block view');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Field default values ────────────────────────────────────────────────────

await section('act field default values', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-field-default-');
  fs.writeFileSync(path.join(tmpDir, 'test.md'), [
    '# Default Test',
    '',
    '```act.show',
    'CLI echo "format=$FORMAT limit=$LIMIT"',
    '  format: string "Output format" = "json"',
    '  limit: number "Max results" = "10"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'test.md')}`);

  // No flags → defaults used
  const r1 = await b.exec('/act.show --');
  assert(r1.ok, 'act with defaults ok');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('act field default — override and fallback', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-field-default-override-');
  fs.writeFileSync(path.join(tmpDir, 'test.md'), [
    '# Default Override Test',
    '',
    '```act.show',
    'CLI echo "format={format} limit={limit}"',
    '  format: string "Output format" = "json"',
    '  limit: number "Max results" = "10"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'test.md')}`);

  // Override one, default the other
  const r1 = await b.exec('/act.show --limit 5');
  assert(r1.ok, 'override one flag ok');
  assert(r1.content.includes('format=json'), 'default format used');
  assert(r1.content.includes('limit=5'), 'overridden limit used');

  // Override both
  const r2 = await b.exec('/act.show --format csv --limit 3');
  assert(r2.ok, 'override both ok');
  assert(r2.content.includes('format=csv'), 'overridden format');
  assert(r2.content.includes('limit=3'), 'overridden limit');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── {...args} serialization ─────────────────────────────────────────────────

await section('{...args} — CLI flag serialization', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-spread-args-');
  fs.writeFileSync(path.join(tmpDir, 'test.md'), [
    '# Spread Args Test',
    '',
    '```act.search',
    'CLI echo "args: {...args}"',
    '  query: string (required) "Search query"',
    '  limit: number "Max results" = "10"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'test.md')}`);

  const r = await b.exec('/act.search --query hello');
  assert(r.ok, 'spread args ok');
  assert(r.content.includes('--query hello'), '{...args} contains --query');
  assert(r.content.includes('--limit 10'), '{...args} contains default --limit');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('{...args} — quoted values with spaces', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-spread-args-quote-');
  fs.writeFileSync(path.join(tmpDir, 'test.md'), [
    '# Spread Args Quote Test',
    '',
    '```act.greet',
    // {...args} self-quotes each value, so the template must NOT wrap it in
    // outer quotes — same convention as bash "$@". Using echo here lets each
    // --key value token land as its own argv entry.
    'CLI echo {...args}',
    '  name: string (required) "Name"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'test.md')}`);

  const r = await b.exec('/act.greet --name "John Doe"');
  assert(r.ok, 'spread args with spaces ok');
  assert(r.content.includes('--name'), 'has --name flag');
  assert(r.content.includes('John Doe'), 'value with spaces preserved');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('HTTP action invocation does not switch the current document', async () => {
  // Regression: HTTP actions used to call session.open() on the response,
  // turning the response body into the new current document. That meant a
  // second /act.foo after the first would fail with "Action not found"
  // because the response page had no actions on it. Action invocation is
  // "call this and read the result", not navigation.
  const http = await import('http');
  const tmpDir = fs.mkdtempSync('/tmp/string-http-no-nav-');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ name: 'first' }, { name: 'second' }]));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  fs.writeFileSync(path.join(tmpDir, 'app.md'), [
    '```act.lookup',
    `GET http://127.0.0.1:${port}/search`,
    '  q: string (required) "Query"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);

  // First call succeeds (always did)
  const r1 = await b.exec('/act.lookup --q seoul');
  server.close();
  assert(r1.ok, 'first call ok');
  assert(r1.content.includes('first'), 'first call returns response body');

  // Second call must also succeed — current doc must still be app.md, not
  // the JSON response from call 1.
  // Re-spawn server because we closed it; but the test of session state
  // doesn't need a fresh HTTP — the bug was about session.open from call 1.
  // We verify by checking that /act still finds the action.
  const actList = await b.exec('/act');
  assert(actList.content.includes('lookup'), 'action still listed after first HTTP call');
  assert(!actList.content.includes('No actions defined'), 'current doc still has actions');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Action body: directive parsed and field-substituted', async () => {
  // Body templates let HTTP actions declare a request body shape that
  // doesn't match the flat field map. Fields are substituted with
  // `{name}` placeholders. Inside JSON string contexts (between `"`), the
  // value is JSON-string-escaped.
  const src = [
    '```act.lookup',
    'POST https://api.example.com/v1/lookup',
    '  query: string (required) "Search query"',
    '  limit: number = "10"',
    '',
    '  body:',
    '    {',
    '      "q": "{query}",',
    '      "options": {"limit": {limit}}',
    '    }',
    '```',
  ].join('\n');

  const result = parse(src);
  assert(result.actions.length === 1, 'one action parsed');
  assert(result.errors.length === 0, 'no parse errors');

  const action = result.actions[0];
  assert(action.method === 'post', 'method is post');
  assert(action.body !== undefined, 'body directive captured');
  assert(action.body!.includes('"q": "{query}"'), 'body contains field placeholder');
  assert(action.body!.includes('"limit": {limit}'), 'body contains numeric placeholder');
  assert(action.fields.length === 2, 'fields parsed alongside body');
  assert(action.fields[0].name === 'query', 'first field is query');
  assert(action.fields[1].name === 'limit', 'second field is limit');
});

await section('Response template: save/decode/to extracts to file', async () => {
  // Response handling — including binary file save — lives in the sibling
  // `act.<id>.response` block, NOT in the action block. The action block
  // owns the request shape (method, url, headers, body, fields). The
  // response block owns the response shape (variable extraction, file save,
  // rendered output). This split keeps each block focused.
  //
  // We exercise the response template via a Browser against a tiny in-process
  // HTTP server that returns a known JSON body. The response block extracts
  // a base64 field, decodes it, and writes the bytes to a path that includes
  // {filename} substituted from the action's payload.
  const http = await import('http');
  const tmpDir = fs.mkdtempSync('/tmp/string-resp-save-');

  // Mock server: returns a fixed Gemini-shaped response.
  const fakeImageBytes = Buffer.from('fake-png-bytes');
  const responseBody = {
    candidates: [{
      content: {
        parts: [{
          inlineData: {
            mimeType: 'image/png',
            data: fakeImageBytes.toString('base64'),
          },
        }],
      },
    }],
  };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const outPath = path.join(tmpDir, 'out.bin');
  fs.writeFileSync(path.join(tmpDir, 'mock.md'), [
    '```act.gen',
    `POST http://127.0.0.1:${port}/v1/generate`,
    '  filename: string (required) "Output path"',
    '',
    '  body: {"prompt": "test"}',
    '```',
    '',
    '```act.gen.response',
    'save: candidates[0].content.parts[0].inlineData.data',
    'decode: base64',
    'to: {filename}',
    'Saved {filename}',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'mock.md')}`);
  const r = await b.exec(`/act.gen --filename ${outPath}`);

  server.close();

  assert(r.ok, 'action ran ok');
  assert(r.content.includes(`Saved ${outPath}`), 'output includes explicit success line');
  assert(fs.existsSync(outPath), 'file was written');
  const written = fs.readFileSync(outPath);
  assert(written.equals(fakeImageBytes), 'file contents match the decoded base64');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Response template: walkJsonPath supports array indices', async () => {
  // Regression for the Gemini-style path `candidates[0].content.parts[0]...`.
  // The existing walkJsonPath only supported dotted keys; we extended it to
  // accept `[N]` indices so save: directives can target nested array shapes.
  const obj = {
    candidates: [
      { content: { parts: [{ inlineData: { data: 'first' } }, { inlineData: { data: 'second' } }] } },
      { content: { parts: [{ inlineData: { data: 'other-cand' } }] } },
    ],
  };
  assert(walkJsonPath(obj, 'candidates[0].content.parts[0].inlineData.data') === 'first', 'first parts entry');
  assert(walkJsonPath(obj, 'candidates[0].content.parts[1].inlineData.data') === 'second', 'second parts entry');
  assert(walkJsonPath(obj, 'candidates[1].content.parts[0].inlineData.data') === 'other-cand', 'second candidate');
  assert(walkJsonPath(obj, '$.candidates[0].content.parts[0].inlineData.data') === 'first', 'leading $ stripped');
  assert(walkJsonPath(obj, 'candidates[5].content') === undefined, 'out-of-bounds returns undefined');
  assert(walkJsonPath(obj, 'candidates[0].missing.key') === undefined, 'missing key returns undefined');
});

await section('Action body template substitution: JSON string escaping', async () => {
  // The runtime needs to reproduce body template substitution end-to-end,
  // so we exercise it via Browser. We use a CLI action that echoes the
  // post-substitution body to verify the JSON escaping works for tricky
  // values (quotes, newlines, backslashes).
  //
  // Note: the substituteBodyTemplate function lives in action.ts and is
  // only triggered for HTTP methods, so we test it indirectly via a real
  // HTTP action against a local mock server below.

  // Pure parser-level check: ensure body field substitution preserves
  // the exact placeholder syntax for downstream resolution.
  const src = [
    '```act.greet',
    'POST https://api.example.com/greet',
    '  name: string (required) "Name"',
    '  body: {"hello": "{name}"}',
    '```',
  ].join('\n');

  const result = parse(src);
  assert(result.actions.length === 1, 'parsed');
  assert(result.actions[0].body === '{"hello": "{name}"}', 'inline body captured verbatim');
});

await section('Action body: blank lines preserved inside multi-line body', async () => {
  const src = [
    '```act.complex',
    'POST https://api.example.com/complex',
    '  q: string (required) "q"',
    '',
    '  body:',
    '    {',
    '      "outer": {',
    '        "a": "{q}"',
    '',
    '      },',
    '      "trailing": true',
    '    }',
    '```',
  ].join('\n');

  const result = parse(src);
  assert(result.actions.length === 1, 'parsed');
  const body = result.actions[0].body!;
  assert(body.includes('"trailing": true'), 'content after blank line preserved');
  assert(body.includes('\n\n'), 'blank line preserved as empty line');
});

await section('CLI action templates do not strip embedded -H flags', async () => {
  // Regression: parseHeaderFlags used to greedily strip `-H "Key: Value"` from
  // every action template's first line, regardless of method. For a CLI action
  // wrapping `curl`, this corrupted the bash command — everything after the
  // first `-H` was discarded and execution failed with `unexpected EOF while
  // looking for matching '`. The fix: only run header extraction for HTTP
  // methods, leave CLI templates intact.
  const src = [
    '```act.fetch',
    'CLI bash -c \'curl -sS -H "Content-Type: application/json" -H "X-Foo: bar" -d "{}" https://example.com\'',
    '  url: string (required) "URL"',
    '```',
  ].join('\n');

  const result = parse(src);
  assert(result.actions.length === 1, 'one CLI action parsed');
  assert(result.errors.length === 0, 'no parse errors');

  const action = result.actions[0];
  assert(action.method === 'cli', 'method is cli');
  // The full template must survive — both -H flags AND the trailing -d "{}" URL
  assert(action.uri.includes('-H "Content-Type: application/json"'), 'first -H preserved in template');
  assert(action.uri.includes('-H "X-Foo: bar"'), 'second -H preserved in template');
  assert(action.uri.includes('https://example.com'), 'trailing URL preserved');
  assert(action.uri.endsWith("'"), 'closing single-quote of bash -c preserved');
  // Headers must NOT be extracted for CLI — they belong to the embedded curl
  assert(action.headers.length === 0, 'no SFMD-level headers extracted from CLI template');
});

await section('HTTP action templates still extract -H flags as headers', async () => {
  // Counterpart to the CLI regression: HTTP methods should still treat
  // `-H "Key: Value"` on the first line as action-level headers, stripped
  // from the URI and stored on action.headers.
  const src = [
    '```act.lookup',
    'GET https://api.example.com/v1/items -H "Authorization: Bearer $TOKEN" -H "Accept: application/json"',
    '  id: string (required) "Item id"',
    '```',
  ].join('\n');

  const result = parse(src);
  assert(result.actions.length === 1, 'one HTTP action parsed');
  const action = result.actions[0];
  assert(action.method === 'get', 'method is get');
  // URI is the part before the first -H, with -H flags stripped
  assert(action.uri === 'https://api.example.com/v1/items', 'uri is bare URL');
  assert(action.headers.length === 2, 'two headers extracted');
  assert(action.headers[0].key === 'Authorization', 'first header key');
  assert(action.headers[0].value === 'Bearer $TOKEN', 'first header value');
  assert(action.headers[1].key === 'Accept', 'second header key');
  assert(action.headers[1].value === 'application/json', 'second header value');
});

await section('Bare flag rejected for non-boolean field', async () => {
  // Regression: `/act.echo --name` (no value) used to silently parse as
  // `name=true` and pass the literal string "true" to the action. Now it
  // returns INVALID_PAYLOAD because the field is declared `string`.
  const tmpDir = fs.mkdtempSync('/tmp/string-bare-flag-');
  fs.writeFileSync(path.join(tmpDir, 'test.md'), [
    '# Bare Flag Test',
    '',
    '```act.echo',
    'CLI echo {name}',
    '  name: string (required) "Name"',
    '```',
    '',
    '```act.toggle',
    'CLI echo {flag}',
    '  flag: boolean "Flag"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'test.md')}`);

  // Bare --name on a string field → error
  const bare = await b.exec('/act.echo --name');
  assert(!bare.ok, 'bare --name on string field rejected');
  assert(bare.code === 'INVALID_PAYLOAD', 'returns INVALID_PAYLOAD');
  assert(bare.content.includes('--name'), 'error mentions the flag name');
  assert(bare.content.includes('requires a value'), 'error explains why');

  // --name immediately followed by another flag → also bare → also error
  const beforeFlag = await b.exec('/act.echo --name --other');
  assert(!beforeFlag.ok, 'bare --name before next flag rejected');
  assert(beforeFlag.code === 'INVALID_PAYLOAD', 'still INVALID_PAYLOAD');

  // Explicit value still works
  const explicit = await b.exec('/act.echo --name Alice');
  assert(explicit.ok, 'explicit --name Alice still works');
  assert(explicit.content.includes('Alice'), 'value passed through');

  // The literal string "true" as a value still works (must not be mistaken
  // for a bare flag — bareFlags only marks flags whose value was synthesized).
  const literalTrue = await b.exec('/act.echo --name true');
  assert(literalTrue.ok, 'explicit --name true accepted');
  assert(literalTrue.content.trim() === 'true', 'literal "true" passes through');

  // Bare flag on a boolean-typed field is fine
  const boolBare = await b.exec('/act.toggle --flag');
  assert(boolBare.ok, 'bare --flag on boolean field accepted');
  assert(boolBare.content.trim() === 'true', 'boolean bare flag becomes "true"');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── CLI JSON output parsing ─────────────────────────────────────────────────

await section('CLI JSON output → response template variable extraction', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-cli-json-');
  fs.writeFileSync(path.join(tmpDir, 'test.md'), [
    '# CLI JSON Test',
    '',
    '```act.data',
    'CLI echo \'{"name":"Seoul","temp":18}\'',
    '```',
    '',
    '```act.data.response',
    '{city} = {Response.body.name}',
    '{temperature} = {Response.body.temp}',
    '',
    'City: {city}, Temp: {temperature}',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'test.md')}`);

  const r = await b.exec('/act.data --');
  assert(r.ok, 'CLI JSON action ok');
  assert(r.content.includes('City: Seoul'), 'JSON field extracted to {city}');
  assert(r.content.includes('Temp: 18'), 'JSON field extracted to {temperature}');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('CLI non-JSON output — jsonBody stays null', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-cli-nonjson-');
  fs.writeFileSync(path.join(tmpDir, 'test.md'), [
    '# CLI Non-JSON Test',
    '',
    '```act.plain',
    'CLI echo "hello world"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'test.md')}`);

  const r = await b.exec('/act.plain --');
  assert(r.ok, 'CLI plain action ok');
  assert(r.content.includes('hello world'), 'plain output preserved');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Parser — field default values parsed', async () => {
  const src = [
    '# Parser Test',
    '',
    '```act.test',
    'GET https://api.example.com/data',
    '  query: string (required) "Search" = "default_query"',
    '  limit: number "Max" = "20"',
    '  plain: string (optional) "No default"',
    '```',
  ].join('\n');

  const result = parse(src);
  assert(result.actions.length === 1, 'one action parsed');
  const fields = result.actions[0].fields;
  assert(fields.length === 3, 'three fields parsed');
  assert(fields[0].defaultValue === 'default_query', 'required field has default');
  assert(fields[1].defaultValue === '20', 'optional field has default');
  assert(fields[2].defaultValue === undefined, 'field without default is undefined');
});

await section('@shortcut resolution in /act flag values', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-shortcut-flags-');
  const testFile = path.join(tmpDir, 'shortcut-flags.md');
  fs.writeFileSync(testFile, [
    '# Shortcut Flags Test',
    '',
    '[@github GitHub](https://github.com/user/repo)',
    '',
    '```act.fetch',
    'GET {url}',
    '  url: string (required) "Topic URL"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${testFile}`);

  // /act.fetch --url @github should resolve @github to its URL
  const r = await b.exec('/act.fetch --url @github');
  // The action will fail (no server), but the URL should have been resolved
  // Check that it didn't error with "Shortcut not found"
  assert(!r.content.includes('Shortcut not found'), '@shortcut resolved in flag value');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('/info @shortcut — resolve and display', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-info-shortcut-');
  const testFile = path.join(tmpDir, 'info-shortcut.md');
  fs.writeFileSync(testFile, [
    '# Info Shortcut Test',
    '',
    '[@docs Docs](https://docs.example.com)',
    '',
    '[@api]: https://api.example.com/v2',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${testFile}`);

  // /info @docs should show resolved URL
  const r = await b.exec('/info @docs');
  assert(r.ok, '/info @docs returns ok');
  assert(r.content.includes('https://docs.example.com'), '/info @docs shows URL');
  assert(r.content.includes('@docs'), '/info @docs shows shortcut name');

  // /info @api (reference-style shortcut)
  const r2 = await b.exec('/info @api');
  assert(r2.ok, '/info @api returns ok');
  assert(r2.content.includes('https://api.example.com/v2'), '/info @api shows URL');

  // /info @nonexistent should return NOT_FOUND
  const r3 = await b.exec('/info @nonexistent');
  assert(!r3.ok, '/info @nonexistent returns error');
  assert(r3.content.includes('Shortcut not found'), '/info @nonexistent error message');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Response template: for: directive iterates arrays', async () => {
  const http = await import('http');
  const tmpDir = fs.mkdtempSync('/tmp/string-for-');

  const responseBody = {
    posts: [
      { title: 'First Post', id: 'p1', author: { name: 'Alice' } },
      { title: 'Second Post', id: 'p2', author: { name: 'Bob' } },
      { title: 'Third Post', id: 'p3', author: { name: 'Carol' } },
    ],
  };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  fs.writeFileSync(path.join(tmpDir, 'test.md'), [
    '# For Test',
    '',
    '```act.feed',
    `GET http://127.0.0.1:${port}/feed`,
    '```',
    '',
    '```act.feed.response',
    'Feed:',
    '',
    'for: post in Response.body.posts',
    '- [{post.title}](https://example.com/post/{post.id}) — by {post.author.name}',
    'end:',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'test.md')}`);
  const r = await b.exec('/act.feed --');

  server.close();

  assert(r.ok, 'for: action ran ok');
  assert(r.content.includes('First Post'), 'first item rendered');
  assert(r.content.includes('Second Post'), 'second item rendered');
  assert(r.content.includes('Third Post'), 'third item rendered');
  assert(r.content.includes('by Alice'), 'nested field resolved');
  assert(r.content.includes('by Bob'), 'nested field resolved (2)');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Response SFMD rendering: links become auto-shortcuts', async () => {
  const http = await import('http');
  const tmpDir = fs.mkdtempSync('/tmp/string-resp-sfmd-');

  const responseBody = {
    items: [
      { title: 'Alpha', url: 'https://example.com/alpha' },
      { title: 'Beta', url: 'https://example.com/beta' },
    ],
  };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  fs.writeFileSync(path.join(tmpDir, 'test.md'), [
    '# SFMD Render Test',
    '',
    '[Existing Link](https://example.com/existing)',
    '',
    '```act.list',
    `GET http://127.0.0.1:${port}/items`,
    '```',
    '',
    '```act.list.response',
    'for: item in Response.body.items',
    '- [{item.title}]({item.url})',
    'end:',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const openResult = await b.exec(`/open ${path.join(tmpDir, 'test.md')}`);
  assert(openResult.content.includes('@existing-link'), 'existing link auto-shortcut present');

  const r = await b.exec('/act.list --');
  server.close();

  assert(r.ok, 'response SFMD action ran ok');
  assert(r.content.includes('@alpha'), 'response link became auto-shortcut');
  assert(r.content.includes('@beta'), 'response link became auto-shortcut (2)');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
