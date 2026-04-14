#!/usr/bin/env node
/**
 * SFMD CLI
 *
 * Usage:
 *   sfmd compile  <dir> <base-name>     Compile Trinity document in-place
 *   sfmd validate <file.md>             Validate an SFMD document
 *   sfmd validate <dir>                 Validate all .md files + orphan check
 *   aimd extract  <file.md> <#block>    Extract a specific block
 *   aimd fix      <dir>                 Add missing [!include:] entries to skeleton .md
 *   aimd clean    <dir>                 Remove unreferenced .md.source/ files
 */

import fs from 'fs';
import path from 'path';
import { compile, isTrinity } from './compiler.js';
import { validate } from './validator.js';
import { extract } from '@string-os/core';

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`
SFMD Compiler v0.2

Commands:
  compile  <dir> <base-name>    Compile Trinity .md in-place (inlines [!include:]s)
  validate <path>               Validate document or directory (includes orphan check)
  extract  <file.md> <#block>   Extract content of a specific block
  fix      <dir>                Add missing [!include:] entries to skeleton .md files
  clean    <dir>                Remove unreferenced source files from .md.source/ dirs
`);
}

// ─── compile ──────────────────────────────────────────────────────────────────

function cmdCompile(): void {
  const dir = args[1];
  const baseName = args[2];
  if (!dir || !baseName) {
    console.error('Usage: sfmd compile <dir> <base-name>');
    process.exit(1);
  }

  try {
    const { output, warnings, created } = compile(dir, baseName);

    for (const w of warnings) console.warn(`[warn] ${w}`);
    for (const c of created) console.log(`[new]  ${c}`);

    // Write compiled output back to the .md file
    const outPath = path.join(dir, `${baseName}.md`);
    fs.writeFileSync(outPath, output, 'utf-8');
    console.log(`[ok]   Compiled → ${outPath}`);
  } catch (err) {
    console.error(`[err]  ${(err as Error).message}`);
    process.exit(1);
  }
}

// ─── validate ─────────────────────────────────────────────────────────────────

function cmdValidate(): void {
  const topic = args[1];
  if (!topic) {
    console.error('Usage: sfmd validate <file.md | dir>');
    process.exit(1);
  }

  if (!fs.existsSync(topic)) {
    console.error(`[err]  Not found: ${topic}`);
    process.exit(1);
  }

  const stat = fs.statSync(topic);
  let exitCode = 0;

  if (stat.isDirectory()) {
    const files = findMdFiles(topic);
    for (const f of files) {
      exitCode |= validateFile(f) ? 0 : 1;
    }
    // Orphan check across whole directory
    exitCode |= checkOrphans(topic) ? 0 : 1;
  } else {
    exitCode |= validateFile(topic) ? 0 : 1;
    if (isTrinity(topic)) {
      exitCode |= checkOrphans(path.dirname(topic)) ? 0 : 1;
    }
  }

  process.exit(exitCode);
}

function validateFile(filePath: string): boolean {
  const source = fs.readFileSync(filePath, 'utf-8');
  const result = validate(source);

  if (result.valid) {
    console.log(`[ok]   ${filePath}`);
  } else {
    console.log(`[fail] ${filePath} — ${result.errors.length} error(s)`);
    for (const e of result.errors) {
      console.log(`       line ${e.line}: ${e.message}`);
    }
  }

  return result.valid;
}

/**
 * For each .md.source/ directory, check that every .md file inside is
 * referenced by a [!include:id] in the parent skeleton .md.
 */
function checkOrphans(dir: string): boolean {
  let clean = true;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const fullPath = path.join(dir, entry.name);
      // Recurse into regular subdirs
      if (!entry.name.endsWith('.md.source')) {
        clean = checkOrphans(fullPath) && clean;
        continue;
      }

      // This is a .md.source/ directory — find parent skeleton
      const parentMd = path.join(dir, entry.name.slice(0, -'.source'.length));
      if (!fs.existsSync(parentMd)) {
        console.warn(`[warn] ${fullPath}/ — parent ${parentMd} not found`);
        clean = false;
        continue;
      }

      const parentSource = fs.readFileSync(parentMd, 'utf-8');
      const referencedIds = new Set(
        [...parentSource.matchAll(/\[!include:([a-zA-Z0-9_-]+)\]/g)].map(m => m[1]),
      );

      for (const child of fs.readdirSync(fullPath)) {
        if (!child.endsWith('.md')) continue;
        const blockId = child.slice(0, -'.md'.length);
        if (!referencedIds.has(blockId)) {
          console.warn(`[warn] ${path.join(fullPath, child)} — orphan (not referenced by ${path.basename(parentMd)})`);
          clean = false;
        }
      }
    }
  }

  return clean;
}

