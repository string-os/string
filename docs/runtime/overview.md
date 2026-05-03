---
title: String
---

# String

**String is an operating system for AI.**

It sits on top of existing operating systems and the web, giving AI agents
a single, consistent interface to the outside world — apps, documents,
websites, APIs, and files.

AI reads everything as Markdown. AI acts through a handful of commands.
That's the entire interface.

---

## How it works

**Context is text.** String presents all content as text, preferring
Markdown — the format AI understands best. SFMD (String Flavored Markdown)
adds lightweight extensions for navigation, block addressing, and actions
while remaining 100% CommonMark compatible.

**Actions are commands.** Two primitives cover nearly everything:

- `/open` — see something (a document, a page, a block, a shortcut)
- `/act` — do something (call an API, run a workflow, submit data)

New capabilities come from new documents, not new commands.

---

## What's in this documentation

| # | Document | What it covers |
|---|----------|----------------|
| 1 | [Why String](./01-why.md) | The problem, the vision, and why AI needs its own OS |
| 2 | [The Model](./02-the-model.md) | Context hierarchy, SFMD principles, command surface |
| 3 | [The AI Loop](./03-the-ai-loop.md) | How an AI agent discovers, navigates, and acts |
| 4 | [Topics](./04-topics.md) | Sessions, typed topics (file, web, app, bash) |
| 5 | [Actions](./05-actions.md) | Action definition, invocation, response templates |
| 6 | [State](./06-state.md) | Variables, secrets, session state, configuration |
| 7 | [Navigation](./07-navigation.md) | /open, /nav, menus, shortcuts, history |
| 8 | [Authoring](./08-authoring.md) | How to write SFMD documents |
| 9 | [Editing](./09-editing.md) | Creating and modifying documents through String |
| 10 | [Errors](./10-errors.md) | Error codes, format, and handling |
| 11 | [Transport](./11-transport.md) | ChanFlow channel tags, AI ↔ String communication |
| 12 | [Response Format](./12-response-format.md) | Response structure and formatting |
| 13 | [Tools](./13-tools.md) | /tool invocation, cmd blocks, tool vs app |
| 14 | [Packages](./packages.md) | `/install`, `/uninstall`, registry, multi-file apps, namespace identity |
| 15 | [Install Manifest](./install-manifest.md) | JSON contract for HTTP-source installs |

---

## Cookbook

Practical, scenario-based guides showing AI using String end-to-end.
Each guide is a real AI↔String conversation using channel tags. The
cookbook lives in its own repository: [`string-os/cookbook`](https://github.com/string-os/cookbook).

| # | Guide | Scenario |
|---|-------|----------|
| 0 | [CLI Quick Start](https://github.com/string-os/cookbook/blob/main/00-cli-quickstart.md) | Install `string` and run your first command |
| 1 | [Document Editing](https://github.com/string-os/cookbook/blob/main/01-editing.md) | Create, edit, undo, commit, and version a document |
| 2 | [Web Browsing](https://github.com/string-os/cookbook/blob/main/02-web-browsing.md) | Research multiple sites, manage tabs, compile findings |
| 3 | [Single-Page App](https://github.com/string-os/cookbook/blob/main/03-single-page-app.md) | One-file weather app — all /act, no navigation |
| 4 | [Multi-Page App](https://github.com/string-os/cookbook/blob/main/04-multi-page-app.md) | Multi-file weather app — /open to move, /act to do |
| 5 | [Multi-Topic Workflows](https://github.com/string-os/cookbook/blob/main/05-multi-topic.md) | API docs→code, email→report, build+changelog |
| 6 | [CLI App](https://github.com/string-os/cookbook/blob/main/06-cli-app.md) | Wrap a shell CLI as an SFMD action surface |
| 7 | [Cross-Agent Portability](https://github.com/string-os/cookbook/blob/main/07-portability.md) | One file, three AI agents, same behavior |
