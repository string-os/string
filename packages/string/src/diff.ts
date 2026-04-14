/**
 * String — Diff & Line Number Formatting
 * Provides Claude Code-style diff output for mutation feedback.
 * Uses the `diff` package (Myers algorithm) for reliable line diffing.
 */

import { diffLines } from 'diff';

export interface DiffOptions {
  context?: number;     // context lines around changes (default 3)
  maxLines?: number;    // max output lines before truncation (default 50)
}

/**
 * Format source with line numbers for /edit view mode.
 *
 * Output:
 *   1 | # Title
 *   2 |
 *   3 | Some content
 */
export function formatLineNumbers(source: string, startLine = 1): string {
  const lines = source.split('\n');
  const maxNum = startLine + lines.length - 1;
  const width = String(maxNum).length;

  return lines
    .map((line, i) => {
      const num = String(startLine + i).padStart(width);
      return `${num} | ${line}`;
    })
    .join('\n');
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

interface DiffLine {
  type: 'keep' | 'del' | 'add';
  oldNum?: number;  // 1-based line number in old text
  newNum?: number;  // 1-based line number in new text
  text: string;
}

/**
 * Convert `diff` package Change[] output to our internal DiffLine[] format
 * with per-line old/new line numbers.
 */
function computeDiff(oldText: string, newText: string): DiffLine[] {
  // Normalize: diffLines needs trailing newlines to properly match shared lines.
  // Without them, "Line 1" vs "Line 1\nLine 2" treats "Line 1" as fully removed.
  const normalizedOld = oldText.endsWith('\n') ? oldText : oldText + '\n';
  const normalizedNew = newText.endsWith('\n') ? newText : newText + '\n';
  const changes = diffLines(normalizedOld, normalizedNew);
  const result: DiffLine[] = [];
  let oldNum = 1;
  let newNum = 1;

  for (const change of changes) {
    // diffLines includes trailing \n in value; split and drop empty trailing element
    const lines = change.value.endsWith('\n')
      ? change.value.slice(0, -1).split('\n')
      : change.value.split('\n');

    for (const line of lines) {
      if (change.added) {
        result.push({ type: 'add', newNum: newNum++, text: line });
      } else if (change.removed) {
        result.push({ type: 'del', oldNum: oldNum++, text: line });
      } else {
        result.push({ type: 'keep', oldNum: oldNum++, newNum: newNum++, text: line });
      }
    }
  }

  // If original texts didn't end with \n, the normalization added a phantom empty line.
  // Remove it: last line will be an empty '' added by the split.
  if (!oldText.endsWith('\n') && !newText.endsWith('\n')) {
    // Both lacked trailing \n — phantom keep '' at end
    if (result.length > 0 && result[result.length - 1].type === 'keep' && result[result.length - 1].text === '') {
      result.pop();
    }
  } else if (!oldText.endsWith('\n') && newText.endsWith('\n')) {
    // Old lacked trailing \n — phantom del '' at end
    if (result.length > 0 && result[result.length - 1].type === 'del' && result[result.length - 1].text === '') {
      result.pop();
    }
  } else if (oldText.endsWith('\n') && !newText.endsWith('\n')) {
    // New lacked trailing \n — phantom add '' at end
    if (result.length > 0 && result[result.length - 1].type === 'add' && result[result.length - 1].text === '') {
      result.pop();
    }
  }

  return result;
}

/**
 * Format diff between old and new text in Claude Code style.
 *
 * New file (old empty):
 *   1 + # Test File
 *   2 + Hello from /write.
 *
 * Overwrite:
 *   1   - # Test File
 *   2   - Hello from /write.
 *       1 + # Replaced
 *       2 + New content only.
 *
 * Context gap:
 *   1    1 | # Title
 *   2      - Old line
 *        2 + New line
 *   3    3 | Unchanged
 *        ...
 *  10   10 | More context
 *
 * No changes: "(no changes)"
 */
export function formatDiff(oldText: string, newText: string, options?: DiffOptions): string {
  const context = options?.context ?? 3;
  const maxLines = options?.maxLines ?? 50;

  // Same content
  if (oldText === newText) return '(no changes)';

  // New file (old is empty)
  if (oldText === '') {
    const lines = newText.split('\n');
    const width = String(lines.length).length;
    const output = lines.map((line, i) => {
      const num = String(i + 1).padStart(width);
      return `${num} + ${line}`;
    });
    return applyTruncation(output, maxLines, lines.length);
  }

  const diff = computeDiff(oldText, newText);

  // Find changed line indices (in the diff array)
  const changedIndices = new Set<number>();
  for (let i = 0; i < diff.length; i++) {
    if (diff[i].type !== 'keep') changedIndices.add(i);
  }

  if (changedIndices.size === 0) return '(no changes)';

  // Build set of visible indices (changed + context)
  const visibleIndices = new Set<number>();
  for (const ci of changedIndices) {
    for (let k = Math.max(0, ci - context); k <= Math.min(diff.length - 1, ci + context); k++) {
      visibleIndices.add(k);
    }
  }

  // Calculate column widths from visible lines
  let maxOldNum = 0;
  let maxNewNum = 0;
  for (const idx of visibleIndices) {
    const d = diff[idx];
    if (d.oldNum && d.oldNum > maxOldNum) maxOldNum = d.oldNum;
    if (d.newNum && d.newNum > maxNewNum) maxNewNum = d.newNum;
  }
  const oldWidth = maxOldNum > 0 ? String(maxOldNum).length : 1;
  const newWidth = maxNewNum > 0 ? String(maxNewNum).length : 1;

  // Format output with context gaps
  const output: string[] = [];
  let lastIdx = -1;
  let totalChangedLines = 0;

  for (const d of diff) {
    if (d.type !== 'keep') totalChangedLines++;
  }

  const sortedVisible = [...visibleIndices].sort((a, b) => a - b);

  for (const idx of sortedVisible) {
    // Gap indicator
    if (lastIdx !== -1 && idx > lastIdx + 1) {
      output.push(`${' '.repeat(oldWidth)}${' '.repeat(newWidth + 3)}...`);
    }
    lastIdx = idx;

    const d = diff[idx];
    const oldStr = d.oldNum != null ? String(d.oldNum).padStart(oldWidth) : ' '.repeat(oldWidth);
    const newStr = d.newNum != null ? String(d.newNum).padStart(newWidth) : ' '.repeat(newWidth);

    switch (d.type) {
      case 'keep':
        output.push(`${oldStr} ${newStr} | ${d.text}`);
        break;
      case 'del':
        output.push(`${oldStr} ${' '.repeat(newWidth)} - ${d.text}`);
        break;
      case 'add':
        output.push(`${' '.repeat(oldWidth)} ${newStr} + ${d.text}`);
        break;
    }
  }

  return applyTruncation(output, maxLines, totalChangedLines);
}

/**
 * Truncate output lines if they exceed maxLines.
 * Appends a summary of how many more lines were changed.
 */
function applyTruncation(lines: string[], maxLines: number, totalChanged: number): string {
  if (lines.length <= maxLines) {
    return lines.join('\n');
  }

  const truncated = lines.slice(0, maxLines);
  const remaining = totalChanged - maxLines;
  if (remaining > 0) {
    truncated.push(`... (${remaining} more lines changed, truncated at ${maxLines} lines)`);
  } else {
    truncated.push(`... (truncated at ${maxLines} lines)`);
  }
  return truncated.join('\n');
}
