---
title: String
---

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

## Syscall surface for AI agents

If String is an operating environment, the part that's actually
*standardized* is small enough to list. Think of it as the syscall
surface an agent reaches for, regardless of which underlying resource
it is talking to.

| Surface | What it standardizes | Primary primitives |
|---|---|---|
| **Navigation** | how an agent moves between documents, pages, and blocks | `/open`, `/back`, `/nav`, `[!nav:]`, `[@shortcut]` |
| **Action invocation** | how an agent calls a capability | `/act.<name>`, action blocks, typed args, `/act.<name> --help` |
| **State scoping** | what is remembered, where, and for how long | topics (tab, `app:`, `bash:`, hub), session vars, env scopes |
| **Output framing** | how the agent recognizes its own results | `<𝒞=string:topic>…</𝒞>` markers around every payload |
| **Editing semantics** | how an agent writes back to the world | `/write`, `/append`, `/replace`, `/edit`, `/undo`, `/verify`, text/line/block edits |
| **Trust and permissions** | what an agent is allowed to run | action allowlist, `--allow-shell`, `[!requirements]`, signed packages (v0.2) |
| **Recovery and error hints** | how an agent knows what to do when things break | typed error codes, missing-env hints, `/info` diagnostics, `meta.warnings` |

Every resource type — a local document, an installed app, a remote URL,
a shell session — exposes some subset of these surfaces with the same
verbs. An agent that learns String once can read a doc, drive an app,
browse the web, and edit a file without re-learning a new interface for
each domain.

That's why the runtime feels OS-shaped from the inside, even though
externally the right framing is closer to *a universal surface for
agent work* — see [string-os.org](https://string-os.org).

---

## What's in this documentation

| # | Document | What it covers |
|---|----------|----------------|
| 1 | [Why String](./why.md) | The problem, the vision, and why AI needs its own OS |
| 2 | [The Model](./model.md) | Context hierarchy, SFMD principles, command surface |
| 3 | [The AI Loop](./ai-loop.md) | How an AI agent discovers, navigates, and acts |
| 4 | [Topics](./topics.md) | Sessions, typed topics (tab, app, bash, hub) |
| 5 | [Actions](./actions.md) | Action definition, invocation, response templates |
| 6 | [State](./state.md) | Variables, secrets, session state, configuration |
| 7 | [Navigation](./navigation.md) | /open, /nav, menus, shortcuts, history |
| 8 | [Authoring](./authoring.md) | How to write SFMD documents |
| 9 | [Editing](./editing.md) | Creating and modifying documents through String |
| 10 | [Events](./events.md) | Local webhooks and the agent event inbox |
| 11 | [Errors](./errors.md) | Error codes, format, and handling |
| 12 | [Transport](../reference/transport.md) | ChanFlow channel tags, AI ↔ String communication |
| 13 | [Response Format](../reference/response-format.md) | Response structure and formatting |
| 14 | [Tools](./tools.md) | /tool invocation, cmd blocks, tool vs app |
| 15 | [Packages](./packages.md) | `/install`, `/uninstall`, registry, multi-file apps, namespace identity |
| 16 | [Install Manifest](./install-manifest.md) | JSON contract for HTTP-source installs |

---

## Cookbook

Practical, scenario-based guides showing AI using String end-to-end.
Each guide is a real AI↔String conversation using channel tags. The
cookbook lives in its own repository: [`string-os/cookbook`](https://github.com/string-os/cookbook).

| # | Guide | Scenario |
|---|-------|----------|
| 1 | [Weather](https://github.com/string-os/cookbook/blob/main/00-weather.md) | Simplest example, end to end. Start here. |
| 2 | [Anatomy](https://github.com/string-os/cookbook/blob/main/01-anatomy.md) | The weather app dissected — why it's shaped this way. |
| 3 | [Compare](https://github.com/string-os/cookbook/blob/main/02-compare.md) | MCP, function calling, and a String app — compared. |
| 4 | [Client Library](https://github.com/string-os/cookbook/blob/main/03-client-library.md) | The `@string-os/client` API and the single-tool pattern. |
| 5 | [Porting (Nano Banana Pro)](https://github.com/string-os/cookbook/blob/main/04-porting-nano-banana-pro.md) | Porting the Gemini Image API into a String app, end to end. |
