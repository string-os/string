/**
 * S4: CLI action response templates.
 *  - stdout / stderr / exit_code aliases are exposed (so authors reach for the
 *    names a shell command suggests instead of getting a silent blank).
 *  - an unresolved {Response.*} reference stays VISIBLE as its literal and
 *    triggers a warning (loud + consistent with unknown {var}), rather than
 *    rendering an invisible empty string.
 *  - an explicitly-null value still renders "" (no over-firing): only a
 *    genuinely missing path is treated as unresolved.
 */
import fs from 'fs';
import path from 'path';
import { Browser } from '../index.js';
import { assert, section } from './runner.js';

await section('S4 — CLI response exposes stdout/stderr/exit_code; unknown ref is loud', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-cli-response-');
  const doc = path.join(tmpDir, 'app.md');
  fs.writeFileSync(doc, [
    '# CLI Response',
    '',
    '```act.run',
    "CLI printf 'OUT_LINE'; printf 'ERR_LINE' >&2",
    '```',
    '```act.run.response',
    'STDOUT: {Response.stdout}',
    'STDERR: {Response.stderr}',
    'EXITCODE: {Response.exit_code}',
    'BOGUS: {Response.stdoutt}',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${doc}`);
  const r = await b.exec('/act.run --');

  assert(r.content.includes('STDOUT: OUT_LINE'), `stdout alias resolves: ${r.content}`);
  assert(r.content.includes('STDERR: ERR_LINE'), `stderr alias resolves: ${r.content}`);
  assert(r.content.includes('EXITCODE: 0'), `exit_code alias resolves: ${r.content}`);
  // The typo stays visible (loud), never a silent blank...
  assert(r.content.includes('BOGUS: {Response.stdoutt}'), `unknown ref left visible: ${r.content}`);
  // ...and is called out in a warning that lists what IS available.
  assert(r.content.includes('Unresolved template reference') && r.content.includes('{Response.stdoutt}'),
    `warning names the unresolved ref: ${r.content}`);
  assert(r.content.includes('stdout') && r.content.includes('exit_code'),
    `warning lists available fields: ${r.content}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('S4 — explicit null renders blank (no over-fire); only missing paths go loud', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-cli-response-null-');
  const doc = path.join(tmpDir, 'app.md');
  fs.writeFileSync(doc, [
    '# Null vs missing',
    '',
    '```act.run',
    'CLI printf \'{"present": null}\'',
    '```',
    '```act.run.response',
    'PRESENT:[{Response.body.present}]',
    'MISSING:[{Response.body.absent}]',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${doc}`);
  const r = await b.exec('/act.run --');

  // Explicit null is a real value → renders empty, no warning fired for it.
  assert(r.content.includes('PRESENT:[]'), `explicit null renders blank: ${r.content}`);
  // A genuinely absent path → loud literal + warning.
  assert(r.content.includes('MISSING:[{Response.body.absent}]'), `missing path left visible: ${r.content}`);
  assert(r.content.includes('Unresolved template reference') && r.content.includes('{Response.body.absent}'),
    `only the missing path is flagged: ${r.content}`);
  assert(!r.content.includes('{Response.body.present}'), `null field is NOT flagged as unresolved: ${r.content}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('S4 — HTTP action has no stdout/stderr; referencing them is loud, not blank', async () => {
  const http = await import('http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const tmpDir = fs.mkdtempSync('/tmp/string-http-response-');
  const doc = path.join(tmpDir, 'app.md');
  fs.writeFileSync(doc, [
    '# HTTP',
    '',
    '```act.fetch',
    `GET http://127.0.0.1:${port}/`,
    '```',
    '```act.fetch.response',
    'OK: {Response.body.ok}',
    'STDOUT: {Response.stdout}',
    '```',
  ].join('\n'));

  try {
    const b = new Browser({ home: tmpDir });
    await b.exec(`/open ${doc}`);
    const r = await b.exec('/act.fetch --');
    assert(r.content.includes('OK: true'), `http body field resolves: ${r.content}`);
    assert(r.content.includes('STDOUT: {Response.stdout}'), `stdout not silently blank on HTTP: ${r.content}`);
    assert(r.content.includes('Unresolved template reference'), `warning fired: ${r.content}`);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
