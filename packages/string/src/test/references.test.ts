/**
 * Reference tests: definitions, @shortcut via reference, standard ref,
 * angle brackets, nav page, code blocks
 */
import fs from 'fs';
import path from 'path';
import { parse } from '@string-os/core';
import { Browser } from '../index.js';
import { STRING_VERSION } from '../version.js';
import { assert, section } from './runner.js';

await section('Reference definitions — parser', async () => {
  const src = [
    '# Page',
    '',
    'Read the [docs][mdn] and check [@api].',
    '',
    '[mdn]: https://developer.mozilla.org',
    '[@api]: https://api.example.com/v2',
  ].join('\n');

  const result = parse(src);
  assert(result.references.size === 2, 'two reference definitions parsed');
  assert(result.references.get('mdn') === 'https://developer.mozilla.org', 'standard ref parsed');
  assert(result.references.get('@api') === 'https://api.example.com/v2', '@-prefixed ref parsed');
});

await section('Reference definitions — @shortcut via reference style', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-ref-shortcut-');
  const testFile = path.join(tmpDir, 'ref-shortcuts.md');
  fs.writeFileSync(testFile, [
    '# Shortcuts Test',
    '',
    'Visit the [API Docs][@api] for details.',
    '',
    '[@api]: https://api.example.com/v2',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/open ${testFile}`);
  assert(r.ok, 'open ok');
  // AI should see [API Docs][@api] (pass-through, already correct format)
  assert(r.content.includes('[API Docs][@api]'), '@shortcut reference preserved');
  // Definition line should be stripped
  assert(!r.content.includes('[@api]:'), 'ref definition stripped');

  // @api should be navigable
  const r2 = await b.exec('/open @api');
  assert(!r2.content.includes('Shortcut not found'), '@api resolves from reference definition');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('Reference definitions — standard ref resolved to inline', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-ref-standard-');
  const testFile = path.join(tmpDir, 'ref-standard.md');
  fs.writeFileSync(testFile, [
    '# Standard Refs',
    '',
    'Check [MDN][mdn] and [local link](./other.md).',
    '',
    '[mdn]: https://developer.mozilla.org',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/open ${testFile}`);
  assert(r.ok, 'open ok');
  // Standard ref [MDN][mdn] → resolved to inline → auto-shortcutted
  assert(!r.content.includes('[mdn]'), 'standard ref name removed');
  assert(!r.content.includes('developer.mozilla.org'), 'URL hidden by auto-shortcut');
  assert(r.content.includes('[MDN]'), 'label preserved');
  // Definition line stripped
  assert(!r.content.includes('[mdn]:'), 'ref definition stripped');
  // Local link unchanged
  assert(r.content.includes('(./other.md)'), 'local link unchanged');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('Reference definitions — angle brackets and title', async () => {
  const src = [
    '[example]: <https://example.com>',
    '[titled]: https://titled.com "A Title"',
  ].join('\n');

  const result = parse(src);
  assert(result.references.get('example') === 'https://example.com', 'angle brackets stripped');
  assert(result.references.get('titled') === 'https://titled.com', 'title ignored, URL captured');
});

await section('/nav page — shortcut table', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-nav-page-');
  const testFile = path.join(tmpDir, 'nav-page.md');
  fs.writeFileSync(testFile, [
    '# Nav Page Test',
    '',
    '[@api API Docs](https://api.example.com)',
    '',
    'Visit [GitHub](https://github.com) and [MDN](https://developer.mozilla.org).',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${testFile}`);

  const r = await b.exec('/nav page');
  assert(r.ok, 'nav page ok');
  assert(r.content.includes('Shortcuts:'), 'has shortcuts section');
  assert(r.content.includes('@api'), 'shows author shortcut');
  assert(r.content.includes('https://api.example.com'), 'shows author URL');
  assert(r.content.includes('Auto:'), 'has auto section');
  assert(r.content.includes('@github'), 'shows auto shortcut');
  assert(r.content.includes('/open @id'), 'shows usage hint');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('Reference definitions — inside code blocks ignored', async () => {
  const src = [
    '```',
    '[not-a-ref]: https://example.com',
    '```',
  ].join('\n');

  const result = parse(src);
  assert(result.references.size === 0, 'ref inside code block not parsed');
});

await section('Shortcut invocations — fenced code blocks are literal', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-fence-');
  const testFile = path.join(tmpDir, 'doc.md');
  // Documentation page that *describes* shortcut syntax. The example
  // `[Home][@main.home]` lives inside a fenced code block and must not
  // trigger an "Unknown shortcut" warning.
  fs.writeFileSync(testFile, [
    '# Shortcuts Guide',
    '',
    'Use the syntax:',
    '',
    '```',
    '[Home][@main.home]',
    '[Auth][@api.auth]',
    '```',
    '',
    'That is all.',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/open ${testFile}`);
  assert(r.ok, 'open ok');
  assert(!r.content.includes('Unknown shortcut'), 'no warning in body for fenced examples');
  assert(!r.content.includes('[!]'), 'no diagnostic line prepended');
  assert(r.content.includes('[Home][@main.home]'), 'fenced example preserved verbatim');
  // The current document should carry no warnings since all [@id]-shaped
  // tokens were inside a code block.
  const doc = b.currentSession.currentDoc;
  assert(doc?.warnings.length === 0, 'no warnings on document');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('Shortcut invocations — inline code is literal', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-inline-');
  const testFile = path.join(tmpDir, 'doc.md');
  fs.writeFileSync(testFile, [
    '# Page',
    '',
    'Write `[Label][@unknown]` inline to refer to the syntax.',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/open ${testFile}`);
  assert(r.ok, 'open ok');
  assert(!r.content.includes('Unknown shortcut'), 'inline code does not trigger warning');
  assert(r.content.includes('`[Label][@unknown]`'), 'inline code preserved');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('Shortcut invocations — backslash escape opts out', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-escape-');
  const testFile = path.join(tmpDir, 'doc.md');
  fs.writeFileSync(testFile, [
    '# Page',
    '',
    'To show literal syntax in prose: \\[Label\\]\\[@id\\] resolves to nothing.',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/open ${testFile}`);
  assert(r.ok, 'open ok');
  assert(!r.content.includes('Unknown shortcut'), 'escaped form does not trigger warning');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('Warnings — body stays clean, surfaced via meta + /info', async () => {
  const tmpDir = fs.mkdtempSync('/tmp/string-warning-');
  const testFile = path.join(tmpDir, 'doc.md');
  // Real (unintentional) unknown shortcut in prose — should generate a
  // warning that lives on meta.warnings + /info, but NOT in the body.
  fs.writeFileSync(testFile, [
    '# Page',
    '',
    'See [Home][@missing.home] for details.',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  const r = await b.exec(`/open ${testFile}`);
  assert(r.ok, 'open ok');
  // Body must not contain the warning marker.
  assert(!r.content.includes('[!] Unknown shortcut'), 'warning not in body');
  assert(!r.content.startsWith('[!]'), 'no [!] prepend at top of body');
  // The document carries the warning for diagnostic surfaces.
  const warnings = b.currentSession.currentDoc?.warnings ?? [];
  assert(warnings.length === 1, 'one warning on document');
  assert(warnings[0].includes('@missing.home'), 'warning identifies the missing shortcut');
  // /info surfaces the warning to authors who want to see it.
  const info = await b.exec('/info');
  assert(info.content.includes('@missing.home'), '/info shows the warning');

  fs.rmSync(tmpDir, { recursive: true });
});

await section('/info surfaces the running runtime version (skew observability)', async () => {
  // Every /info carries the actually-running build version so a merged-but-
  // unreleased fix — or a stale npx cache resolving an old pin — is observable
  // from inside a session instead of requiring an npx-cache dig.
  const tmpDir = fs.mkdtempSync('/tmp/string-info-version-');
  try {
    const b = new Browser({ home: tmpDir });
    const info = await b.exec('/info');
    assert(info.ok, `/info ok: ${info.content}`);
    assert(info.content.includes(`string:    v${STRING_VERSION}`),
      `/info shows the running version (want "string:    v${STRING_VERSION}"): ${info.content}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

await section('Parser — shortcut definitions inside inline code are ignored', async () => {
  // Inline-code examples like `[@id Label](path)` in prose should not be parsed
  // as real shortcut definitions. This is what runtime/navigation.md does when
  // describing the SFMD shortcut syntax.
  const src = [
    '# Doc about shortcuts',
    '',
    'Each line follows the shortcut syntax: `[@id Label](path)`.',
    '',
    'You can also write `[@home Home](/index.md)` inline.',
  ].join('\n');

  const result = parse(src);
  assert(result.shortcuts.length === 0, 'no shortcuts harvested from inline code examples');
});

await section('Parser — shortcut definitions inside fenced code are ignored', async () => {
  const src = [
    '# Doc about shortcuts',
    '',
    '```',
    '[@home Home](/index.md)',
    '[@about About](/about.md)',
    '```',
  ].join('\n');

  const result = parse(src);
  assert(result.shortcuts.length === 0, 'no shortcuts harvested from fenced examples');
});

await section('/nav page — illustrative examples in code do not pollute output', async () => {
  // Reproduces the reviewer's complaint: a doc that explains shortcut syntax
  // (with `[@id Label](path)` examples in code) should have an empty /nav
  // page output, not a "template-like" listing of placeholder ids.
  const tmpDir = fs.mkdtempSync('/tmp/string-nav-doc-');
  const testFile = path.join(tmpDir, 'doc.md');
  fs.writeFileSync(testFile, [
    '# Shortcut Syntax',
    '',
    'Each line follows the shortcut syntax: `[@id Label](path)`.',
    '',
    '```',
    '[@home Home](/index.md)',
    '```',
    '',
    'Also see [GitHub](https://github.com) (in code: `[GitHub](https://github.com)`).',
  ].join('\n'));

  const b = new Browser({ home: tmpDir });
  await b.exec(`/open ${testFile}`);
  const r = await b.exec('/nav page');
  assert(r.ok, 'nav page ok');
  // No author "Shortcuts:" section should appear — the placeholder example
  // `[@id Label](path)` from inline code must not be harvested.
  assert(!r.content.includes('Shortcuts:'), 'no author-shortcuts section (examples were in code)');
  assert(!r.content.includes('@home'), 'no fenced-example shortcut leaks into output');
  // The plain GitHub link outside code is auto-shortcutted; the one inside
  // backticks is not. Two @github tokens (one auto-shortcut entry + one in
  // the backticked example string) is wrong; expect exactly one.
  const githubMatches = r.content.match(/@github/g) ?? [];
  assert(githubMatches.length === 1, 'auto-shortcut @github appears exactly once (only the prose occurrence)');

  fs.rmSync(tmpDir, { recursive: true });
});
