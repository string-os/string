# @string-os/compiler

SFMD compiler and validator. Reads SFMD documents, validates them against the spec, and compiles Trinity-style multi-file documents into a single inlined Markdown file.

## Install

```bash
npm install -g @string-os/compiler
```

Or as a library dependency:

```bash
npm install @string-os/compiler
```

## CLI usage

```bash
sfmd validate <path>               # Validate a document or directory
sfmd compile  <dir> <base-name>    # Compile Trinity .md (inlines [!include:] refs)
sfmd extract  <file.md> <#block>   # Extract content of a specific block
sfmd fix      <dir>                # Add missing [!include:] entries to skeletons
sfmd clean    <dir>                # Remove unreferenced files from .md.source/
```

## Library usage

```typescript
import { compile, validate } from '@string-os/compiler';

const result = compile(document);
if (result.ok) {
  console.log(result.output);
}
```

## Related

- [`@string-os/core`](https://www.npmjs.com/package/@string-os/core) — SFMD parser used by this package
- [`@string-os/string`](https://www.npmjs.com/package/@string-os/string) — the full runtime
- [SFMD spec](https://github.com/string-os/sfmd) — format specification

## License

MIT
