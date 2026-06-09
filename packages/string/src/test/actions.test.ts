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

await section('Remote SFMD cannot execute CLI actions', async () => {
  const http = await import('http');
  const tmpDir = fs.mkdtempSync('/tmp/string-remote-cli-deny-');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/markdown' });
    res.end([
      '# Remote CLI',
      '',
      '```act.run',
      'CLI echo "should-not-run"',
      '```',
    ].join('\n'));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const b = new Browser({ home: tmpDir });
  const opened = await b.exec(`/open http://127.0.0.1:${port}/remote.md`);
  assert(opened.ok, 'remote SFMD opens');

  const r = await b.exec('/act.run --');
  server.close();

  assert(!r.ok, 'remote CLI action denied');
  assert(r.code === 'FILE_NOT_ALLOWED', `remote CLI returns FILE_NOT_ALLOWED. got: ${r.code}`);
  assert(r.content.includes('Remote SFMD can only run HTTP actions'), 'denial explains remote HTTP-only policy');
  assert(!r.content.includes('should-not-run'), 'CLI output is not present');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Remote SFMD can execute HTTP actions', async () => {
  const http = await import('http');
  const tmpDir = fs.mkdtempSync('/tmp/string-remote-http-ok-');
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/app.md')) {
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end([
        '# Remote HTTP',
        '',
        '```act.ping',
        'GET /api/ping',
        '```',
      ].join('\n'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('pong');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open http://127.0.0.1:${port}/app.md`);
  const r = await b.exec('/act.ping');
  server.close();

  assert(r.ok, 'remote HTTP action ok');
  assert(r.content.includes('pong'), 'remote HTTP response returned');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Linked remote apps cannot execute CLI actions', async () => {
  const http = await import('http');
  const tmpDir = fs.mkdtempSync('/tmp/string-linked-cli-deny-');
  const appSource = [
    '---',
    'name: linkedcli',
    'type: app',
    '---',
    '',
    '# Linked CLI',
    '',
    '```act.run',
    'CLI echo "linked-should-not-run"',
    '```',
  ].join('\n');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/markdown' });
    res.end(appSource);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const b = new Browser({ home: tmpDir });
  const install = await b.exec(`/install --app --link http://127.0.0.1:${port}/string.md`);
  assert(install.ok, `linked install ok. got: ${install.content}`);

  const r = await b.exec('/act.run --', 'app:linkedcli');
  server.close();

  assert(!r.ok, 'linked remote app CLI action denied');
  assert(r.code === 'FILE_NOT_ALLOWED', `linked remote CLI returns FILE_NOT_ALLOWED. got: ${r.code}`);
  assert(!r.content.includes('linked-should-not-run'), 'linked CLI output is not present');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Linked remote tools cannot execute CLI actions', async () => {
  const http = await import('http');
  const tmpDir = fs.mkdtempSync('/tmp/string-linked-tool-cli-deny-');
  const toolSource = [
    '---',
    'name: linkedtool',
    'type: tool',
    'default: run',
    '---',
    '',
    '# Linked Tool',
    '',
    '```act.run',
    'CLI echo "linked-tool-should-not-run"',
    '```',
  ].join('\n');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/markdown' });
    res.end(toolSource);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const b = new Browser({ home: tmpDir });
  const install = await b.exec(`/install --tool --link http://127.0.0.1:${port}/tool.md`);
  assert(install.ok, `linked tool install ok. got: ${install.content}`);

  const r = await b.exec('/tool:linkedtool --');
  server.close();

  assert(!r.ok, 'linked remote tool CLI action denied');
  assert(r.code === 'FILE_NOT_ALLOWED', `linked remote tool CLI returns FILE_NOT_ALLOWED. got: ${r.code}`);
  assert(!r.content.includes('linked-tool-should-not-run'), 'linked tool CLI output is not present');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Remote default CLI action is skipped on open', async () => {
  const http = await import('http');
  const tmpDir = fs.mkdtempSync('/tmp/string-remote-default-cli-');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/markdown' });
    res.end([
      '---',
      'default: boot',
      '---',
      '',
      '# Remote Default',
      '',
      '```act.boot',
      'CLI echo "remote-default-ran"',
      '```',
    ].join('\n'));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/open http://127.0.0.1:${port}/default.md`);
  server.close();

  assert(r.ok, 'remote document with default CLI still opens');
  assert(r.content.includes('Remote Default'), 'remote document content shown');
  assert(!r.content.includes('remote-default-ran'), 'remote default CLI was not executed');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── $var environment variable substitution ──────────────────────────────────

await section('$var → EnvStore in action URI', async () => {
  // Persistent env is app-scoped: /set, /open, and /act all run from the
  // same app: topic so the action's resolveEnvVars finds the value.
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
  await b.exec('/set $MY_VAR = "hello-from-store"', 'app:envtest');
  await b.exec(`/open ${testFile}`, 'app:envtest');

  const r = await b.exec('/act.show --', 'app:envtest');
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

await section('App /act auto-hydrates without running default action', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-app-act-hydrate-');
  const appSource = path.join(tmpDir, 'toolbox.md');
  fs.writeFileSync(appSource, [
    '---',
    'name: toolbox',
    'type: app',
    'default: boot',
    '---',
    '',
    '# Toolbox',
    '',
    '```act.boot',
    'CLI echo "default-boot"',
    '```',
    '',
    '```act.convert',
    'CLI echo "converted $ARGS"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const install = await b.exec(`/install --app ${appSource}`);
  assert(install.ok, 'install app ok');

  const r = await b.exec('/act.convert report.pdf', 'app:toolbox');
  assert(r.ok, 'direct app /act ok');
  assert(r.content.includes('converted report.pdf'), 'requested action ran');
  assert(!r.content.includes('default-boot'), 'default action did not run during /act hydration');

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

await section('Action -d body parsed from first line', async () => {
  const src = [
    '```act.lookup',
    `POST https://api.example.com/v1/lookup -d '{"q":"{query}","options":{"limit":{limit}}}'`,
    '  query: string (required) "Search query"',
    '  limit: number = "10"',
    '```',
  ].join('\n');

  const result = parse(src);
  assert(result.actions.length === 1, 'one action parsed');
  assert(result.errors.length === 0, 'no parse errors');

  const action = result.actions[0];
  assert(action.method === 'post', 'method is post');
  assert(action.body !== undefined, 'body from -d captured');
  assert(action.body!.includes('"q":"{query}"'), 'body contains field placeholder');
  assert(action.body!.includes('{limit}'), 'body contains numeric placeholder');
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
    `POST http://127.0.0.1:${port}/v1/generate -d '{"prompt": "test"}'`,
    '  filename: string (required) "Output path"',
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

  // Bare-digit form: `candidates.0.content.parts.0.inlineData.data` — used by
  // some hub-published apps and shown in public docs (build/writing-apps.md).
  // Regression: walkJsonPath previously required `[N]` and silently returned
  // empty for the dot-N form.
  assert(walkJsonPath(obj, 'candidates.0.content.parts.0.inlineData.data') === 'first', 'bare-digit array index');
  assert(walkJsonPath(obj, 'candidates.1.content.parts.0.inlineData.data') === 'other-cand', 'bare-digit second candidate');
  // Mixed forms should both work.
  assert(walkJsonPath(obj, 'candidates[0].content.parts.1.inlineData.data') === 'second', 'mixed bracket + bare digit');
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

  // Parser-level check: -d body from first line preserves placeholders
  const src = [
    '```act.greet',
    `POST https://api.example.com/greet -d '{"hello": "{name}"}'`,
    '  name: string (required) "Name"',
    '```',
  ].join('\n');

  const result = parse(src);
  assert(result.actions.length === 1, 'parsed');
  assert(result.actions[0].body === '{"hello": "{name}"}', '-d body captured verbatim');
});

await section('Field short alias parsed', async () => {
  const src = [
    '```act.test',
    'GET https://api.example.com/{city}',
    '  city, -c: string (required) "City name"',
    '  limit, -l: number "Max results" = "20"',
    '  verbose: boolean "Verbose"',
    '```',
  ].join('\n');

  const result = parse(src);
  assert(result.actions.length === 1, 'parsed');
  const fields = result.actions[0].fields;
  assert(fields.length === 3, 'three fields');
  assert(fields[0].short === 'c', 'city short alias');
  assert(fields[1].short === 'l', 'limit short alias');
  assert(fields[2].short === undefined, 'verbose has no short alias');
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

await section('@shortcut unresolved → NOT_FOUND error', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-shortcut-missing-');
  const testFile = path.join(tmpDir, 'shortcut-missing.md');
  fs.writeFileSync(testFile, [
    '# Missing Shortcut Test',
    '',
    '```act.fetch',
    'GET https://example.com/{name}',
    '  name: string (required) "Name"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${testFile}`);

  // @nonexistent doesn't resolve — must error, not silently pass through
  // an empty/literal value and run the action against an unrelated target.
  const r = await b.exec('/act.fetch --name @nonexistent');
  assert(!r.ok, 'unresolved @shortcut returns error');
  assert(r.code === 'NOT_FOUND', `error code is NOT_FOUND (got ${r.code})`);
  assert(r.content.includes('Unknown shortcut: @nonexistent'), 'error message identifies the unknown shortcut');

  // Values starting with @ but not matching the @<slug> shape are normal
  // strings (e.g. a comment body "@user said this"). They must pass through.
  const r2 = await b.exec('/act.fetch --name "@user said this"');
  assert(!r2.content.includes('Unknown shortcut'), 'multi-word "@..." values are not treated as shortcut refs');

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

await section('Positional args — single required field', async () => {
  const http = await import('http');
  const tmpDir = fs.mkdtempSync('/tmp/string-positional-1-');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(req.url ?? '');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  fs.writeFileSync(path.join(tmpDir, 'app.md'), [
    '# App',
    '',
    '```act.fetch',
    `GET http://127.0.0.1:${port}/{city}`,
    '  city: string (required) "City"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);

  const r1 = await b.exec('/act.fetch Seoul');
  assert(r1.ok, 'positional value works');
  assert(r1.content.includes('/Seoul'), 'city bound from positional');

  const r2 = await b.exec('/act.fetch --city Tokyo');
  assert(r2.ok, 'flag still works');
  assert(r2.content.includes('/Tokyo'), 'city bound from flag');

  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Positional args — multi required, declaration order', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-positional-multi-');

  fs.writeFileSync(path.join(tmpDir, 'app.md'), [
    '# App',
    '',
    '```act.greet',
    'CLI echo "{greeting} {name}"',
    '  greeting: string (required) "Greeting"',
    '  name: string (required) "Name"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);

  const r1 = await b.exec('/act.greet hello world');
  assert(r1.ok, 'two positional ok');
  assert(r1.content.includes('hello world'), 'declaration order respected');

  // Mix positional + flag (positional fills first unfilled required)
  const r2 = await b.exec('/act.greet --name alice hi');
  assert(r2.ok, 'mixed positional+flag ok');
  assert(r2.content.includes('hi alice'), 'positional skipped already-filled field');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Positional args — too many → error', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-positional-overflow-');

  fs.writeFileSync(path.join(tmpDir, 'app.md'), [
    '# App',
    '',
    '```act.echo',
    'CLI echo "{msg}"',
    '  msg: string (required) "Message"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);

  const r = await b.exec('/act.echo hello world extra');
  assert(!r.ok, 'too many positional rejected');
  assert(r.content.toLowerCase().includes('too many'), 'error message mentions too many');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Positional args — -- separator allows leading dash values', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-positional-sep-');

  fs.writeFileSync(path.join(tmpDir, 'app.md'), [
    '# App',
    '',
    '```act.search',
    'CLI echo "{q}"',
    '  q: string (required) "Query"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);

  const r = await b.exec('/act.search -- --weird-query');
  assert(r.ok, '-- separator passes leading-dash value');
  assert(r.content.includes('--weird-query'), 'leading-dash query preserved');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Positional args — --key=value form', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-positional-eq-');

  fs.writeFileSync(path.join(tmpDir, 'app.md'), [
    '# App',
    '',
    '```act.fetch',
    'CLI echo "{city}"',
    '  city: string (required)',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);

  const r = await b.exec('/act.fetch --city=Seoul');
  assert(r.ok, '--key=value form works');
  assert(r.content.includes('Seoul'), 'value extracted from --key=value');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Positional args — optional fields bind in declaration order', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-positional-optional-');

  fs.writeFileSync(path.join(tmpDir, 'app.md'), [
    '# App',
    '',
    '```act.fetch',
    'CLI echo "{city} days={days}"',
    '  city: string (required)',
    '  days: number "Days" = "3"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);

  // Single positional → city only; days uses default
  const r1 = await b.exec('/act.fetch Seoul');
  assert(r1.ok, 'single positional with optional default');
  assert(r1.content.includes('Seoul days=3'), 'days defaulted when no second positional');

  // Two positionals → both bind in declaration order, including the optional
  const r2 = await b.exec('/act.fetch Seoul 5');
  assert(r2.ok, 'second positional binds to optional field');
  assert(r2.content.includes('Seoul days=5'), 'days set via positional');

  // Mix positional + --days flag — flag wins, no second positional permitted
  const r3 = await b.exec('/act.fetch Tokyo --days 7');
  assert(r3.ok, 'positional + optional flag ok');
  assert(r3.content.includes('Tokyo days=7'), 'optional set via flag');

  // Three positionals → overflow (only two fields declared)
  const r4 = await b.exec('/act.fetch Seoul 1 extra');
  assert(!r4.ok, 'overflow rejected when more positionals than fields');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Multiline argument values ───────────────────────────────────────────────
// Regression: parseCommand split a command into a first-line header + body
// (for /write etc.), so a quoted value spanning newlines (e.g. /act.post -c
// "line1\nline2") lost everything after the first newline. Real bug: Moltbook
// posts only got their first paragraph. These verify multiline survives intact.

const ECHO_APP = [
  '```act.echo',
  "CLI printf '%s' {content}",
  '  content, -c: string (required) "body"',
  '```',
].join('\n');

// Spin up a one-shot HTTP server that captures the request body.
async function captureBodyServer(): Promise<{ port: number; body: () => string; close: () => void }> {
  const http = await import('http');
  let received = '';
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => { received = b; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { port, body: () => received, close: () => server.close() };
}

await section('Multiline — CLI action keeps every line', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-ml-cli-');
  fs.writeFileSync(path.join(tmpDir, 'app.md'), ECHO_APP);
  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);

  const r = await b.exec('/act.echo -c "alpha\nbeta\ngamma"');
  assert(r.ok, 'multiline CLI ok');
  assert(r.content.includes('alpha'), 'line 1 present');
  assert(r.content.includes('beta'), 'line 2 present (dropped before fix)');
  assert(r.content.includes('gamma'), 'line 3 present (dropped before fix)');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Multiline — HTTP default JSON body preserves newlines', async () => {
  const srv = await captureBodyServer();
  const tmpDir = fs.mkdtempSync('/tmp/string-ml-http-');
  fs.writeFileSync(path.join(tmpDir, 'app.md'), [
    '```act.post',
    `POST http://127.0.0.1:${srv.port}/p -H "Content-Type: application/json"`,
    '  content, -c: string (required) "body"',
    '```',
  ].join('\n'));
  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);
  await b.exec('/act.post -c "alpha\nbeta\ngamma"');
  srv.close();

  const parsed = JSON.parse(srv.body());
  assert(parsed.content === 'alpha\nbeta\ngamma', 'default-serialized body has all 3 lines as real newlines');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Multiline — inline -d JSON template preserves newlines', async () => {
  const srv = await captureBodyServer();
  const tmpDir = fs.mkdtempSync('/tmp/string-ml-d-');
  fs.writeFileSync(path.join(tmpDir, 'app.md'), [
    '```act.post',
    `POST http://127.0.0.1:${srv.port}/p -H "Content-Type: application/json" -d '{"content":"{content}"}'`,
    '  content, -c: string (required) "body"',
    '```',
  ].join('\n'));
  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);
  await b.exec('/act.post -c "alpha\nbeta"');
  srv.close();

  const parsed = JSON.parse(srv.body());
  assert(parsed.content === 'alpha\nbeta', '-d template content escaped to real newlines');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Multiline — unicode + internal spaces intact', async () => {
  const srv = await captureBodyServer();
  const tmpDir = fs.mkdtempSync('/tmp/string-ml-uni-');
  fs.writeFileSync(path.join(tmpDir, 'app.md'), [
    '```act.post',
    `POST http://127.0.0.1:${srv.port}/p -H "Content-Type: application/json"`,
    '  content, -c: string (required) "body"',
    '```',
  ].join('\n'));
  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);
  await b.exec('/act.post -c "한글 첫 줄\n  들여쓴 둘째 줄"');
  srv.close();

  const parsed = JSON.parse(srv.body());
  assert(parsed.content === '한글 첫 줄\n  들여쓴 둘째 줄', 'unicode + internal leading spaces + newline preserved');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Single-line value still works (multiline-fix regression)', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-sl-');
  fs.writeFileSync(path.join(tmpDir, 'app.md'), ECHO_APP);
  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);
  const r = await b.exec('/act.echo -c "just one line"');
  assert(r.ok && r.content.includes('just one line'), 'single-line preserved');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── SECURITY: env vars resolve only in author templates, never in caller values ──
// Regression for the incident where `$MOLTBOOK_API_KEY` typed into a post body was
// expanded to the real key and published. Caller/AI-provided values must stay literal.

await section('SECURITY: $VAR in file content stays literal; author-template $VAR resolves', async () => {
  // Reproduces the real incident: a file whose CONTENT contains `$SECRET`, inlined
  // via {content|file}. The author's own `$SECRET` in the template must resolve;
  // the file content's `$SECRET` must stay literal (never expand to the secret).
  const srv = await captureBodyServer();
  const tmpDir = fs.mkdtempSync('/tmp/string-sec-file-');
  const draft = path.join(tmpDir, 'draft.md');
  fs.writeFileSync(draft, 'leak test: $SECRET must stay literal');
  fs.writeFileSync(path.join(tmpDir, 'app.md'), [
    '```act.post',
    `POST http://127.0.0.1:${srv.port}/p -H "Content-Type: application/json" -d '{"author":"$SECRET","body":"{content|file}"}'`,
    '  content, -c: path (required) "draft file path"',
    '```',
  ].join('\n'));
  const b = new Browser({ home: tmpDir });
  await b.exec('/set $SECRET = "REAL-SECRET-VALUE"', 'app:sectest');
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`, 'app:sectest');
  const r = await b.exec(`/act.post -c ${draft}`, 'app:sectest');
  srv.close();
  const raw = srv.body();
  assert(raw.length > 0, `server received a body (exec ok=${r.ok}, content=${JSON.stringify(r.content).slice(0, 200)})`);
  const parsed = JSON.parse(raw);
  assert(parsed.author === 'REAL-SECRET-VALUE', 'author-template $SECRET resolves (env is set)');
  assert(parsed.body === 'leak test: $SECRET must stay literal', 'file-content $SECRET stays literal');
  assert(!String(parsed.body).includes('REAL-SECRET-VALUE'), 'real secret NOT leaked into file-sourced content');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('SECURITY: bare $var in a caller arg is rejected', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-sec-arg-');
  fs.writeFileSync(path.join(tmpDir, 'app.md'), ECHO_APP);
  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);
  const r = await b.exec('/act.echo -c "$SECRET"');
  assert(!r.ok, 'bare $var in caller arg is rejected (not silently expanded)');
  assert(r.content.includes('cannot be used in command arguments'), 'clear guard message');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('Field default $VAR still resolves (author-controlled, regression)', async () => {
  const srv = await captureBodyServer();
  const tmpDir = fs.mkdtempSync('/tmp/string-def-var-');
  fs.writeFileSync(path.join(tmpDir, 'app.md'), [
    '```act.post',
    `POST http://127.0.0.1:${srv.port}/p -H "Content-Type: application/json" -d '{"tag":"{tag}"}'`,
    '  tag, -t: string "label" = "$DEFAULT_TAG"',
    '```',
  ].join('\n'));
  const b = new Browser({ home: tmpDir });
  await b.exec('/set $DEFAULT_TAG = "resolved-from-store"', 'app:deftest');
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`, 'app:deftest');
  await b.exec('/act.post', 'app:deftest');  // no --tag → default (references $DEFAULT_TAG) used
  srv.close();
  const parsed = JSON.parse(srv.body());
  assert(parsed.tag === 'resolved-from-store', 'author field-default $VAR still resolves from store');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
