/**
 * Test runner — shared state and helpers for all test files.
 * ESM live bindings allow assert() to update passed/failed counters.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { Browser } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WIKI = path.resolve(__dirname, '../../../compiler/examples/ai-wiki/index.md');

export let passed = 0;
export let failed = 0;

export function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

export async function section(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n── ${name} ──`);
  await fn();
}

export function mkBrowser(): Browser {
  return new Browser({ home: path.dirname(WIKI) });
}

export function printSummary(): void {
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
