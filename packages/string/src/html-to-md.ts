/**
 * String — HTML-to-Markdown Converter
 * Default turndown-based implementation of HtmlToMarkdown.
 */

import TurndownService from 'turndown';
import type { HtmlToMarkdown } from './loader.js';

/**
 * Create a default HTML→Markdown converter using turndown.
 *
 * - Strips <script>, <style>, <noscript>, <iframe>, <svg>
 * - Strips navigation chrome: <nav>, <footer>, <header>, <aside>
 * - Extracts <main> or <article> content when present, falls back to <body>
 * - ATX headings, fenced code blocks
 * - Cleans up excessive blank lines
 */
export function createHtmlToMarkdown(): HtmlToMarkdown {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });

  // Remove non-content elements
  td.remove(['script', 'style', 'noscript', 'iframe', 'svg' as any]);

  // Strip navigation chrome
  td.remove(['nav', 'footer', 'header', 'aside']);

  return (html: string, _url: string): string => {
    // Extract main content area if available
    const content = extractMainContent(html);
    const md = td.turndown(content);
    // Collapse 3+ consecutive blank lines to 2
    return md.replace(/\n{3,}/g, '\n\n').trim();
  };
}

/**
 * Extract the inner HTML of <main> or <article> if present,
 * otherwise fall back to <body>, otherwise use the whole input.
 */
function extractMainContent(html: string): string {
  // Try <main> first
  const main = extractTag(html, 'main');
  if (main) return main;

  // Try <article>
  const article = extractTag(html, 'article');
  if (article) return article;

  // Try <body>
  const body = extractTag(html, 'body');
  if (body) return body;

  return html;
}

/** Extract inner content of the first occurrence of a tag. */
function extractTag(html: string, tag: string): string | null {
  const open = new RegExp(`<${tag}[^>]*>`, 'i');
  const close = new RegExp(`</${tag}>`, 'i');
  const openMatch = open.exec(html);
  if (!openMatch) return null;
  const start = openMatch.index + openMatch[0].length;
  const closeMatch = close.exec(html.slice(start));
  if (!closeMatch) return null;
  return html.slice(start, start + closeMatch.index);
}
