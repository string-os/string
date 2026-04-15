/**
 * SFMD Compiler — Trinity Architecture → compiled .md
 *
 * A "Trinity document" is a plain .md file that:
 *   1. Contains [!include:id]() directives (empty path = auto-convention)
 *   2. Has a sibling <name>.md.source/ directory
 *
 * The compiler inlines each include:
 *   [!include:id]()          → resolves to <name>.md.source/id.md
 *   [!include:id](path)      → resolves to path (relative to source dir)
 *
 * Auto-creation: if the source file doesn't exist, it is created as an empty
 * file so that AI agents can start editing immediately.
 *
 * Output: the compiled .md source (frontmatter stays in the skeleton .md)
 */

import fs from 'fs';
import path from 'path';

export interface CompileResult {
  output: string;
  warnings: string[];
  /** Source files auto-created during compilation */
  created: string[];
}

// Matches [!include:id](optional-path) as a standalone line
const INCLUDE_LINE_RE = /^\[!include:([a-zA-Z0-9_-]+)\]\(([^)]*)\)$/;

/**
 * Compile a Trinity document.
 *
 * @param sourceDir  Directory containing the .md skeleton
 * @param baseName   Filename without .md extension  (e.g. "intro")
 */
export function compile(sourceDir: string, baseName: string): CompileResult {
  const warnings: string[] = [];
  const created: string[] = [];

  const skeletonPath = path.join(sourceDir, `${baseName}.md`);
  const sourceSubDir = path.join(sourceDir, `${baseName}.md.source`);

  if (!fs.existsSync(skeletonPath)) {
    throw new Error(`Missing skeleton file: ${skeletonPath}`);
  }

  const skeleton = fs.readFileSync(skeletonPath, 'utf-8');
  const outputLines: string[] = [];

  for (const line of skeleton.split('\n')) {
    const match = line.trim().match(INCLUDE_LINE_RE);

    if (!match) {
      outputLines.push(line);
      continue;
    }

    const blockId = match[1];
    const rawPath = match[2].trim();

    // Resolve block file path
    let blockFile: string;
    if (rawPath === '') {
      // Auto-convention: <name>.md.source/<id>.md
      blockFile = path.join(sourceSubDir, `${blockId}.md`);
    } else {
      blockFile = path.resolve(sourceDir, rawPath);
      // Boundary check: rawPath must not escape sourceDir. Without this, an
      // SFMD include directive could inline /etc/passwd at compile time.
      const rel = path.relative(sourceDir, blockFile);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(
          `Include path escapes source directory: "${rawPath}" → ${blockFile}`
        );
      }
    }

    // Auto-create if missing
    if (!fs.existsSync(blockFile)) {
      const dir = path.dirname(blockFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(blockFile, '', 'utf-8');
      created.push(blockFile);
      warnings.push(`Created empty block source: ${blockFile}`);
    }

    const blockContent = fs.readFileSync(blockFile, 'utf-8').trim();
    outputLines.push(`<!-- #${blockId} -->`);
    if (blockContent) outputLines.push(blockContent);
    outputLines.push(`<!-- /${blockId} -->`);
  }

  return { output: outputLines.join('\n'), warnings, created };
}

/**
 * Check whether a .md file is a Trinity document (has a sibling .md.source/ dir).
 */
export function isTrinity(filePath: string): boolean {
  if (!filePath.endsWith('.md')) return false;
  const sourceDir = filePath + '.source';
  return fs.existsSync(sourceDir) && fs.statSync(sourceDir).isDirectory();
}
