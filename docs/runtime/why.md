---
title: Why String
---

# Why String

## AI doesn't have an operating system

Humans have macOS, Windows, Linux. An operating system that takes the
overwhelming complexity of hardware, networks, and files and turns it into
a single, consistent interface. Open a file. Run a program. Browse the web.
The OS makes it all feel like one world.

AI has nothing like this.

Today, an AI agent that needs to read a document, call an API, or navigate
a website must deal with each system on that system's own terms — parsing HTML
meant for browsers, calling REST endpoints defined by human developers,
interpreting UI layouts designed for eyes and hands.

Every system is a special case. Every integration is hand-built. The AI
cannot reach into the world on its own. A human must build the bridge first.

This is the bottleneck. Not the model's intelligence, not the context window,
not the inference speed — but the absence of a common layer between AI and
everything else.

---

## What this looks like in practice

**To read a web page**, an AI consumes thousands of tokens of HTML — tags,
classes, scripts, navigation chrome — to extract a few sentences of actual
content. 80–95% of the input is noise.

**To use a system**, a developer must pre-define a tool schema, write an
adapter, and hardcode the integration before the AI can do anything.
The AI can only use what was pre-programmed. It cannot discover new
capabilities on its own.

**To do more**, you need more integrations. Each one requires human
engineering effort. The AI's reach into the world grows only as fast
as humans can build bridges — and that is slow.

This is where every AI agent is today. Powerful models, constrained
by the lack of a common interface to the world around them.

---

## String is an OS for AI

String is the layer between AI and everything else.

It sits on top of the existing world — operating systems, the web,
applications, files, APIs — and presents it all through a single
interface that AI can natively understand and use.

```
┌─────────────────────────────────┐
│           AI Agent              │
└──────────────┬──────────────────┘
               │  markdown + /commands
┌──────────────▼──────────────────┐
│          String                 │
│     the OS for AI               │
└──────────────┬──────────────────┘
               │  abstracts
┌──────────────▼──────────────────┐
│    apps · web · files · APIs    │
│    macOS · Linux · Windows      │
└─────────────────────────────────┘
```

The design follows two principles:

**Use what AI already knows.** AI models have been trained on billions of
tokens of Markdown. It is the format they understand best — better than
HTML, better than JSON, better than any proprietary schema. String uses
Markdown (CommonMark) as the universal medium for everything AI sees.

**Minimize the command surface.** An AI interacts with the world through
a small set of commands. In practice, almost everything reduces to two
operations:

- `/open` — see something (a document, a page, a system)
- `/act` — do something (call an API, submit a form, run a workflow)

A few supporting commands exist — `/nav` for navigation menus, `/back`
for history, `/ls` for directory listing, `/write` and `/edit` for
content — but the core model is: **read with Markdown, act with commands.**

That's it. No tool schemas to pre-define. No adapters to maintain.
No HTML to parse. The AI reads Markdown, issues a command, and gets
Markdown back.

---

## Self-describing systems

The key property that makes this work is that String documents describe
themselves.

When an AI opens a document, the document tells the AI:

- what it contains (blocks with stable addresses)
- where else to go (navigation menus, shortcuts)
- what can be done (actions with field schemas)

````markdown
[!nav:main](./nav/main.md)

# Welcome

Find any topic.

`/act.search --q "{query}"`

```act.search
GET https://api.example.com/search
  q: string (required)
  limit: number (optional, max:50)
```
````

The AI doesn't need to be told in advance what this system does.
It reads the document and knows. It can follow the navigation, discover
more pages, call `/act.search`, and navigate the results — all
without any pre-programmed knowledge of this particular system.

This is what an operating system does: it makes the unknown usable
through a consistent interface.

---

## The cost equation

When AI uses the world through human-designed interfaces:
- High token cost (HTML noise, verbose schemas)
- High engineering cost (custom adapters per system)
- Low autonomy (AI can only do what was pre-built)

When AI uses the world through String:
- Low token cost (Markdown — pure content, no noise)
- Low engineering cost (system serves Markdown, done)
- High autonomy (AI discovers and uses new systems on its own)

The difference compounds. Every new system that speaks String is
immediately accessible to every AI agent, without any integration work.
The more systems that adopt it, the more capable every AI becomes.

---

## AI as user. AI as builder.

There is one more property that matters.

The primary user of String is AI. But the primary builder of String
content is also AI.

When an AI agent creates a Markdown document with navigation and actions,
it has built something that another AI agent can immediately use. No
compilation step. No deployment. No human review required. The document
is the interface.

```
AI creates a String document
        ↓
Another AI opens it, discovers what it offers
        ↓
Uses it — navigates, reads, acts
        ↓
Results are also String documents
        ↓
The cycle continues
```

This is the flywheel: AI builds for AI, using the same format it
consumes. The ecosystem grows without a human bottleneck.

Traditional software requires human developers to create interfaces
for human users. String removes both constraints simultaneously.

---

## What comes next

This documentation describes String in full:

- **The Model** — Markdown as the universal context layer, commands as
  the action layer, and how they fit together
- **The AI Loop** — how an AI agent discovers, navigates, and acts
  in a String environment
- **Building with String** — how to make any system String-native,
  and how AI builds String apps
- **Architecture** — layers, transport, sessions, and security
- **Reference** — commands, format syntax, and specification
