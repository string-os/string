/**
 * S2 follow-up (PR D): `--<field>-file <path>` reads a file's contents as the
 * value of a declared field, so long / multi-line values (a dispatch brief)
 * don't have to survive a shell argument. Loud by construction: conflicts and
 * failures error with specifics rather than guessing.
 *
 * Note: field names are `\w+` (no hyphens), so a field literally named
 * `X-file` cannot be declared — Leo's rule-1 "both X and X-file exist"
 * ambiguity branch is therefore unreachable via SFMD and is kept only as a
 * defensive guard (not exercised here).
 */
import fs from 'fs';
import path from 'path';
import { parse } from '@string-os/core';
import { Browser } from '../index.js';
import { assert, section } from './runner.js';

function appDoc(fieldLine: string): string[] {
  return [
    '# File input',
    '',
    '```act.send',
    'CLI true',
    fieldLine,
    '```',
    '```act.send.response',
    'GOT>>>{message}<<<',
    '```',
  ];
}

await section('D — invariant: SFMD field names reject hyphens (keeps the rule-1 guard unreachable)', () => {
  // The rule-1 ambiguity guard ("both field X and a literal X-file declared →
  // error") is unreachable ONLY because field names are \w+ (core/parser.ts),
  // so a field named `X-file` cannot be declared. Pin that invariant: if the
  // grammar ever gains hyphens this test fails and points straight at the guard
  // that just became reachable. (Test the assumption, not the dead branch.)
  const src = ['```act.t', 'CLI true', '  msg-file: string (required) "m"', '```'].join('\n');
  const result = parse(src);
  const declaredNames = (result.actions[0]?.fields ?? []).map(f => f.name);
  assert(!declaredNames.includes('msg-file'),
    `a hyphenated field name must not parse as a field; got ${JSON.stringify(declaredNames)}`);
});

await section('D — --<field>-file reads file contents as the field value (verbatim data)', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-field-file-');
  fs.writeFileSync(path.join(tmpDir, 'app.md'), appDoc('  message: string (required) "the message"').join('\n'));
  // A realistic brief: multiline, an apostrophe, double quotes, and a {curly}
  // that would be eaten by {var} substitution on the arg path. All pass through
  // verbatim as data. (Shell-substitution chars $ and backtick are refused — see
  // the injection test below — so this safe brief contains none.)
  const brief = 'Kit: research only, don\'t install.\nUse the "staging" DB. Keep {scope} tight.';
  const briefPath = path.join(tmpDir, 'brief.txt');
  fs.writeFileSync(briefPath, brief);

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);
  const r = await b.exec(`/act.send --message-file ${briefPath}`);

  assert(r.ok, `action ok: ${r.content}`);
  assert(r.content.includes('research only'), `file contents reached the field: ${r.content}`);
  assert(r.content.includes('"staging"'), `double quotes passed verbatim: ${r.content}`);
  assert(r.content.includes('{scope}'), `{curly} passed verbatim (not {var}-substituted): ${r.content}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('D — SECURITY: file contents with shell substitution are REFUSED (command-injection fix)', async () => {
  // Reported repro: a file value flowing into a CLI action's shell command
  // executed $( ), backticks and $VAR. The direct-flag $var guard misses $( )
  // and backticks, so file values are refused if they contain $ or backtick.
  const tmpDir = fs.mkdtempSync('/tmp/string-field-file-inject-');
  fs.writeFileSync(path.join(tmpDir, 'app.md'), [
    '# Inject',
    '',
    '```act.run',
    "CLI printf '%s' \"{payload}\"",
    '  payload: string (required) "p"',
    '```',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);

  // The exact reported payload, plus each vector on its own.
  const vectors = [
    'BEGIN $(id -un) MID `hostname` END $HOME',
    '$(id -un)',
    '`hostname`',
    '${HOME}',
    'plain $HOME here',
  ];
  for (const v of vectors) {
    const p = path.join(tmpDir, 'v.txt');
    fs.writeFileSync(p, v);
    const r = await b.exec(`/act.run --payload-file ${p}`);
    assert(!r.ok, `injection payload refused: ${JSON.stringify(v)} → ${r.content}`);
    assert(r.content.includes('shell metacharacter'), `refusal explains why: ${r.content}`);
    // Must NOT have executed: no command output leaked into the result.
    assert(!/uid=|ip-\d|\/home\/ubuntu/.test(r.content), `nothing executed: ${r.content}`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('D — passing both --X and --X-file is an error, not a precedence choice', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-field-file-both-');
  fs.writeFileSync(path.join(tmpDir, 'app.md'), appDoc('  message: string (required) "m"').join('\n'));
  fs.writeFileSync(path.join(tmpDir, 'brief.txt'), 'from file');

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);
  const r = await b.exec(`/act.send --message inline --message-file ${path.join(tmpDir, 'brief.txt')}`);

  assert(!r.ok, 'conflicting flags rejected');
  assert(r.content.includes('either --message or --message-file'), `error explains the conflict: ${r.content}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('D — file over the size cap errors with the path and the limit', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-field-file-big-');
  fs.writeFileSync(path.join(tmpDir, 'app.md'), appDoc('  message: string (required) "m"').join('\n'));
  const bigPath = path.join(tmpDir, 'big.txt');
  fs.writeFileSync(bigPath, Buffer.alloc(1024 * 1024 + 1, 0x61)); // 1 MiB + 1 byte

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);
  const r = await b.exec(`/act.send --message-file ${bigPath}`);

  assert(!r.ok, 'oversized file rejected');
  assert(r.content.includes('too large') && r.content.includes(bigPath) && r.content.includes('1048576'),
    `error names the path and the limit: ${r.content}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('D — unreadable path errors with the path', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-field-file-missing-');
  fs.writeFileSync(path.join(tmpDir, 'app.md'), appDoc('  message: string (required) "m"').join('\n'));
  const missing = path.join(tmpDir, 'does-not-exist.txt');

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);
  const r = await b.exec(`/act.send --message-file ${missing}`);

  assert(!r.ok, 'missing file rejected');
  assert(r.content.includes('cannot read') && r.content.includes(missing), `error names the path: ${r.content}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('D — --X-file for an UNDECLARED field is left alone (not treated as a file read)', async () => {
  // `other` is not a declared field, so `--other-file` is a plain unknown flag,
  // not a file directive — we must not try to read it and error. message is
  // optional so the action still runs.
  const tmpDir = fs.mkdtempSync('/tmp/string-field-file-undeclared-');
  fs.writeFileSync(path.join(tmpDir, 'app.md'), appDoc('  message: string (optional) "m"').join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${path.join(tmpDir, 'app.md')}`);
  const r = await b.exec('/act.send --other-file /nonexistent/path');

  assert(r.ok, `undeclared --other-file did not trigger a file read: ${r.content}`);
  assert(!r.content.includes('cannot read'), `no spurious file error: ${r.content}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
