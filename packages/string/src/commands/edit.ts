/**
 * Editing commands: /write, /append, /replace, /edit, /undo, /verify
 */

import fsPromises from 'fs/promises';
import fs from 'fs';
import path from 'path';
import { extract } from '@string-os/core';
import type { Loader } from '../loader.js';
import type { Session } from '../session.js';
import type { CommandResult } from '../types.js';
import { formatDiff, formatLineNumbers } from '../diff.js';
import { resolveConfig } from '../config.js';
import {
  ok, err,
  fileSha256,
  finalizeUndoRecord,
  parsePosixFlags,
  readUndoRecord,
  saveUndoBackup,
  toWorkspacePath,
  resolveFilePath,
  validateWorkspaceBoundary,
  findHeadingBlockRange,
} from './helpers.js';

interface TargetFlags {
  target: string;
  force: boolean;
}

function parseTargetFlags(args: string): TargetFlags | null {
  const parsed = parsePosixFlags(args);
  if (!parsed) return null;
  if (parsed.rest.length === 1) {
    return {
      target: parsed.rest[0],
      force: parsed.bareFlags.has('force') || parsed.flags.force === 'true',
    };
  }
  // Accept `/write --force path` even though the generic POSIX parser treats
  // `path` as the value of --force.
  if (parsed.rest.length === 0 && parsed.flags.force && parsed.flags.force !== 'true') {
    return { target: parsed.flags.force, force: true };
  }
  return null;
}

function parseReplaceTargetFlags(args: string): { target: string; all: boolean } | null {
  const parsed = parsePosixFlags(args);
  if (!parsed) return null;
  if (parsed.rest.length === 1) {
    return {
      target: parsed.rest[0],
      all: parsed.bareFlags.has('all') || parsed.flags.all === 'true',
    };
  }
  // Accept `/replace --all path` in addition to `/replace path --all`.
  if (parsed.rest.length === 0 && parsed.flags.all && parsed.flags.all !== 'true') {
    return { target: parsed.flags.all, all: true };
  }
  return null;
}

function requireSeenBeforeWholeOverwrite(
  resolved: string,
  filePath: string,
  session: Session,
  force: boolean,
): CommandResult | null {
  if (force) return null;

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    const seen = session.seenFile(resolved);
    if (!seen) {
      return err(
        `Refusing to overwrite existing file not read in this topic: ${filePath}\n` +
        `Run /open ${filePath} or /edit ${filePath} first, then retry. ` +
        `Use --force only when you intend to replace the whole file.`,
        'CONFLICT'
      );
    }
    if (seen.mtimeMs !== stat.mtimeMs || seen.size !== stat.size) {
      return err(
        `Refusing to overwrite changed file: ${filePath}\n` +
        `The file changed since this topic last read it. Run /edit ${filePath} again, then retry. ` +
        `Use --force only when you intend to replace the current whole file.`,
        'CONFLICT'
      );
    }
  } catch {
    // New files are safe; missing paths will be created by /write.
  }

  return null;
}

async function markSeenAfterWrite(resolved: string, session: Session): Promise<void> {
  try {
    const stat = await fsPromises.stat(resolved);
    session.markFileSeen(resolved, stat);
    const recordPath = session.lastUndoRecordPath;
    if (recordPath) await finalizeUndoRecord(recordPath, resolved);
  } catch { /* best-effort stale-write tracking */ }
}

// ─── /write ───────────────────────────────────────────────────────────────────

