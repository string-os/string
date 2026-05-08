/**
 * Topic parsing, double-slash prefix, /exec, bash topic, bash persistence
 */
import path from 'path';
import { Browser, parseTopic, topicToString } from '../index.js';
import { assert, section, mkBrowser, WIKI } from './runner.js';

await section('parseTopic — valid formats', async () => {
  // Empty / undefined → tab:main
  const empty = parseTopic();
  assert(empty !== null, 'empty returns non-null');
  assert(empty!.type === 'tab' && empty!.namespace === 'main', 'empty → tab:main');

  const emptyStr = parseTopic('');
  assert(emptyStr !== null && emptyStr.type === 'tab' && emptyStr.namespace === 'main', '"" → tab:main');

  // Free-form bare name → tab
  const bare = parseTopic('docs');
  assert(bare !== null && bare.type === 'tab' && bare.namespace === 'docs', '"docs" → tab:docs');

  // Reserved bare names → hub
  for (const hub of ['app', 'bash', 'tool', 'system']) {
    const parsed = parseTopic(hub);
    assert(parsed !== null && parsed.type === 'hub' && parsed.namespace === hub, `${hub} → hub:${hub}`);
  }

  // Canonical typed topics
  const appTgt = parseTopic('app:weather');
  assert(appTgt !== null && appTgt.type === 'app' && appTgt.namespace === 'weather', 'app:weather');

  const bashTgt = parseTopic('bash:dev');
  assert(bashTgt !== null && bashTgt.type === 'bash' && bashTgt.namespace === 'dev', 'bash:dev');

  // App with config (multi-colon namespace)
  const appCfg = parseTopic('app:weather:korea');
  assert(appCfg !== null && appCfg.type === 'app' && appCfg.namespace === 'weather:korea', 'app:weather:korea');

  // Hyphen and underscore in tab name
  const hyphen = parseTopic('my-session');
  assert(hyphen !== null && hyphen.type === 'tab' && hyphen.namespace === 'my-session', 'hyphens ok');

  const under = parseTopic('my_session');
  assert(under !== null && under.type === 'tab' && under.namespace === 'my_session', 'underscores ok');
});

await section('parseTopic — invalid formats', async () => {
  // Dots rejected
  assert(parseTopic('intro.md') === null, 'dots in session name rejected');
  assert(parseTopic('app:intro.md') === null, 'dots in typed namespace rejected');

  // Unknown / removed prefixes
  assert(parseTopic('ftp:server') === null, 'unknown type rejected');
  assert(parseTopic('file:notes') === null, 'file: prefix removed (use bare name)');
  assert(parseTopic('web:search') === null, 'web: prefix removed (use bare name)');

  // Empty namespace after type
  assert(parseTopic('app:') === null, 'empty namespace rejected');

  // Spaces
  assert(parseTopic('my session') === null, 'spaces rejected');

  // Special chars
  assert(parseTopic('bad!name') === null, 'special chars rejected');
  assert(parseTopic('app:bad/name') === null, 'slash in namespace rejected');
});

await section('topicToString roundtrip', async () => {
  // tab and hub serialize as bare names; canonical types keep their prefix.
  const cases: Array<[string, string]> = [
    ['main', 'main'],
    ['notes', 'notes'],
    ['app', 'app'],
    ['bash', 'bash'],
    ['system', 'system'],
    ['app:weather:korea', 'app:weather:korea'],
    ['bash:dev', 'bash:dev'],
  ];
  for (const [input, expected] of cases) {
    const parsed = parseTopic(input);
    assert(parsed !== null, `${input} parses`);
    assert(topicToString(parsed!) === expected, `${input} → ${expected}`);
  }
});

// ─── // prefix on non-bash topics ────────────────────────────────────────────

await section('double-slash prefix on file topic', async () => {
  const b = new Browser({ home: path.dirname(WIKI) });

  // //help works same as /help
  const r1 = await b.exec('//help');
  assert(r1.ok === true, '//help returns ok');
  assert(/String Commands/.test(r1.content), '//help shows full help');

  // //info works same as /info
  const r2 = await b.exec('//info');
  assert(r2.ok === true, '//info returns ok');

  // //open works same as /open
  const r3 = await b.exec('//open index.md');
  assert(r3.ok === true, '//open resolves to /open');
});

// ─── /exec — stateless shell ──────────────────────────────────────────────

