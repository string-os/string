/**
 * Vercel Routing Middleware — SFMD content negotiation for docs.string-os.org.
 *
 * Runs *before* static file serving and before the cache, so it can swap the
 * response for a clean URL based on the Accept header. (vercel.json `rewrites`
 * can't do this — they only fire when no static file already matches.)
 *
 * When a client sends `Accept: text/markdown`, rewrite the clean URL to its
 * `.md` twin — already emitted into the static output by the astro-sfmd
 * builder. Browsers, which never send text/markdown, fall through to HTML.
 *
 * This is the Vercel-specific layer for THIS site. astro-sfmd itself stays a
 * general-purpose SSG: it emits `/path` (HTML) + `/path.md` (raw) twins for
 * any static host. Hosts without request-time logic just let agents fetch the
 * `.md` URL directly — no middleware needed.
 *
 * Mirrors apps/string-os.org/middleware.ts; the only difference is the matcher
 * also excludes `pagefind/` (Starlight's client-side search index).
 *
 * Docs: https://vercel.com/docs/routing-middleware
 */
import { rewrite, next } from '@vercel/functions';

export const config = {
  // Page routes only. The negative lookahead skips Astro's hashed assets,
  // Starlight's pagefind search index, and any path that already has a file
  // extension — which covers /favicon.* and direct /*.md requests, so we never
  // rewrite a .md path to .md.md.
  matcher: ['/((?!_astro/|pagefind/|.*\\.).*)'],
};

/** Map a clean page URL to its `.md` twin path. Exported for unit testing. */
export function mdTwin(pathname: string): string {
  if (pathname === '/') return '/index.md';
  return pathname.replace(/\/+$/, '') + '.md';
}

export default function middleware(request: Request) {
  const accept = request.headers.get('accept') || '';

  // No markdown preference → HTML. Vary on Accept so the CDN never serves a
  // cached markdown body to a browser (or vice versa) for the same URL.
  if (!accept.includes('text/markdown')) {
    return next({ headers: { Vary: 'Accept' } });
  }

  const url = new URL(request.url);
  const target = new URL(mdTwin(url.pathname), url);
  return rewrite(target, { headers: { Vary: 'Accept' } });
}