export async function cmdWrite(
  args: string,
  body: string | undefined,
  session: Session,
  loader: Loader,
): Promise<CommandResult> {
  const home = loader.home;

  // Multiline format: /write <path>\n<content>
  if (body !== undefined) {
    const targetFlags = parseTargetFlags(args);
    if (!targetFlags) {
      return err('Usage: /write [--force] <path>\n<content>', 'INVALID_TARGET');
    }
    const filePath = targetFlags.target;

    // Block write: /write file#block\n<content> → delegate to /edit
    if (filePath.includes('#')) {
      return cmdEdit(filePath, body, session, loader);
    }

    const resolved = resolveFilePath(filePath, home, session.currentUri, session.cwdOverride);
    const boundaryError = validateWorkspaceBoundary(resolved, home, filePath, loader.accessMode);
    if (boundaryError) return boundaryError;
    const staleError = requireSeenBeforeWholeOverwrite(resolved, filePath, session, targetFlags.force);
    if (staleError) return staleError;

    try {
      const dir = path.dirname(resolved);
      await fsPromises.mkdir(dir, { recursive: true });
      const oldContent = await saveUndoBackup(resolved, session, loader);
      await fsPromises.writeFile(resolved, body, 'utf-8');
      const stat = await fsPromises.stat(resolved);
      await markSeenAfterWrite(resolved, session);

      const config = resolveConfig(session);
      const diff = formatDiff(oldContent, body, { context: config.diffContext, maxLines: config.diffMaxLines });
      const lineCount = body.split('\n').length;
      const label = oldContent ? 'Written:' : 'Created:';
      return ok(`${label} ${filePath} (${stat.size} bytes, ${lineCount} lines)\n---\n${diff}\n---\nUse /undo to revert.`);
    } catch (e) {
      return err(`Write failed: ${(e as Error).message}`, 'INTERNAL_ERROR');
    }
  }

  // Single-line format: /write <path> <content>
  const spaceIdx = args.indexOf(' ');
  if (spaceIdx === -1 || !args.trim()) {
    return err(
      'Usage: /write <path> <content>\n' +
      'Or multiline:\n' +
      '  /write <path>\n' +
      '  content here\n' +
      '  with real newlines',
      'INVALID_TARGET'
    );
  }

  const filePath = args.slice(0, spaceIdx).trim();
  const content = args.slice(spaceIdx + 1);

  // Block write: /write file#block <content> → delegate to /edit
  if (filePath.includes('#')) {
    return cmdEdit(filePath, content, session, loader);
  }

  const resolved = resolveFilePath(filePath, home, session.currentUri, session.cwdOverride);
  const boundaryError = validateWorkspaceBoundary(resolved, home, filePath, loader.accessMode);
  if (boundaryError) return boundaryError;
  const staleError = requireSeenBeforeWholeOverwrite(resolved, filePath, session, false);
  if (staleError) return staleError;

  try {
    const dir = path.dirname(resolved);
    await fsPromises.mkdir(dir, { recursive: true });
    const oldContent = await saveUndoBackup(resolved, session, loader);
    await fsPromises.writeFile(resolved, content, 'utf-8');
    const stat = await fsPromises.stat(resolved);
    await markSeenAfterWrite(resolved, session);

    const config = resolveConfig(session);
    const diff = formatDiff(oldContent, content, { context: config.diffContext, maxLines: config.diffMaxLines });
    const lineCount = content.split('\n').length;
    const label = oldContent ? 'Written:' : 'Created:';
    return ok(`${label} ${filePath} (${stat.size} bytes, ${lineCount} lines)\n---\n${diff}\n---\nUse /undo to revert.`);
  } catch (e) {
    return err(`Write failed: ${(e as Error).message}`, 'INTERNAL_ERROR');
  }
}

// ─── /append ──────────────────────────────────────────────────────────────────

export async function cmdAppend(
  args: string,
  body: string | undefined,
  session: Session,
  loader: Loader,
): Promise<CommandResult> {
  const home = loader.home;

  // Multiline format: /append <path>\n<content>
  if (body !== undefined) {
    const filePath = args.trim();
    if (!filePath) {
      return err('Usage: /append <path>\n<content>', 'INVALID_TARGET');
    }

    const resolved = resolveFilePath(filePath, home, session.currentUri, session.cwdOverride);
    const boundaryError = validateWorkspaceBoundary(resolved, home, filePath, loader.accessMode);
    if (boundaryError) return boundaryError;

    try {
      await fsPromises.access(resolved);
    } catch {
      return err(`File not found: ${filePath}`, 'NOT_FOUND');
    }

    try {
      const oldContent = await saveUndoBackup(resolved, session, loader);
      const prefix = oldContent.length > 0 && !oldContent.endsWith('\n') ? '\n' : '';
      const newContent = oldContent + prefix + body;
      await fsPromises.writeFile(resolved, newContent, 'utf-8');
      const stat = await fsPromises.stat(resolved);
      await markSeenAfterWrite(resolved, session);
      const config = resolveConfig(session);
      const diff = formatDiff(oldContent, newContent, { context: config.diffContext, maxLines: config.diffMaxLines });
      return ok(`Appended to: ${filePath} (now ${stat.size} bytes)\n---\n${diff}\n---\nUse /undo to revert.`);
    } catch (e) {
      return err(`Append failed: ${(e as Error).message}`, 'INTERNAL_ERROR');
    }
  }

  // Single-line format: /append <path> <content>
  const spaceIdx = args.indexOf(' ');
  if (spaceIdx === -1 || !args.trim()) {
    return err(
      'Usage: /append <path> <content>\n' +
      'Or multiline:\n' +
      '  /append <path>\n' +
      '  content here',
      'INVALID_TARGET'
    );
  }

  const filePath = args.slice(0, spaceIdx).trim();
  const content = args.slice(spaceIdx + 1);

  const resolved = resolveFilePath(filePath, home, session.currentUri, session.cwdOverride);
  const boundaryError = validateWorkspaceBoundary(resolved, home, filePath, loader.accessMode);
  if (boundaryError) return boundaryError;

  try {
    await fsPromises.access(resolved);
  } catch {
    return err(`File not found: ${filePath}`, 'NOT_FOUND');
  }

  try {
    const oldContent = await saveUndoBackup(resolved, session, loader);
    const prefix = oldContent.length > 0 && !oldContent.endsWith('\n') ? '\n' : '';
    const newContent = oldContent + prefix + content;
    await fsPromises.writeFile(resolved, newContent, 'utf-8');
    const stat = await fsPromises.stat(resolved);
    await markSeenAfterWrite(resolved, session);
    const config = resolveConfig(session);
    const diff = formatDiff(oldContent, newContent, { context: config.diffContext, maxLines: config.diffMaxLines });
    return ok(`Appended to: ${filePath} (now ${stat.size} bytes)\n---\n${diff}\n---\nUse /undo to revert.`);
  } catch (e) {
    return err(`Append failed: ${(e as Error).message}`, 'INTERNAL_ERROR');
  }
}

