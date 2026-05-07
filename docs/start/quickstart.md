---
title: Quick Start
---

Get up and running with String in 5 minutes.

## Install

```bash
npm install -g @string-os/string
string --help
```

## 1. Open a Document

```bash
string file:main '/open ./README.md'
```

This starts a String daemon (if not running), creates a `file:main` session, and opens the README. The AI sees the document rendered as clean Markdown with navigation hints.

## 2. Browse the Web

```bash
string web:docs '/open https://example.com'
```

String fetches the URL, converts HTML to Markdown, and presents it with auto-generated shortcuts for links.

## 3. Use a Skill

Create a skill file `git.md`:

```markdown
---
name: git
default: run
---

# Git

\`\`\`act.run
CLI git $ARGS
\`\`\`
```

Install and use it:

```bash
string file:main '/install --tool ./git.md'
string file:main '/tool:git status'
```

## 4. Run Actions

Open a document with action definitions, then execute them:

```bash
string file:main '/open ./weather.md'
string file:main '/act.forecast --city "Seoul"'
```

## 5. Use with Claude Desktop (MCP)

Add to your Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "string": {
      "command": "npx",
      "args": ["@string-os/string-mcp"]
    }
  }
}
```

Now Claude can use `string_open`, `string_act`, and other tools to interact with documents and skills.

## 6. Use as a Library

```typescript
import { Browser } from '@string-os/string';

const browser = new Browser({ home: process.cwd() });

// Open a document
const result = await browser.exec('/open ./index.md');
console.log(result.content);

// Execute an action
const action = await browser.exec('/act.search --query "hello"');
console.log(action.content);
```

## Next Steps

- [Agent Integration](./agent-integration.md) — detailed integration guide
- [Writing Skills](./writing-skills.md) — create your own tools and apps
- [Cookbook](https://github.com/string-os/cookbook) — practical examples
- [SFMD Specification](https://github.com/string-os/sfmd) — format spec
