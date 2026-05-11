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
echo "# Hello, String" > /tmp/hello.md
string main '/open /tmp/hello.md'
```

This starts a String daemon (if not running), creates a `main` session, and renders `/tmp/hello.md` as clean Markdown with navigation hints.

## 2. Browse the Web

```bash
string docs '/open https://example.com'
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
string main '/install --tool ./git.md'
string main '/tool:git status'
```

## 4. Run Actions

Install an app from the cookbook, then call one of its actions:

```bash
git clone https://github.com/string-os/cookbook.git
string setup '/install --app ./cookbook/apps/weather/string.md'
string app:weather '/act.now --city "Seoul"'
```

`/open app:weather` first if you want to see the action menu (`[actions] now, forecast, search`).

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
