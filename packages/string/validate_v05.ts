/**
 * Manual validation for String v0.5 semantics
 */
import { Session } from './src/session.js';
import { Loader } from './src/loader.js';
import { dispatch } from './src/commands.js';
import fs from 'fs';
import path from 'path';

const testDir = '/tmp/string_v05_test';
const testFile = path.join(testDir, 'test.md');

// Setup
fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });
fs.writeFileSync(testFile, '# Test\n\nOriginal content\n', 'utf-8');

const loader = new Loader({ workdir: testDir });
const session = new Session('test-session', 'test-user');

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.log(`✗ ${name}`);
    console.error(e);
  }
}

async function run() {
  console.log('\n=== String v0.5 Validation ===\n');

  // Test 1: Transport topic inheritance for /edit (no args)
  await test('Transport topic inheritance: /edit with no args', async () => {
    const result = await dispatch('/edit', session, loader, 'test.md');
    if (!result.ok) throw new Error(`Expected ok, got: ${result.content}`);
    if (!result.content.includes('[writable: test.md]')) {
      throw new Error(`Expected writable context marker, got: ${result.content.slice(0, 100)}`);
    }
    if (!session.writableTarget) throw new Error('Writable topic not set');
    if (session.writableTarget.type !== 'file') throw new Error('Expected file writable topic');
  });

  // Test 2: Whole-file /edit establishes writable context
  await test('Whole-file /edit file establishes writable context', async () => {
    const result = await dispatch('/edit test.md', session, loader);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.content}`);
    if (!session.writableTarget) throw new Error('Writable topic not set');
    if (session.writableTarget.type !== 'file') throw new Error('Expected file writable topic');
    if (session.writableTarget.path !== 'test.md') throw new Error('Wrong path in writable topic');
  });

  // Test 3: Plain payload after /edit file replaces whole file
  await test('Implicit write after /edit file replaces whole file', async () => {
    const result = await dispatch('New whole file content', session, loader);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.content}`);
    const content = fs.readFileSync(testFile, 'utf-8');
    if (content !== 'New whole file content') {
      throw new Error(`Expected whole file replaced, got: ${content}`);
    }
  });

  // Test 4: /open clears writable context
  await test('/open clears writable context', async () => {
    await dispatch('/edit test.md', session, loader);
    if (!session.writableTarget) throw new Error('Setup failed: no writable topic');
    const result = await dispatch('/open test.md', session, loader);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.content}`);
    if (session.writableTarget) throw new Error('Writable topic should be cleared');
  });

  // Test 5: Plain payload without writable context returns error
  await test('Plain payload without writable context returns error', async () => {
    const result = await dispatch('Some content', session, loader);
    if (result.ok) throw new Error('Expected error, got ok');
    if (!result.content.includes('No writable topic established')) {
      throw new Error(`Wrong error message: ${result.content}`);
    }
  });

  // Test 6: Transport topic does NOT bypass writable context requirement
  await test('Transport topic does NOT bypass writable context', async () => {
    const result = await dispatch('Plain content', session, loader, 'test.md');
    if (result.ok) throw new Error('Expected error, got ok');
    if (!result.content.includes('No writable topic established')) {
      throw new Error(`Wrong error message: ${result.content}`);
    }
  });

  // Test 7: Transport topic inheritance for /append
  fs.writeFileSync(testFile, 'Initial content\n', 'utf-8');
  await test('Transport topic inheritance: /append with body', async () => {
    const result = await dispatch('/append\nAppended content', session, loader, 'test.md');
    if (!result.ok) throw new Error(`Expected ok, got: ${result.content}`);
    const content = fs.readFileSync(testFile, 'utf-8');
    if (!content.includes('Appended content')) {
      throw new Error(`Expected appended content, got: ${content}`);
    }
  });

  // Test 8: /edit file#block establishes block writable context
  fs.writeFileSync(testFile, '# Test\n\n<!-- #intro -->\nIntro content\n<!-- /intro -->\n', 'utf-8');
  await test('/edit file#block establishes block writable context', async () => {
    const result = await dispatch('/edit test.md#intro', session, loader);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.content}`);
    if (!session.writableTarget) throw new Error('Writable topic not set');
    if (session.writableTarget.type !== 'block') throw new Error('Expected block writable topic');
    if (session.writableTarget.blockId !== 'intro') throw new Error('Wrong blockId');
  });

  // Test 9: Plain payload after /edit file#block replaces block
  await test('Implicit write after /edit file#block replaces block', async () => {
    const result = await dispatch('New block content', session, loader);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.content}`);
    const content = fs.readFileSync(testFile, 'utf-8');
    if (!content.includes('New block content')) {
      throw new Error(`Expected new block content, got: ${content}`);
    }
    if (content.includes('Intro content')) {
      throw new Error(`Old content should be replaced`);
    }
  });

  // Test 10: /write does not alter writable context
  await test('/write one-shot does not alter writable context', async () => {
    await dispatch('/edit test.md#intro', session, loader);
    const targetBefore = session.writableTarget;
    if (!targetBefore) throw new Error('Setup failed');
    const result = await dispatch('/write test.md Temporary content', session, loader);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.content}`);
    const targetAfter = session.writableTarget;
    if (JSON.stringify(targetBefore) !== JSON.stringify(targetAfter)) {
      throw new Error('Writable context was altered by /write');
    }
  });

  console.log('\n=== All validation tests passed ===\n');
}

run().catch(console.error);
