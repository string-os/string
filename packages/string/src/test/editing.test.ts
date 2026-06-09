/**
 * Editing tests: formatLineNumbers, formatDiff, resolveConfig,
 * /write /append /edit diff, /edit line numbers, /set config
 */
import fs from 'fs';
import path from 'path';
import { Browser, formatDiff, formatLineNumbers, resolveConfig, DEFAULT_CONFIG } from '../index.js';
import { Session } from '../session.js';
import { assert, section } from './runner.js';

// ─── formatLineNumbers ────────────────────────────────────────────────────────

await section('formatLineNumbers', async () => {
  const result = formatLineNumbers('# Title\n\nSome content');
  assert(result.includes('1 | # Title'), 'first line numbered');
  assert(result.includes('2 | '), 'blank line numbered');
  assert(result.includes('3 | Some content'), 'third line numbered');

  // Custom start line
  const r2 = formatLineNumbers('A\nB', 10);
  assert(r2.includes('10 | A'), 'custom start line');
  assert(r2.includes('11 | B'), 'custom start line +1');

  // Single line
  const r3 = formatLineNumbers('only');
  assert(r3 === '1 | only', 'single line');
});

// ─── formatDiff ──────────────────────────────────────────────────────────────

await section('formatDiff — new file', async () => {
  const diff = formatDiff('', '# Hello\nWorld');
  assert(diff.includes('1 + # Hello'), 'new file line 1 marked +');
  assert(diff.includes('2 + World'), 'new file line 2 marked +');
  assert(!diff.includes('-'), 'no deletions in new file');
  assert(!diff.includes('|'), 'no keep lines in new file');
});

await section('formatDiff — no changes', async () => {
  const diff = formatDiff('same\ncontent', 'same\ncontent');
  assert(diff === '(no changes)', 'identical content returns no changes');
});

await section('formatDiff — overwrite', async () => {
  const diff = formatDiff('old line', 'new line');
  assert(diff.includes('- old line'), 'deleted line marked -');
  assert(diff.includes('+ new line'), 'added line marked +');
});

await section('formatDiff — append', async () => {
  const diff = formatDiff('Line 1', 'Line 1\nLine 2\nLine 3');
  assert(diff.includes('| Line 1'), 'kept line marked |');
  assert(diff.includes('+ Line 2'), 'appended line 2 marked +');
  assert(diff.includes('+ Line 3'), 'appended line 3 marked +');
});

await section('formatDiff — context and gaps', async () => {
  // Create old/new with changes far apart
  const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const newLines = [...oldLines];
  newLines[1] = 'CHANGED 2';    // line 2
  newLines[18] = 'CHANGED 19';  // line 19

  const diff = formatDiff(oldLines.join('\n'), newLines.join('\n'), { context: 1 });
  assert(diff.includes('- line 2'), 'first change del');
  assert(diff.includes('+ CHANGED 2'), 'first change add');
  assert(diff.includes('...'), 'context gap between changes');
  assert(diff.includes('- line 19'), 'second change del');
  assert(diff.includes('+ CHANGED 19'), 'second change add');
});