await section('/exec — stateless shell', async () => {
  const b = mkBrowser();

  // Basic execution
  const r1 = await b.exec('/exec echo hello_exec');
  assert(r1.ok, 'exec echo ok');
  assert(r1.content.includes('hello_exec'), 'stdout captured');
  assert(r1.content.includes('exit: 0'), 'exit code shown');

  // Cwd = home when no doc
  const r2 = await b.exec('/exec pwd');
  assert(r2.ok, 'exec pwd ok');
  assert(r2.content.includes(path.dirname(WIKI)), 'cwd is home');

  // Cwd = document dir when doc open
  await b.exec(`/open ${WIKI}`);
  const r3 = await b.exec('/exec pwd');
  assert(r3.content.includes(path.dirname(WIKI)), 'cwd follows doc dir');

  // Failed command
  const r4 = await b.exec('/exec false');
  assert(!r4.ok, 'failed command returns not ok');

  // Session vars exported as env
  await b.exec('/set {TEST_VAR} = "from_string"');
  const r5 = await b.exec('/exec echo $TEST_VAR');
  assert(r5.content.includes('from_string'), 'session var exported as env');

  // Empty input
  const r6 = await b.exec('/exec');
  assert(!r6.ok, 'empty exec returns error');
});

// ─── Bash topic dispatch ─────────────────────────────────────────────────────

await section('bash topic — shell execution', async () => {
  const b = new Browser({ home: path.dirname(WIKI) });

  // Plain text → real shell execution
  const r1 = await b.exec('echo hello_from_bash', undefined, 'bash');
  assert(r1.ok === true, 'echo command succeeds');
  assert(r1.content.includes('hello_from_bash'), 'stdout captured');

  // Path starting with / → shell execution, not a String command
  const r2 = await b.exec('/bin/echo path_test', undefined, 'bash');
  assert(r2.ok === true, '/bin/echo treated as shell, not String command');
  assert(r2.content.includes('path_test'), '/bin/echo stdout captured');

  // //help → String meta-command
  const r3 = await b.exec('//help', undefined, 'bash');
  assert(r3.ok === true, '//help returns ok');
  assert(/Bash Session/.test(r3.content), '//help shows bash help');
  assert(/\/\/close/.test(r3.content), '//help lists //close');

  // //close → String meta-command
  const r4 = await b.exec('//close', undefined, 'bash');
  assert(r4.ok === true, '//close returns ok');

  // //info → String meta-command
  const r5 = await b.exec('//info', undefined, 'bash');
  assert(r5.ok === true, '//info returns ok');

  // //unknown → error
  const r6 = await b.exec('//open foo', undefined, 'bash');
  assert(r6.ok === false, '//open rejected in bash');
  assert(r6.code === 'COMMAND_UNSUPPORTED', '//open returns COMMAND_UNSUPPORTED');

  // Non-bash topic still rejects plain text
  const r7 = await b.exec('hello world');
  assert(r7.ok === false, 'plain text rejected on file topic');
  assert(r7.code === 'COMMAND_UNSUPPORTED', 'file topic returns COMMAND_UNSUPPORTED');
});

// ─── Bash session persistence ─────────────────────────────────────────────────

await section('bash session — state persistence across turns', async () => {
  const b = new Browser({ home: path.dirname(WIKI) });

  // Turn 1: export a variable
  const r1 = await b.exec('export STRING_TEST_VAR=persistent_123', undefined, 'bash');
  assert(r1.ok === true, 'export succeeds');

  // Turn 2: read the variable back — should persist
  const r2 = await b.exec('echo $STRING_TEST_VAR', undefined, 'bash');
  assert(r2.ok === true, 'echo var succeeds');
  assert(r2.content.includes('persistent_123'), 'env var persists across turns');

  // Turn 3: cd to a different directory
  const r3 = await b.exec('cd /tmp', undefined, 'bash');
  assert(r3.ok === true, 'cd succeeds');
  assert(r3.content.includes('cwd: /tmp'), 'cwd updated to /tmp');

  // Turn 4: pwd should confirm /tmp
  const r4 = await b.exec('pwd', undefined, 'bash');
  assert(r4.ok === true, 'pwd succeeds');
  assert(r4.content.includes('/tmp'), 'cwd persists after cd');

  // Turn 5: exit code propagation
  const r5 = await b.exec('ls /nonexistent_xyz_test', undefined, 'bash');
  assert(r5.ok === false, 'failed command returns ok=false');
  assert(r5.content.includes('exit: '), 'exit code in meta line');
  assert(!r5.content.includes('exit: 0'), 'exit code is non-zero');

  // Turn 6: output format check (meta + --- + content)
  const r6 = await b.exec('echo format_test', undefined, 'bash');
  assert(r6.content.includes('exit: 0'), 'meta has exit: 0');
  assert(r6.content.includes('---'), 'separator present');
  assert(r6.content.includes('format_test'), 'output after separator');

  // Turn 7: //info should show actual PTY cwd (/tmp), not session doc cwd
  const r7 = await b.exec('//info', undefined, 'bash');
  assert(r7.ok === true, '//info after cd ok');
  assert(r7.content.includes('/tmp'), '//info shows PTY cwd /tmp');
  assert(!r7.content.includes('(none open)'), '//info uses bash-specific format');

  // Clean up
  b.currentSession.closeBash();
});
