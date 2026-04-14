/**
 * Editing commands: /write, /append, /edit, /undo, /verify
 */

import fsPromises from 'fs/promises';
import path from 'path';
import { extract } from '@string-os/core';
import type { Loader } from '../loader.js';
import type { Session } from '../session.js';
import type { CommandResult } from '../types.js';
import { formatDiff, formatLineNumbers } from '../diff.js';
import { resolveConfig } from '../config.js';
import {
  ok, err,
  saveUndoBackup,
  toWorkspacePath,
  resolveFilePath,
  validateWorkspaceBoundary,
  findHeadingBlockRange,
} from './helpers.js';

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
    const filePath = args.trim();
    if (!filePath) {
      return err('Usage: /write <path>\n<content>', 'INVALID_TARGET');
    }

    // Block write: /write file#block\n<content> → delegate to /edit
    if (filePath.includes('#')) {
      return cmdEdit(filePath, body, session, loader);
    }

    const resolved = resolveFilePath(filePath, home, session.currentUri, session.cwdOverride);
    const boundaryError = validateWorkspaceBoundary(resolved, home, filePath, loader.accessMode);
    if (boundaryError) return boundaryError;

    try {
      const dir = path.dirname(resolved);
      await fsPromises.mkdir(dir, { recursive: true });
      const oldContent = await saveUndoBackup(resolved, session);
      await fsPromises.writeFile(resolved, body, 'utf-8');
      const stat = await fsPromises.stat(resolved);

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

  try {
    const dir = path.dirname(resolved);
    await fsPromises.mkdir(dir, { recursive: true });
    const oldContent = await saveUndoBackup(resolved, session);
    await fsPromises.writeFile(resolved, content, 'utf-8');
    const stat = await fsPromises.stat(resolved);

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
      const oldContent = await saveUndoBackup(resolved, session);
      const prefix = oldContent.length > 0 && !oldContent.endsWith('\n') ? '\n' : '';
      const newContent = oldContent + prefix + body;
      await fsPromises.writeFile(resolved, newContent, 'utf-8');
      const stat = await fsPromises.stat(resolved);
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
    const oldContent = await saveUndoBackup(resolved, session);
    const prefix = oldContent.length > 0 && !oldContent.endsWith('\n') ? '\n' : '';
    const newContent = oldContent + prefix + content;
    await fsPromises.writeFile(resolved, newContent, 'utf-8');
    const stat = await fsPromises.stat(resolved);
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
    const targetStr = args.trim();
    if (!targetStr) {
      return err('Usage: /edit <path>[#<blockId>]\n<content>', 'INVALID_TARGET');
    }

    const hashIdx = targetStr.indexOf('#');

    // Whole-file edit mode: /edit file\ncontent
    if (hashIdx === -1) {
      const filePath = targetStr;
      const resolved = resolveFilePath(filePath, home, session.currentUri, session.cwdOverride);
      const boundaryError = validateWorkspaceBoundary(resolved, home, filePath, loader.accessMode);
      if (boundaryError) return boundaryError;

      let oldContent: string;
      try {
        oldContent = await saveUndoBackup(resolved, session);
        await fsPromises.writeFile(resolved, body, 'utf-8');
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
      oldContent = await saveUndoBackup(resolved, session);
      await fsPromises.writeFile(resolved, newSource, 'utf-8');
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

    let oldContent: string;
    try {
      oldContent = await saveUndoBackup(resolved, session);
      await fsPromises.writeFile(resolved, content, 'utf-8');
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
    oldContent = await saveUndoBackup(resolved, session);
    await fsPromises.writeFile(resolved, newSource, 'utf-8');
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

// ─── /undo ────────────────────────────────────────────────────────────────────

export async function cmdUndo(session: Session, loader: Loader): Promise<CommandResult> {
  const home = loader.home;
  const targetFile = session.lastUndoPath;

  if (!targetFile) {
    return err('Nothing to undo.', 'NOT_FOUND');
  }

  const undoPath = targetFile + '.undo';
  const displayPath = toWorkspacePath(targetFile, home);

  // Check .undo file exists
  try {
    await fsPromises.access(undoPath);
  } catch {
    session.clearLastUndo();
    return err('Nothing to undo.', 'NOT_FOUND');
  }

  const undoContent = await fsPromises.readFile(undoPath, 'utf-8');

  if (undoContent === '') {
    // File was newly created — undo means delete it
    try {
      await fsPromises.unlink(targetFile);
    } catch { /* already gone */ }
    await fsPromises.unlink(undoPath);
    session.clearLastUndo();
    return ok(`Undo: deleted ${displayPath} (was newly created)`);
  }

  // Restore previous content
  await fsPromises.writeFile(targetFile, undoContent, 'utf-8');
  await fsPromises.unlink(undoPath);
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