// ─── extract ──────────────────────────────────────────────────────────────────

function cmdExtract(): void {
  const filePath = args[1];
  const fragment = args[2];
  if (!filePath || !fragment) {
    console.error('Usage: aimd extract <file.md> <#block-id>');
    process.exit(1);
  }

  const blockId = fragment.startsWith('#') ? fragment.slice(1) : fragment;

  if (!fs.existsSync(filePath)) {
    console.error(`[err]  File not found: ${filePath}`);
    process.exit(1);
  }

  const source = fs.readFileSync(filePath, 'utf-8');
  const result = extract(source, blockId);

  if (result.found) {
    console.log(result.content);
  } else {
    console.error(`!ERR EXTRACT BLOCK_NOT_FOUND ${filePath}#${blockId}`);
    process.exit(1);
  }
}

// ─── fix ──────────────────────────────────────────────────────────────────────

/**
 * For each .md.source/ directory, find orphan source files and append the
 * missing [!include:id]() directives to the parent skeleton .md.
 */
function cmdFix(): void {
  const dir = args[1];
  if (!dir) {
    console.error('Usage: aimd fix <dir>');
    process.exit(1);
  }

  fixDir(dir);
}

function fixDir(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(dir, entry.name);

    if (!entry.name.endsWith('.md.source')) {
      fixDir(fullPath);
      continue;
    }

    const parentMd = path.join(dir, entry.name.slice(0, -'.source'.length));
    if (!fs.existsSync(parentMd)) continue;

    const parentSource = fs.readFileSync(parentMd, 'utf-8');
    const referencedIds = new Set(
      [...parentSource.matchAll(/\[!include:([a-zA-Z0-9_-]+)\]/g)].map(m => m[1]),
    );

    const toAdd: string[] = [];
    for (const child of fs.readdirSync(fullPath)) {
      if (!child.endsWith('.md')) continue;
      const blockId = child.slice(0, -'.md'.length);
      if (!referencedIds.has(blockId)) {
        toAdd.push(blockId);
      }
    }

    if (toAdd.length > 0) {
      const additions = toAdd.map(id => `\n[!include:${id}]()`).join('');
      fs.appendFileSync(parentMd, additions, 'utf-8');
      for (const id of toAdd) {
        console.log(`[fix]  Added [!include:${id}]() → ${parentMd}`);
      }
    }
  }
}

// ─── clean ────────────────────────────────────────────────────────────────────

function cmdClean(): void {
  const dir = args[1];
  if (!dir) {
    console.error('Usage: aimd clean <dir>');
    process.exit(1);
  }

  cleanDir(dir);
}

function cleanDir(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(dir, entry.name);

    if (!entry.name.endsWith('.md.source')) {
      cleanDir(fullPath);
      continue;
    }

    const parentMd = path.join(dir, entry.name.slice(0, -'.source'.length));
    if (!fs.existsSync(parentMd)) continue;

    const parentSource = fs.readFileSync(parentMd, 'utf-8');
    const referencedIds = new Set(
      [...parentSource.matchAll(/\[!include:([a-zA-Z0-9_-]+)\]/g)].map(m => m[1]),
    );

    for (const child of fs.readdirSync(fullPath)) {
      if (!child.endsWith('.md')) continue;
      const blockId = child.slice(0, -'.md'.length);
      if (!referencedIds.has(blockId)) {
        const filePath = path.join(fullPath, child);
        fs.unlinkSync(filePath);
        console.log(`[del]  ${filePath}`);
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findMdFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.endsWith('.md.source')) {
      results.push(...findMdFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

switch (command) {
  case 'compile':  cmdCompile();  break;
  case 'validate': cmdValidate(); break;
  case 'extract':  cmdExtract();  break;
  case 'fix':      cmdFix();      break;
  case 'clean':    cmdClean();    break;
  default:
    usage();
    if (command) {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
}
