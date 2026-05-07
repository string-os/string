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
