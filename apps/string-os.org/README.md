# @string-os/string-os.org

Astro site that builds [string-os.org](https://string-os.org) — the project landing page and the canonical home of `skill.md`.

The agent install skill lives at the repo root in [`skill.md`](../../skill.md) (canonical, like `README.md` or `LICENSE`). This site exposes it at:

- `https://string-os.org/skill.md` — raw markdown for AI agents
- `https://string-os.org/skill/` — styled HTML for humans

`content/skill.md` is a symlink to `../../../skill.md` so the source stays in one place.

## Local dev

From the repo root:

```bash
pnpm install
pnpm --filter @string-os/string-os.org dev
```

Build:

```bash
pnpm --filter @string-os/string-os.org build
```

## Deployment

Vercel project root: `apps/string-os.org`. Custom domain: `string-os.org`.

## Content negotiation (Accept: text/markdown)

The astro-sfmd builder is a general-purpose SSG: every page is emitted as a
`/path` (HTML) **and** a `/path.md` (raw markdown) twin. On any static host an
agent can fetch the `.md` URL directly — that's the host-agnostic baseline.

For *header*-based negotiation (same clean URL, `Accept: text/markdown` →
markdown) this site adds Vercel's recommended mechanism, [Routing
Middleware](https://vercel.com/docs/routing-middleware), in `middleware.ts` at
the project root. It runs before static serving and the cache, so it can swap
the response based on the header:

- `Accept: text/markdown` → rewrite the clean URL to its `.md` twin
- otherwise → serve HTML

`vercel.json` `rewrites` can't do this — they only fire when no static file
matches, so they'd never override an existing HTML page. Routing Middleware
runs first, which is why it works.

This layer is Vercel-specific and lives in the site, not in the builder. Other
hosts (GitHub Pages, etc.) rely on the `.md` twins directly.

`astro dev` / `astro preview` get the same negotiation locally via
`src/middleware.ts` (the builder's fs-based middleware) — that file is
build/dev-only and is not what runs in production on Vercel.

Verify on a preview deploy:

```bash
curl -sI https://<preview>/skill           # → text/html
curl -sI -H 'Accept: text/markdown' https://<preview>/skill   # → text/markdown
```
