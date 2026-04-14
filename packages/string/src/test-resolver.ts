/**
 * Resolver tests
 */
import path from 'path';
import { Loader } from './loader.js';
import { resolve } from './resolver.js';
import { StringError } from './types.js';

const WIKI_DIR = path.resolve('../../packages/compiler/examples/ai-wiki');
const INDEX = path.join(WIKI_DIR, 'index.md');

async function run() {
  const loader = new Loader({ home: WIKI_DIR });
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  [pass] ${name}`);
      passed++;
    } catch (e) {
      console.log(`  [fail] ${name}: ${(e as Error).message}`);
      failed++;
    }
  }

  console.log('\nResolver tests:');

  let doc: Awaited<ReturnType<typeof resolve>>;

  await test('resolve index.md — has correct uri', async () => {
    const { uri, source } = await loader.load(INDEX);
    doc = await resolve(uri, source, loader);
    if (!doc.uri.startsWith('file://')) throw new Error(`bad uri: ${doc.uri}`);
  });

  await test('resolve index.md — detects inline blocks', async () => {
    if (!doc.blockIds.includes('welcome')) throw new Error('missing block: welcome');
    if (!doc.blockIds.includes('contributing')) throw new Error('missing block: contributing');
    if (!doc.blockIds.includes('nav-hint')) throw new Error('missing block: nav-hint');
  });

  await test('resolve index.md — parses frontmatter', async () => {
    if (doc.frontmatter.title !== 'AI Wiki — Home') {
      throw new Error(`bad title: ${doc.frontmatter.title}`);
    }
  });

  await test('resolve index.md — loads menu entries', async () => {
    if (!doc.menus.has('main')) throw new Error('missing menu: main');
    const entries = doc.menus.get('main')!;
    if (entries.length === 0) throw new Error('menu main is empty');
    // Entries should be namespaced as main.id
    const first = entries[0];
    if (!first.id.startsWith('main.')) throw new Error(`bad namespace: ${first.id}`);
  });

  await test('resolve index.md — registers page shortcuts', async () => {
    // The contributing block has [@submit Submit an Article](action://wiki/submit)
    if (!doc.shortcuts.has('submit')) throw new Error('missing shortcut: @submit');
  });

  await test('circular reference detection', async () => {
    const selfUri = `file://${INDEX}`;
    const visited = new Set([selfUri]);
    try {
      const { source } = await loader.load(INDEX);
      await resolve(selfUri, source, loader, visited);
      throw new Error('should have thrown');
    } catch (e) {
      if (!(e instanceof StringError) || e.code !== 'CIRCULAR_REFERENCE') throw e;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
