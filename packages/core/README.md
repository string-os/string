# @string-os/core

SFMD parser, extractor, and utilities. The foundation package for String OS — used by `@string-os/compiler`, `@string-os/string`, and any tool that needs to read SFMD documents.

## Install

```bash
npm install @string-os/core
```

## Usage

```typescript
import { parse, extract } from '@string-os/core';

const doc = parse(sfmdText);
const block = extract(doc, '#welcome');
```

## What it exports

- **Parser** — turns SFMD text into a structured AST.
- **Extractor** — pulls blocks, actions, frontmatter, and shortcuts out of a parsed document.
- **Utilities** — shared helpers for navigation, shortcut resolution, and variable substitution.

No runtime dependencies. Pure TypeScript.

## Related

- [`@string-os/string`](https://www.npmjs.com/package/@string-os/string) — the full runtime
- [`@string-os/compiler`](https://www.npmjs.com/package/@string-os/compiler) — SFMD validator and compiler
- [SFMD spec](https://github.com/string-os/sfmd) — format specification
- [String monorepo](https://github.com/string-os/string) — source and docs

## License

MIT
