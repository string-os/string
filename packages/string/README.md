# @string-os/string

String runtime for AI agents. Browse documents, execute actions, navigate the web — all through Markdown.

## Install

```bash
npm install -g @string-os/string
```

## CLI Usage

```bash
string file:main '/open ./index.md'
string file:main '/act.search --query "hello"'
string web:docs '/open https://example.com'
```

## Library Usage

```typescript
import { Browser } from '@string-os/string';

const browser = new Browser({ home: process.cwd() });
const result = await browser.exec('/open ./index.md');
console.log(result.content);
```

## Documentation

See the [main README](https://github.com/string-os/string) for full documentation.

## License

MIT