await section('formatDiff — truncation', async () => {
  const diff = formatDiff('', Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'), { maxLines: 10 });
  assert(diff.includes('truncated at 10 lines'), 'truncation notice');
  // Count actual output lines (before truncation notice)
  const lines = diff.split('\n');
  assert(lines.length <= 12, 'output respects maxLines'); // 10 + truncation line + possible margin
});

// ─── resolveConfig ───────────────────────────────────────────────────────────

await section('resolveConfig — defaults and overrides', async () => {
  const s = new Session('config-test');
  const c1 = resolveConfig(s);
  assert(c1.diffContext === DEFAULT_CONFIG.diffContext, 'default diffContext');
  assert(c1.diffMaxLines === DEFAULT_CONFIG.diffMaxLines, 'default diffMaxLines');
  assert(c1.editMaxLines === DEFAULT_CONFIG.editMaxLines, 'default editMaxLines');

  // Override via session variable
  s.setVar('_diff_context', '7');
  s.setVar('_diff_max_lines', '200');
  const c2 = resolveConfig(s);
  assert(c2.diffContext === 7, 'overridden diffContext');
  assert(c2.diffMaxLines === 200, 'overridden diffMaxLines');
  assert(c2.editMaxLines === DEFAULT_CONFIG.editMaxLines, 'unset editMaxLines stays default');

  // Invalid value falls back to default
  s.setVar('_diff_context', 'abc');
  const c3 = resolveConfig(s);
  assert(c3.diffContext === DEFAULT_CONFIG.diffContext, 'invalid value falls back to default');

  // Zero is valid for diffContext (show only changed lines)
  s.setVar('_diff_context', '0');
  const c4 = resolveConfig(s);
  assert(c4.diffContext === 0, 'zero is valid for diffContext');

  // Negative falls back to default
  s.setVar('_diff_context', '-1');
  const c5 = resolveConfig(s);
  assert(c5.diffContext === DEFAULT_CONFIG.diffContext, 'negative falls back to default');
});

// ─── Diff in commands (integration) ──────────────────────────────────────────

await section('/write — diff feedback in response', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-diff-test-');
  const b = new Browser({ home: tmpDir });

  // New file → "Created:" + all "+"
  const r1 = await b.exec('/write test.md\n# Hello\nWorld');
  assert(r1.ok, 'write new file ok');
  assert(r1.content.includes('Created:'), 'new file says Created');
  assert(r1.content.includes('+ # Hello'), 'new file diff has + for line 1');
  assert(r1.content.includes('+ World'), 'new file diff has + for line 2');
  assert(r1.content.includes('Use /undo to revert.'), 'undo hint present');

  // Overwrite → "Written:" + diff with -/+
  const r2 = await b.exec('/write test.md\n# Changed\nNew content');
  assert(r2.ok, 'overwrite ok');
  assert(r2.content.includes('Written:'), 'overwrite says Written');
  assert(r2.content.includes('- # Hello'), 'overwrite diff shows deleted old');
  assert(r2.content.includes('+ # Changed'), 'overwrite diff shows added new');

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('/append — diff feedback in response', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-diff-test-');
  const b = new Browser({ home: tmpDir });

  await b.exec('/write test.md\nLine 1');
  const r = await b.exec('/append test.md\nLine 2');
  assert(r.ok, 'append ok');
  assert(r.content.includes('Appended to:'), 'append label');
  assert(r.content.includes('| Line 1'), 'append diff shows kept line');
  assert(r.content.includes('+ Line 2'), 'append diff shows added line');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('/edit — diff feedback for mutation', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-diff-test-');
  const b = new Browser({ home: tmpDir });

  await b.exec('/write test.md\nLine 1\nLine 2\nLine 3');
  const r = await b.exec('/edit test.md\nLine 1\nReplaced\nLine 3');
  assert(r.ok, 'edit mutation ok');
  assert(r.content.includes('Edited'), 'edit label');
  assert(r.content.includes('- Line 2'), 'edit diff shows deleted');
  assert(r.content.includes('+ Replaced'), 'edit diff shows added');
  assert(r.content.includes('| Line 1'), 'edit diff shows kept');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('/edit — line numbers in view mode', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-diff-test-');
  const b = new Browser({ home: tmpDir });

  await b.exec('/write test.md\n# Title\n\nBody text');
  const r = await b.exec('/edit test.md');
  assert(r.ok, 'edit view ok');
  assert(r.content.includes('[editing: test.md]'), 'editing header');
  assert(r.content.includes('1 | # Title'), 'line 1 numbered');
  assert(r.content.includes('2 | '), 'line 2 numbered');
  assert(r.content.includes('3 | Body text'), 'line 3 numbered');
  assert(r.content.includes('(3 lines)'), 'line count shown');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('/replace — exact substring replace', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-replace-test-');
  const b = new Browser({ home: tmpDir });

  await b.exec('/write test.txt\nalpha\nbeta\ngamma');
  const r = await b.exec('/replace test.txt\nbeta\n---\nBETA');
  assert(r.ok, 'replace ok');
  assert(r.content.includes('Replaced 1 occurrence'), 'replace count shown');
  assert(r.content.includes('- beta'), 'diff deleted old text');
  assert(r.content.includes('+ BETA'), 'diff added new text');
  const content = fs.readFileSync(path.join(tmpDir, 'test.txt'), 'utf-8');
  assert(content === 'alpha\nBETA\ngamma', 'file content replaced');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('/replace — ambiguous substring requires --all', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-replace-test-');
  const b = new Browser({ home: tmpDir });

  await b.exec('/write test.txt\nv1\nv1\nv1');
  const r1 = await b.exec('/replace test.txt\nv1\n---\nv2');
  assert(!r1.ok, 'ambiguous replace rejected');
  assert(r1.code === 'CONFLICT', 'ambiguous replace uses conflict');
  assert(r1.content.includes('matched 3 times'), 'match count shown');

  const r2 = await b.exec('/replace test.txt --all\nv1\n---\nv2');
  assert(r2.ok, 'replace all ok');
  assert(r2.content.includes('Replaced 3 occurrences'), 'replace all count shown');
  const content = fs.readFileSync(path.join(tmpDir, 'test.txt'), 'utf-8');
  assert(content === 'v2\nv2\nv2', 'all occurrences replaced');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('/replace — line and range replace', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-replace-test-');
  const b = new Browser({ home: tmpDir });

  await b.exec('/write test.txt\none\ntwo\nthree\nfour');
  const r1 = await b.exec('/replace test.txt:L2\nTWO');
  assert(r1.ok, 'line replace ok');
  assert(r1.content.includes('Replaced test.txt:L2'), 'line label shown');

  const r2 = await b.exec('/replace test.txt:L3-L4\nTHREE\nFOUR\nFIVE');
  assert(r2.ok, 'range replace ok');
  assert(r2.content.includes('Replaced test.txt:L3-L4'), 'range label shown');

  const content = fs.readFileSync(path.join(tmpDir, 'test.txt'), 'utf-8');
  assert(content === 'one\nTWO\nTHREE\nFOUR\nFIVE', 'line and range replacements applied');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('/replace — block replace delegates to document block editing', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-replace-test-');
  const b = new Browser({ home: tmpDir });

  await b.exec('/write test.md\n# Title\n\n## Status\nold\n\n## Next\nkeep');
  const r = await b.exec('/replace test.md#status\nnew');
  assert(r.ok, 'block replace ok');
  assert(r.content.includes('Edited test.md#status'), 'block edit label shown');
  const content = fs.readFileSync(path.join(tmpDir, 'test.md'), 'utf-8');
  assert(content.includes('## Status\nnew\n\n## Next'), 'block body replaced and next section preserved');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('/write — existing whole-file overwrite requires prior read or --force', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-stale-test-');
  fs.writeFileSync(path.join(tmpDir, 'existing.txt'), 'original', 'utf-8');
  const b = new Browser({ home: tmpDir });

  const blocked = await b.exec('/write existing.txt\nblind overwrite');
  assert(!blocked.ok, 'blind overwrite blocked');
  assert(blocked.code === 'CONFLICT', 'blind overwrite uses conflict');
  assert(blocked.content.includes('not read in this topic'), 'read hint shown');

  const forced = await b.exec('/write --force existing.txt\nforced overwrite');
  assert(forced.ok, 'force overwrite ok');
  assert(fs.readFileSync(path.join(tmpDir, 'existing.txt'), 'utf-8') === 'forced overwrite', 'force changed content');

  fs.writeFileSync(path.join(tmpDir, 'existing.txt'), 'external content', 'utf-8');
  const b2 = new Browser({ home: tmpDir });
  await b2.exec('/edit existing.txt');
  const safe = await b2.exec('/write existing.txt\nseen overwrite');
  assert(safe.ok, 'overwrite after read ok');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await section('/set config override affects diff output', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-diff-test-');
  const b = new Browser({ home: tmpDir });

  // Create file with many lines
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
  await b.exec(`/write big.md\n${lines.join('\n')}`);

  // Set context to 0
  await b.exec('/set {_diff_context} = "0"');

  // Modify line 5 only
  const newLines = [...lines];
  newLines[4] = 'CHANGED';
  const r = await b.exec(`/write big.md\n${newLines.join('\n')}`);
  assert(r.ok, 'write with config ok');
  assert(r.content.includes('- line 5'), 'changed line deleted');
  assert(r.content.includes('+ CHANGED'), 'changed line added');
  // With context=0, should not show surrounding unchanged lines
  assert(!r.content.includes('| line 4'), 'no context line 4 with context=0');
  assert(!r.content.includes('| line 6'), 'no context line 6 with context=0');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