// ─── /edit ────────────────────────────────────────────────────────────────────

export async function cmdEdit(
  args: string,
  body: string | undefined,
  session: Session,
  loader: Loader,
): Promise<CommandResult> {
  const home = loader.home;

  // Multiline format: /edit <path>[#<blockId>]\n<content>
  if (body !== undefined) {
    const targetFlags = parseTargetFlags(args);
    if (!targetFlags) {
      return err('Usage: /edit [--force] <path>[#<blockId>]\n<content>', 'INVALID_TARGET');
    }
    const targetStr = targetFlags.target;

    const hashIdx = targetStr.indexOf('#');

    // Whole-file edit mode: /edit file\ncontent
    if (hashIdx === -1) {
      const filePath = targetStr;
      const resolved = resolveFilePath(filePath, home, session.currentUri, session.cwdOverride);
      const boundaryError = validateWorkspaceBoundary(resolved, home, filePath, loader.accessMode);
      if (boundaryError) return boundaryError;
      const staleError = requireSeenBeforeWholeOverwrite(resolved, filePath, session, targetFlags.force);
      if (staleError) return staleError;

      let oldContent: string;
      try {
        oldContent = await saveUndoBackup(resolved, session, loader);
        await fsPromises.writeFile(resolved, body, 'utf-8');
        await markSeenAfterWrite(resolved, session);
      } catch (e) {
        return err(`Edit failed: ${(e as Error).message}`, 'INTERNAL_ERROR');
      }

      const config = resolveConfig(session);
      const diff = formatDiff(oldContent, body, { context: config.diffContext, maxLines: config.diffMaxLines });
      const lineCount = body.split('\n').length;
      return ok(`Edited ${filePath} (${lineCount} lines, whole file)\n---\n${diff}\n---\nUse /undo to revert.`);
    }

    // Block edit mode: /edit file#block\ncontent
    const filePath = targetStr.slice(0, hashIdx);
    const blockId = targetStr.slice(hashIdx + 1);

    if (!filePath || !blockId) {
      return err('Usage: /edit <path>#<blockId>\n<content>', 'INVALID_TARGET');
    }

    const resolved = resolveFilePath(filePath, home, session.currentUri, session.cwdOverride);
    const boundaryError = validateWorkspaceBoundary(resolved, home, filePath, loader.accessMode);
    if (boundaryError) return boundaryError;

    let source: string;
    try {
      source = await fsPromises.readFile(resolved, 'utf-8');
      const stat = await fsPromises.stat(resolved);
      session.markFileSeen(resolved, stat);
    } catch {
      return err(`File not found: ${filePath}`, 'NOT_FOUND');
    }

    // Priority 1: Check for explicit markers
    const openMarker = `<!-- #${blockId} -->`;
    const closeMarker = `<!-- /${blockId} -->`;
    const openIdx = source.indexOf(openMarker);
    const closeIdx = source.indexOf(closeMarker);

    let newSource: string;
    let usedMarkers = false;

    if (openIdx !== -1 && closeIdx !== -1) {
      // Explicit marker-based block: replace content between markers
      // Preserve exact prefix/suffix to avoid formatting drift
      const contentStart = openIdx + openMarker.length;
      const contentEnd = closeIdx;

      // Preserve whitespace structure: extract original boundary characters
      const originalContent = source.slice(contentStart, contentEnd);
      const leadingNewlines = originalContent.match(/^\n*/)?.[0] || '';
      const trailingNewlines = originalContent.match(/\n*$/)?.[0] || '';

      const prefix = source.slice(0, contentStart);
      const suffix = source.slice(contentEnd);

      // Handle trailing newlines: if body ends with \n, skip first trailing \n
      const bodyEndsWithNewline = body.endsWith('\n');
      const preservedTrailing = bodyEndsWithNewline && trailingNewlines.length > 0
        ? trailingNewlines.slice(1)
        : trailingNewlines;

      newSource = prefix + leadingNewlines + body + preservedTrailing + suffix;
      usedMarkers = true;
    } else {
      // Priority 2: Try heading-derived block editing (explicit ID or slug)
      const headingRange = findHeadingBlockRange(source, blockId);
      if (!headingRange) {
        return err(
          `Block #${blockId} not found in ${filePath}.\n` +
          `Supported formats (in priority order):\n` +
          `  1. Explicit markers: <!-- #${blockId} --> ... <!-- /${blockId} -->\n` +
          `  2. Explicit ID: ## Heading {#${blockId}} or ## Heading []{#${blockId}}\n` +
          `  3. Heading slug: ## Heading Text (where slug matches "${blockId}")`,
          'NOT_FOUND'
        );
      }

      // Replace block body (preserve heading, replace content below it)
      // Use byte-level replacement to preserve exact formatting
      const lines = source.split('\n');

      // Find byte positions for the editable body region
      // Start: after heading line
      // End: before next heading (or EOF)
      let contentStart = 0;
      for (let i = 0; i <= headingRange.startLine; i++) {
        contentStart += lines[i].length + 1; // +1 for newline
      }

      let contentEnd = contentStart;
      for (let i = headingRange.startLine + 1; i < headingRange.endLine; i++) {
        contentEnd += lines[i].length + 1;
      }

      // Extract original body to preserve boundary whitespace
      const originalBody = source.slice(contentStart, contentEnd);
      const leadingNewlines = originalBody.match(/^\n*/)?.[0] || '';
      const trailingNewlines = originalBody.match(/\n*$/)?.[0] || '';

      const prefix = source.slice(0, contentStart);
      const suffix = source.slice(contentEnd);

      // Handle trailing newlines correctly based on new body format
      // trailingNewlines includes: line-ending (\n) + blank lines (\n\n...)
      // If new body already ends with \n, skip first trailing newline (it's redundant)
      // If new body has no trailing \n, include all trailing newlines
      const bodyEndsWithNewline = body.endsWith('\n');
      const preservedTrailing = bodyEndsWithNewline && trailingNewlines.length > 0
        ? trailingNewlines.slice(1)  // Skip first \n (body already has it)
        : trailingNewlines;            // Include all (body needs line-ending)

      newSource = prefix + leadingNewlines + body + preservedTrailing + suffix;
    }


    let oldContent: string;
    try {
      oldContent = await saveUndoBackup(resolved, session, loader);
      await fsPromises.writeFile(resolved, newSource, 'utf-8');
      await markSeenAfterWrite(resolved, session);
    } catch (e) {
      return err(`Edit failed: ${(e as Error).message}`, 'INTERNAL_ERROR');
    }

    // Verify the edit
    if (usedMarkers) {
      const verify = extract(newSource, blockId);
      if (!verify.found) {
        return err(
          `Edit wrote successfully but verification failed.\n` +
          `Block #${blockId} not found after write. File may be corrupted.\n` +
          `Recovery: /refresh to reload, or /edit again with correct content.`,
          'INTERNAL_ERROR'
        );
      }
    } else {
      const verifyRange = findHeadingBlockRange(newSource, blockId);
      if (!verifyRange) {
        return err(
          `Edit wrote successfully but verification failed.\n` +
          `Block #${blockId} not found after write. File may be corrupted.\n` +
          `Recovery: /refresh to reload, or /edit again with correct content.`,
          'INTERNAL_ERROR'
        );
      }
    }

    const config = resolveConfig(session);
    const diff = formatDiff(oldContent, newSource, { context: config.diffContext, maxLines: config.diffMaxLines });
    const lineCount = newSource.split('\n').length;
    return ok(`Edited ${filePath}#${blockId} (${lineCount} lines)\n---\n${diff}\n---\nUse /undo to revert.`);
  }

  // Single-line format: /edit <path>[#<blockId>] [<content>]
  const spaceIdx = args.indexOf(' ');

  // No space: /edit <path> or /edit <path>#<blockId> (no content, just establish context)
  if (spaceIdx === -1) {
    const targetStr = args.trim();
    if (!targetStr) {
      return err(
        'Usage: /edit <path>[#<blockId>] [<content>]\n' +
        'Or multiline:\n' +
        '  /edit <path>[#<blockId>]\n' +
        '  content here',
        'INVALID_TARGET'
      );
    }

    const hashIdx = targetStr.indexOf('#');

    // Whole-file edit context: /edit file (no content, just open for editing)
    if (hashIdx === -1) {
      const filePath = targetStr;
      const resolved = resolveFilePath(filePath, home, session.currentUri, session.cwdOverride);
      const boundaryError = validateWorkspaceBoundary(resolved, home, filePath, loader.accessMode);
      if (boundaryError) return boundaryError;

      // Load and display file
      let source: string;
      try {
        source = await fsPromises.readFile(resolved, 'utf-8');
        const stat = await fsPromises.stat(resolved);
        session.markFileSeen(resolved, stat);
      } catch {
        return err(`File not found: ${filePath}`, 'NOT_FOUND');
      }


      const lineCount = source.split('\n').length;
      const numbered = formatLineNumbers(source);
      return ok(`[editing: ${filePath}]\n---\n${numbered}\n\n(${lineCount} lines)`);
    }

    // Block edit context: /edit file#block (no content, just establish context)
    const filePath = targetStr.slice(0, hashIdx);
    const blockId = targetStr.slice(hashIdx + 1);

    if (!filePath || !blockId) {
      return err('Usage: /edit <path>#<blockId>', 'INVALID_TARGET');
    }

    const resolved = resolveFilePath(filePath, home, session.currentUri, session.cwdOverride);
    const boundaryError = validateWorkspaceBoundary(resolved, home, filePath, loader.accessMode);
    if (boundaryError) return boundaryError;

    let source: string;
    try {
      source = await fsPromises.readFile(resolved, 'utf-8');
    } catch {
      return err(`File not found: ${filePath}`, 'NOT_FOUND');
    }

    // Extract block content for display
    const extracted = extract(source, blockId);
    if (!extracted.found) {
      return err(`Block not found: #${blockId} in ${filePath}`, 'NOT_FOUND');
    }

    const lineCount = extracted.content.split('\n').length;
    const numbered = formatLineNumbers(extracted.content);
    return ok(`[editing: ${filePath}#${blockId}]\n---\n${numbered}\n\n(${lineCount} lines)`);
  }

  // Has space: /edit <path>[#<blockId>] <content>
  const targetStr = args.slice(0, spaceIdx).trim();
  const content = args.slice(spaceIdx + 1);

  const hashIdx = targetStr.indexOf('#');

  // Whole-file edit with inline content: /edit file content
  if (hashIdx === -1) {
    const filePath = targetStr;
    const resolved = resolveFilePath(filePath, home, session.currentUri, session.cwdOverride);
    const boundaryError = validateWorkspaceBoundary(resolved, home, filePath, loader.accessMode);
    if (boundaryError) return boundaryError;
    const staleError = requireSeenBeforeWholeOverwrite(resolved, filePath, session, false);
    if (staleError) return staleError;

    let oldContent: string;
    try {
      oldContent = await saveUndoBackup(resolved, session, loader);
      await fsPromises.writeFile(resolved, content, 'utf-8');
      await markSeenAfterWrite(resolved, session);
    } catch (e) {
      return err(`Edit failed: ${(e as Error).message}`, 'INTERNAL_ERROR');
    }

    const config = resolveConfig(session);
    const diff = formatDiff(oldContent, content, { context: config.diffContext, maxLines: config.diffMaxLines });
    const lineCount = content.split('\n').length;
    return ok(`Edited ${filePath} (${lineCount} lines, whole file)\n---\n${diff}\n---\nUse /undo to revert.`);
  }

  // Block edit with inline content: /edit file#block content
  const filePath = targetStr.slice(0, hashIdx);
  const blockId = targetStr.slice(hashIdx + 1);

  if (!filePath || !blockId) {
    return err('Usage: /edit <path>#<blockId> <content>', 'INVALID_TARGET');
  }

  const resolved = resolveFilePath(filePath, home, session.currentUri, session.cwdOverride);
  const boundaryError = validateWorkspaceBoundary(resolved, home, filePath, loader.accessMode);
  if (boundaryError) return boundaryError;

  let source: string;
  try {
    source = await fsPromises.readFile(resolved, 'utf-8');
  } catch {
    return err(`File not found: ${filePath}`, 'NOT_FOUND');
  }

  // Priority 1: Check for explicit markers
  const openMarker = `<!-- #${blockId} -->`;
  const closeMarker = `<!-- /${blockId} -->`;
  const openIdx = source.indexOf(openMarker);
  const closeIdx = source.indexOf(closeMarker);

  let newSource: string;
  let usedMarkers = false;

  if (openIdx !== -1 && closeIdx !== -1) {
    // Explicit marker-based block: replace content between markers
    // Preserve exact prefix/suffix to avoid formatting drift
    const contentStart = openIdx + openMarker.length;
    const contentEnd = closeIdx;

    // Preserve whitespace structure: extract original boundary characters
    const originalContent = source.slice(contentStart, contentEnd);
    const leadingNewlines = originalContent.match(/^\n*/)?.[0] || '';
    const trailingNewlines = originalContent.match(/\n*$/)?.[0] || '';

    const prefix = source.slice(0, contentStart);
    const suffix = source.slice(contentEnd);

    // Handle trailing newlines: if content ends with \n, skip first trailing \n
    const contentEndsWithNewline = content.endsWith('\n');
    const preservedTrailing = contentEndsWithNewline && trailingNewlines.length > 0
      ? trailingNewlines.slice(1)
      : trailingNewlines;

    newSource = prefix + leadingNewlines + content + preservedTrailing + suffix;
    usedMarkers = true;
  } else {
    // Priority 2: Try heading-derived block editing (explicit ID or slug)
    const headingRange = findHeadingBlockRange(source, blockId);
    if (!headingRange) {
      return err(
        `Block #${blockId} not found in ${filePath}.\n` +
        `Supported formats (in priority order):\n` +
        `  1. Explicit markers: <!-- #${blockId} --> ... <!-- /${blockId} -->\n` +
        `  2. Explicit ID: ## Heading {#${blockId}} or ## Heading []{#${blockId}}\n` +
        `  3. Heading slug: ## Heading Text (where slug matches "${blockId}")`,
        'NOT_FOUND'
      );
    }

    // Replace block body (preserve heading, replace content below it)
    // Use byte-level replacement to preserve exact formatting
    const lines = source.split('\n');

    // Find byte positions for the editable body region
    // Start: after heading line
    // End: before next heading (or EOF)
    let contentStart = 0;
    for (let i = 0; i <= headingRange.startLine; i++) {
      contentStart += lines[i].length + 1; // +1 for newline
    }

    let contentEnd = contentStart;
    for (let i = headingRange.startLine + 1; i < headingRange.endLine; i++) {
      contentEnd += lines[i].length + 1;
    }

    // Extract original body to preserve boundary whitespace
    const originalBody = source.slice(contentStart, contentEnd);
    const leadingNewlines = originalBody.match(/^\n*/)?.[0] || '';
    const trailingNewlines = originalBody.match(/\n*$/)?.[0] || '';

    const prefix = source.slice(0, contentStart);
    const suffix = source.slice(contentEnd);

    // Handle trailing newlines: if content ends with \n, skip first trailing \n
    const contentEndsWithNewline = content.endsWith('\n');
    const preservedTrailing = contentEndsWithNewline && trailingNewlines.length > 0
      ? trailingNewlines.slice(1)
      : trailingNewlines;

    newSource = prefix + leadingNewlines + content + preservedTrailing + suffix;
  }

  let oldContent: string;
  try {
    oldContent = await saveUndoBackup(resolved, session, loader);
    await fsPromises.writeFile(resolved, newSource, 'utf-8');
    await markSeenAfterWrite(resolved, session);
  } catch (e) {
    return err(`Edit failed: ${(e as Error).message}`, 'INTERNAL_ERROR');
  }

  // Verify the edit
  if (usedMarkers) {
    const verify = extract(newSource, blockId);
    if (!verify.found) {
      return err(
        `Edit wrote successfully but verification failed.\n` +
        `Block #${blockId} not found after write. File may be corrupted.\n` +
        `Recovery: /refresh to reload, or /edit again with correct content.`,
        'INTERNAL_ERROR'
      );
    }
  } else {
    const verifyRange = findHeadingBlockRange(newSource, blockId);
    if (!verifyRange) {
      return err(
        `Edit wrote successfully but verification failed.\n` +
        `Block #${blockId} not found after write. File may be corrupted.\n` +
        `Recovery: /refresh to reload, or /edit again with correct content.`,
        'INTERNAL_ERROR'
      );
    }
  }

  const config = resolveConfig(session);
  const diff = formatDiff(oldContent, newSource, { context: config.diffContext, maxLines: config.diffMaxLines });
  const lineCount = newSource.split('\n').length;
  return ok(`Edited ${filePath}#${blockId} (${lineCount} lines)\n---\n${diff}\n---\nUse /undo to revert.`);
}

