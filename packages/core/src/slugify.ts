/**
 * Converts heading text to a URL-compatible slug.
 * Follows CommonMark heading anchor conventions.
 */
export function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}
