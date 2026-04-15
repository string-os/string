/**
 * SFMD Extractor — extracts a specific block from a compiled .md file
 * Handles explicit markers, explicit heading IDs, and implicit heading-based blocks.
 *
 * Resolution priority:
 * 1. Explicit markers: <!-- #id --> ... <!-- /id -->
 * 2. Explicit heading IDs: ## Heading {#id} or ## Heading []{#id}
 * 3. Heading-derived slugs: ## Heading Text (slug matches id)
 */

import { toSlug } from './slugify.js';

export interface ExtractResult {
  blockId: string;
  content: string;
  found: boolean;
}

/**
 * Extract explicit ID from heading text.
 * Supports: {#id} and []{#id} syntax
 * Returns null if no explicit ID found.
 */
function extractExplicitHeadingId(headingText: string): string | null {
  // Match {#id} syntax: ## Heading {#custom-id}
  const braceMatch = headingText.match(/\{#([a-z0-9-_]+)\}/i);
  if (braceMatch) return braceMatch[1];

  // Match []{#id} syntax: ## Heading []{#custom-id}
  const anchorMatch = headingText.match(/\[\]\{#([a-z0-9-_]+)\}/i);
  if (anchorMatch) return anchorMatch[1];

  return null;
}

export function extract(source: string, blockId: string): ExtractResult {
  const explicit = extractExplicit(source, blockId);
  if (explicit !== null) {
    return { blockId, content: explicit, found: true };
  }

  const implicit = extractImplicit(source, blockId);
  if (implicit !== null) {
    return { blockId, content: implicit, found: true };
  }

  return { blockId, content: '', found: false };
}

// Escape regex metacharacters so an attacker-controlled blockId like ".*"
// can't match unintended blocks. Valid SFMD block IDs are slug-like, but the
// extractor is reachable from untrusted input paths.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractExplicit(source: string, blockId: string): string | null {
  const lines = source.split('\n');
  const escaped = escapeRegex(blockId);
  const openRe = new RegExp(`^<!-- #${escaped} -->$`);
  const closeRe = new RegExp(`^<!-- \\/${escaped} -->$`);

  let capturing = false;
  const contentLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!capturing && openRe.test(trimmed)) {
      capturing = true;
      continue;
    }
    if (capturing && closeRe.test(trimmed)) {
      return contentLines.join('\n').trim();
    }
    if (capturing) {
      contentLines.push(line);
    }
  }

  return null;
}

function extractImplicit(source: string, blockId: string): string | null {
  const lines = source.split('\n');
  const HEADING_RE = /^(#{1,6})\s+(.+)$/;

  let targetLevel = 0;
  let capturing = false;
  const contentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(HEADING_RE);

    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2];

      if (!capturing) {
        // Priority 1: Check for explicit ID in heading
        const explicitId = extractExplicitHeadingId(headingText);
        if (explicitId === blockId) {
          targetLevel = level;
          capturing = true;
          contentLines.push(line);
          continue;
        }

        // Priority 2: Check heading slug
        const slug = toSlug(headingText);
        if (slug === blockId) {
          targetLevel = level;
          capturing = true;
          contentLines.push(line);
          continue;
        }
      } else {
        // Already capturing - check if we've reached the end
        if (level <= targetLevel) {
          return contentLines.join('\n').trim();
        }
      }
    }

    if (capturing) {
      contentLines.push(line);
    }
  }

  return capturing ? contentLines.join('\n').trim() : null;
}