// ─── /replace ────────────────────────────────────────────────────────────────

function splitReplaceBody(body: string): { oldText: string; newText: string } | null {
  const lines = body.split('\n');
  const sepIdx = lines.findIndex(line => line.trim() === '---');
  if (sepIdx === -1) return null;
  return {
    oldText: lines.slice(0, sepIdx).join('\n'),
    newText: lines.slice(sepIdx + 1).join('\n'),
  };
}

function parseLineTarget(target: string): { filePath: string; startLine: number; endLine: number } | null {
  const match = target.match(/^(.*):L(\d+)(?:-L?(\d+))?$/);
  if (!match) return null;
  const filePath = match[1];
  const startLine = Number(match[2]);
  const endLine = match[3] ? Number(match[3]) : startLine;
  if (!filePath || !Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  return { filePath, startLine, endLine };
}

function countOccurrences(source: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = source.indexOf(needle, idx);
    if (found === -1) return count;
    count++;
    idx = found + needle.length;
  }
}

function ambiguityPreview(source: string, needle: string, max = 3): string {
  const previews: string[] = [];
  let idx = 0;
  while (previews.length < max) {
    const found = source.indexOf(needle, idx);
    if (found === -1) break;
    const start = Math.max(0, found - 40);
    const end = Math.min(source.length, found + needle.length + 40);
    const snippet = source.slice(start, end).replace(/\n/g, '\\n');
    previews.push(`- ...${snippet}...`);
    idx = found + needle.length;
  }
  return previews.join('\n');
}

