/**
 * Cloudflare Pages Function — Accept-based content negotiation for docs.string-os.org.
 *
 * Ported from the agentnews CF middleware. Replaces the Vercel `middleware.ts`
 * when this Starlight docs site runs on Cloudflare Pages:
 *   - Browsers (Accept: text/html) get Starlight's static HTML.
 *   - Agents (Accept: text/markdown) get the parallel `.md` twin from the same URL.
 *   - Direct `*.md` requests are served as markdown.
 * Starlight assets (`_astro/`, `pagefind/`) never send Accept: text/markdown, so
 * they fall through to `next()`; the 404 fallback also covers any miss. Every
 * markdown read is logged to a Cloudflare Analytics Engine dataset
 * (`DOCS_ANALYTICS` binding), classifying agent vs human by User-Agent. Binding
 * is optional: without it, negotiation still works and logging is skipped.
 */
type Env = {
  DOCS_ANALYTICS?: AnalyticsEngineDataset;
};

export const onRequest: PagesFunction<Env> = async (context) => {
  const request = context.request;
  const url = new URL(request.url);

  if (url.pathname.endsWith('.md')) {
    const response = await context.next();
    logMarkdownRead(context, url.pathname, request.headers.get('user-agent') || '');
    return withMarkdownHeaders(response);
  }

  if (!prefersMarkdown(request.headers.get('accept') || '')) {
    return context.next();
  }

  const markdownPath = toMarkdownPath(url.pathname);
  const markdownUrl = new URL(request.url);
  markdownUrl.pathname = markdownPath;

  const response = await context.env.ASSETS.fetch(markdownUrl.toString(), request);
  if (response.status === 404) return context.next();

  logMarkdownRead(context, markdownPath, request.headers.get('user-agent') || '');
  return withMarkdownHeaders(response);
};

function toMarkdownPath(pathname: string): string {
  if (pathname === '/') return '/index.md';
  return pathname.replace(/\/$/, '') + '.md';
}

function withMarkdownHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/markdown; charset=utf-8');
  headers.set('vary', appendVary(headers.get('vary'), 'Accept'));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function appendVary(current: string | null, value: string): string {
  if (!current) return value;
  const parts = current.split(',').map((part) => part.trim().toLowerCase());
  return parts.includes(value.toLowerCase()) ? current : `${current}, ${value}`;
}

function prefersMarkdown(accept: string): boolean {
  const parsed = accept
    .split(',')
    .map((part) => {
      const [type, ...params] = part.trim().split(';').map((p) => p.trim());
      const qParam = params.find((p) => p.startsWith('q='));
      const q = qParam ? Number(qParam.slice(2)) : 1;
      return { type: type.toLowerCase(), q: Number.isFinite(q) ? q : 1 };
    })
    .filter((item) => item.type);

  const markdown = Math.max(0, ...parsed.filter((i) => i.type === 'text/markdown').map((i) => i.q));
  const html = Math.max(0, ...parsed.filter((i) => i.type === 'text/html').map((i) => i.q));
  return markdown > 0 && markdown >= html;
}

function logMarkdownRead(context: EventContext<Env, string, unknown>, pathname: string, userAgent: string) {
  const dataset = context.env.DOCS_ANALYTICS;
  if (!dataset) return;
  const isAgent = /bot|agent|claude|codex|openai|string|curl|python|node-fetch/i.test(userAgent);
  dataset.writeDataPoint({
    blobs: [pathname, isAgent ? 'agent' : 'human', userAgent.slice(0, 200)],
    indexes: [pathname],
  });
}
