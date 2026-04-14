/**
 * Reference tests: definitions, @shortcut via reference, standard ref,
 * angle brackets, nav page, code blocks
 */
import fs from 'fs';
import path from 'path';
import { parse } from '@string-os/core';
import { Browser } from '../index.js';
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