export async function cmdReplace(
  args: string,
  body: string | undefined,
  session: Session,
  loader: Loader,
): Promise<CommandResult> {
  const home = loader.home;
  const parsed = parseReplaceTargetFlags(args);
  if (!parsed) {
    return err(
      'Usage:\n' +
      '  /replace <path>\nold text\n---\nnew text\n' +
      '  /replace <path> --all\nold text\n---\nnew text\n' +
      '  /replace <path>#block\nreplacement content\n' +
      '  /replace <path>:L5[-L10]\nreplacement content',
      'INVALID_TARGET'
    );
  }
  if (body === undefined) {
    return err('Usage: /replace <target>\n<replacement body>', 'INVALID_PAYLOAD');
  }

  const target = parsed.target;
  const replaceAll = parsed.all;

  if (target.includes('#')) {
    return cmdEdit(target, body, session, loader);
  }

  const lineTarget = parseLineTarget(target);
  if (lineTarget) {
    const { filePath, startLine, endLine } = lineTarget;
    if (startLine < 1 || endLine < startLine) {
      return err(`Invalid line range: L${startLine}-L${endLine}`, 'INVALID_TARGET');
    }

    const resolved = resolveFilePath(filePath, home, session.currentUri, session.cwdOverride);
    const boundaryError = validateWorkspaceBoundary(resolved, home, filePath, loader.accessMode);
    if (boundaryError) return boundaryError;

    let source: string;
    try {
      source = await fsPromises.readFile(resolved, 'utf-8');
    } catch {
      return err(`File not found: ${filePath}`, 'NOT_FOUND');
    }

    const lines = source.split('\n');
    if (endLine > lines.length) {
      return err(
        `Line range out of bounds: ${filePath}:L${startLine}${endLine === startLine ? '' : `-L${endLine}`} ` +
        `(file has ${lines.length} lines)\nRecovery: run /edit ${filePath} for current line numbers.`,
        'INVALID_TARGET'
      );
    }

    const replacementLines = body.split('\n');
    const newLines = [
      ...lines.slice(0, startLine - 1),
      ...replacementLines,
      ...lines.slice(endLine),
    ];
    const newSource = newLines.join('\n');

    try {
      const oldContent = await saveUndoBackup(resolved, session, loader);
      await fsPromises.writeFile(resolved, newSource, 'utf-8');
      await markSeenAfterWrite(resolved, session);
      const config = resolveConfig(session);
      const diff = formatDiff(oldContent, newSource, { context: config.diffContext, maxLines: config.diffMaxLines });
      return ok(`Replaced ${filePath}:L${startLine}${endLine === startLine ? '' : `-L${endLine}`}\n---\n${diff}\n---\nUse /undo to revert.`);
    } catch (e) {
      return err(`Replace failed: ${(e as Error).message}`, 'INTERNAL_ERROR');
    }
  }

  const pair = splitReplaceBody(body);
  if (!pair) {
    return err(
      'Substring replace body must contain a separator line:\n' +
      '/replace <path>\nold text\n---\nnew text',
      'INVALID_PAYLOAD'
    );
  }
  if (pair.oldText === '') {
    return err('Old text cannot be empty.', 'INVALID_PAYLOAD');
  }

  const filePath = target;
  const resolved = resolveFilePath(filePath, home, session.currentUri, session.cwdOverride);
  const boundaryError = validateWorkspaceBoundary(resolved, home, filePath, loader.accessMode);
  if (boundaryError) return boundaryError;

  let source: string;
  try {
    source = await fsPromises.readFile(resolved, 'utf-8');
  } catch {
    return err(`File not found: ${filePath}`, 'NOT_FOUND');
  }

  const matches = countOccurrences(source, pair.oldText);
  if (matches === 0) {
    return err(`Old text not found in ${filePath}.`, 'NOT_FOUND');
  }
  if (matches > 1 && !replaceAll) {
    const preview = ambiguityPreview(source, pair.oldText);
    return err(
      `Old text matched ${matches} times in ${filePath}; refusing ambiguous replace.\n` +
      `Use /replace <path> --all to replace every occurrence, or provide a larger unique old text.\n` +
      `Matches:\n${preview}`,
      'CONFLICT'
    );
  }

  const newSource = replaceAll
    ? source.split(pair.oldText).join(pair.newText)
    : source.replace(pair.oldText, pair.newText);

  try {
    const oldContent = await saveUndoBackup(resolved, session, loader);
    await fsPromises.writeFile(resolved, newSource, 'utf-8');
    await markSeenAfterWrite(resolved, session);
    const config = resolveConfig(session);
    const diff = formatDiff(oldContent, newSource, { context: config.diffContext, maxLines: config.diffMaxLines });
    return ok(`Replaced ${matches === 1 ? '1 occurrence' : `${matches} occurrences`} in ${filePath}\n---\n${diff}\n---\nUse /undo to revert.`);
  } catch (e) {
    return err(`Replace failed: ${(e as Error).message}`, 'INTERNAL_ERROR');
  }
}

