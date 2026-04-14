/**
 * Loader tests
 */
import path from 'path';
import { Loader } from './loader.js';
import { StringError } from './types.js';

const FIXTURE = path.resolve('../../packages/compiler/examples/ai-wiki/index.md');

async function run() {
  const loader = new Loader({ home: path.dirname(FIXTURE) });
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

  console.log('\nLoader tests:');

  await test('load local file by absolute path', async () => {
    const result = await loader.load(FIXTURE);
    if (!result.source.includes('AI Wiki')) throw new Error('unexpected content');
    if (!result.uri.startsWith('file://')) throw new Error('uri should be file://');
  });

  await test('load local file by relative path', async () => {
    const result = await loader.load('index.md', `file://${path.dirname(FIXTURE)}/dummy.md`);
    if (!result.source.includes('AI Wiki')) throw new Error('unexpected content');
  });

  await test('NOT_FOUND error on missing file', async () => {
    try {
      await loader.load('/nonexistent/path/missing.md');
      throw new Error('should have thrown');
    } catch (e) {
      if (!(e instanceof StringError) || e.code !== 'NOT_FOUND') throw e;
    }
  });

  await test('resolve chanflow:// to https://', async () => {
    const uri = loader.resolve('chanflow://aiindex.wiki/index.md');
    if (uri !== 'https://aiindex.wiki/index.md') throw new Error(`got: ${uri}`);
  });

  await test('resolve relative to file:// base', async () => {
    const uri = loader.resolve('./nav/main-menu.md', `file://${FIXTURE}`);
    if (!uri.startsWith('file://')) throw new Error(`got: ${uri}`);
    if (!uri.includes('nav/main-menu.md')) throw new Error(`got: ${uri}`);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
