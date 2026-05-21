# @string-os/docs

Astro + Starlight site that builds [docs.string-os.org](https://docs.string-os.org).

Content lives at the repo root in `docs/` (canonical Markdown source). This app is a thin build wrapper — the `src/content/docs` directory is a symlink to `../../../docs`.

The site is dual-output via [`@string-os/astro-sfmd`](https://github.com/string-os/astro-sfmd):

- `/path/` → styled HTML for browsers
- `/path.md` → raw Markdown for AI agents

## Local dev

From the repo root:

```bash
pnpm install
pnpm --filter @string-os/docs dev
```

Build:

```bash
pnpm --filter @string-os/docs build
```

## Deployment

Vercel project root: `apps/docs`. Custom domain: `docs.string-os.org`.

## Content negotiation (Accept: text/markdown)

The `.md` twins above are the host-agnostic baseline — any static host can
serve them when an agent requests the `.md` URL directly.

For *header*-based negotiation (same clean URL, `Accept: text/markdown` →
markdown) this site adds Vercel's [Routing
Middleware](https://vercel.com/docs/routing-middleware) in `middleware.ts` at
the project root. It runs before static serving and the cache, so it can swap
the response based on the header:

- `Accept: text/markdown` → rewrite the clean URL to its `.md` twin
- otherwise → serve HTML

`vercel.json` `rewrites` can't do this — they only fire when no static file
matches, so they'd never override an existing HTML page.

This layer is Vercel-specific and lives in the site, not in the astro-sfmd
builder (which stays a general-purpose SSG). It mirrors
`apps/string-os.org/middleware.ts`; the matcher additionally excludes
`pagefind/` (Starlight's search index).

Verify on a preview deploy:

```bash
curl -sI https://<preview>/runtime/overview                          # → text/html
curl -sI -H 'Accept: text/markdown' https://<preview>/runtime/overview  # → text/markdown
```