// ─── /undo ────────────────────────────────────────────────────────────────────

export async function cmdUndo(session: Session, loader: Loader): Promise<CommandResult> {
  const home = loader.home;
  const recordPath = session.lastUndoRecordPath;

  if (!recordPath) {
    return err('Nothing to undo.', 'NOT_FOUND');
  }

  let record;
  try {
    record = await readUndoRecord(recordPath);
  } catch {
    session.clearLastUndo();
    return err('Nothing to undo.', 'NOT_FOUND');
  }

  const targetFile = record.targetPath;
  const displayPath = toWorkspacePath(targetFile, home);
  const boundaryError = validateWorkspaceBoundary(targetFile, home, displayPath, loader.accessMode);
  if (boundaryError) {
    return boundaryError;
  }
  if (record.afterSha256) {
    const currentSha256 = await fileSha256(targetFile);
    if (currentSha256 !== record.afterSha256) {
      return err(
        `Refusing to undo ${displayPath}: file changed since this topic's last edit.\n` +
        `Run /edit ${displayPath} to inspect the current file, or use git if you need history-level recovery.`,
        'CONFLICT'
      );
    }
  }

  if (!record.existedBefore) {
    // File was newly created — undo means delete it
    try {
      await fsPromises.unlink(targetFile);
    } catch { /* already gone */ }
    await fsPromises.unlink(recordPath).catch(() => {});
    session.clearLastUndo();
    return ok(`Undo: deleted ${displayPath} (was newly created)`);
  }

  // Restore previous content
  const undoContent = record.beforeContent ?? '';
  await fsPromises.writeFile(targetFile, undoContent, 'utf-8');
  await fsPromises.unlink(recordPath).catch(() => {});
  session.clearLastUndo();

  const lineCount = undoContent.split('\n').length;
  const preview = undoContent.length > 200 ? undoContent.slice(0, 200) + '...' : undoContent;
  return ok(`Undo: reverted ${displayPath} (${lineCount} lines)\n${preview}`);
}

