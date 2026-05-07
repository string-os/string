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