// ─── /verify ──────────────────────────────────────────────────────────────────

export async function cmdVerify(args: string, session: Session, loader: Loader): Promise<CommandResult> {
  const home = loader.home;

  // Parse: <path>#<blockId>
  const hashIdx = args.indexOf('#');
  if (hashIdx === -1 || !args.trim()) {
    return err('Usage: /verify <path>#<blockId>', 'INVALID_TARGET');
  }

  const filePath = args.slice(0, hashIdx).trim();
  const blockId = args.slice(hashIdx + 1).trim();

  if (!filePath || !blockId) {
    return err('Usage: /verify <path>#<blockId>', 'INVALID_TARGET');
  }

  const resolved = resolveFilePath(filePath, home, session.currentUri, session.cwdOverride);

  const boundaryError = validateWorkspaceBoundary(resolved, home, filePath, loader.accessMode);
  if (boundaryError) return boundaryError;

  // Read file
  let source: string;
  try {
    source = await fsPromises.readFile(resolved, 'utf-8');
  } catch {
    return err(`File not found: ${filePath}`, 'NOT_FOUND');
  }

  // Try to find block using same resolution as /edit
  // Priority 1: Check for explicit markers
  const openMarker = `<!-- #${blockId} -->`;
  const markerIdx = source.indexOf(openMarker);

  let content: string;
  let lineCount: number;

  if (markerIdx !== -1) {
    // Use extract() for marker-based blocks
    const result = extract(source, blockId);
    if (!result.found) {
      return err(`Block #${blockId} not found in ${filePath}`, 'NOT_FOUND');
    }
    content = result.content;
    lineCount = result.content.split('\n').length;
  } else {
    // Priority 2: Try heading-derived block (explicit ID or slug)
    const headingRange = findHeadingBlockRange(source, blockId);
    if (!headingRange) {
      return err(
        `Block #${blockId} not found in ${filePath}.\n` +
        `Supported formats (in priority order):\n` +
        `  1. Explicit markers: <!-- #${blockId} --> ... <!-- /${blockId} -->\n` +
        `  2. Explicit ID: ## Heading {#${blockId}} or ## Heading []{#${blockId}}\n` +
        `  3. Heading slug: ## Heading Text (where slug matches "${blockId}")`,
        'NOT_FOUND'
      );
    }

    // Extract heading block content (including heading line)
    const lines = source.split('\n');
    const blockLines = lines.slice(headingRange.startLine, headingRange.endLine);
    content = blockLines.join('\n');
    lineCount = blockLines.length;
  }

  // Show content preview
  const preview = content.length > 200
    ? content.slice(0, 200) + '...'
    : content;

  return ok(
    `Verified ${filePath}#${blockId} (${lineCount} lines, ${content.length} chars)\n---\n${preview}`
  );
}
