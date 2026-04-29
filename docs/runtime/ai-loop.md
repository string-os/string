---
title: The AI Loop
---

# The AI Loop

This section shows what it actually looks like when an AI agent uses
String. Not the theory — the experience.

---

## What AI sees

When an AI opens a page through String, it receives Markdown. Here is
a real example — a weather dashboard:

```markdown
# Weather Dashboard

**Location:** Suwon-si, Gyeonggi-do
**Status:** Live (Last Updated: 14:19 KST)

### Current Conditions

- **Temperature:** 18°C (Feels like 17°C)
- **Weather:** Partly Cloudy
- **Humidity:** 45%
- **Wind:** 3 m/s (NW)

### Navigation

- [Hourly Forecast for today][@link-1]
- [7-Day Extended Forecast][@link-2]
- [Saved City][@saved_city]
- [App configurations](./settings.md)

### Quick Actions

**1. Search for a different city:**
`/act.search_city --name "{City Name}"`

**2. Set a Custom Weather Alert:**
`/act.create_alert --condition "{rain|snow|temp}"`
```

That's it. No HTML. No JSON schema. No API documentation to consult.
The AI reads this and immediately knows:

- The current weather in Suwon (the content)
- Where else it can go (navigation links and shortcuts)
- What it can do (two actions, with their parameters inline)

Everything the AI needs is in the document itself.

---

## The loop

Every interaction in String follows the same cycle:

```
open → read → decide → act → open → read → decide → act → ...
```

There are no special modes, no state transitions, no protocol
handshakes. The AI reads Markdown, makes a decision, issues a
command, and reads more Markdown.

Let's walk through a concrete scenario.

---

## Scenario: "What's the weather in Seoul?"

A user asks the AI to check the weather in Seoul. The AI is currently
looking at the Suwon weather dashboard shown above.

### Step 1: Read and understand

The AI reads the dashboard. It sees `/act.search_city` in the Quick
Actions section. It knows how to search for a different city.

### Step 2: Act

```
/act.search_city --name "Seoul"
```

### Step 3: Receive the result

The response is another Markdown document:

```markdown
# Weather Dashboard

**Location:** Seoul, South Korea
**Status:** Live (Last Updated: 14:21 KST)

### Current Conditions

- **Temperature:** 20°C (Feels like 19°C)
- **Weather:** Clear
- **Humidity:** 38%
- **Wind:** 2 m/s (W)

### Navigation

- [Hourly Forecast for today][@link-1]
- [7-Day Extended Forecast][@link-2]
- [Saved City][@saved_city]
- [App configurations](./settings.md)

### Quick Actions

**1. Search for a different city:**
`/act.search_city --name "{City Name}"`

**2. Set a Custom Weather Alert:**
`/act.create_alert --condition "{rain|snow|temp}"`
```

The result is not a JSON blob to parse. It's the same kind of document,
updated with Seoul's data. The AI can now answer the user, or continue —
check the hourly forecast, set an alert, navigate to settings.

### Step 4: The loop continues

The AI can:
- `/open @link-1` → see Seoul's hourly forecast
- `/act.create_alert --condition "rain"` → set a rain alert
- `/open @saved_city` → switch to a saved city
- `/open ./settings.md` → change app configuration
- `/back` → return to the Suwon dashboard

Each of these produces another Markdown document. Each document
offers new navigation and new actions. The loop never ends and
the AI is never stuck.

---

## What makes this different

### No pre-programming required

The AI was not given a weather API schema. It was not told what
endpoints exist. It opened a document and the document told it
everything. If the weather app adds a new action tomorrow —
`/act.compare_cities` — the AI will see it the next time it opens
the page. No code change, no tool update, no redeployment.

### No format translation

The AI didn't parse HTML to find the temperature. It didn't call a
REST API and interpret a JSON response. It read a sentence that says
"Temperature: 20°C" — the same way a human would. The content is
the interface.

### No dead ends

Every action response is a full document with its own navigation and
actions. The AI doesn't get a status code and then need to figure
out what to do next. It gets a new page to read, with new paths
to follow.

### Token efficient

The AI received only what it needed — current conditions, navigation
options, and available actions. Not a full HTML page with CSS,
JavaScript, headers, footers, and cookie banners. Pure content.

---

## The three things AI always knows

In any String document, the AI can always answer three questions:

**1. What is here?**
The content — readable as plain Markdown.

**2. Where can I go?**
Navigation links, shortcuts, and relative paths.

**3. What can I do?**
Actions declared inline with their parameters.

If a document answers these three questions, any AI agent can use it
without prior knowledge. This is the contract that makes String work
as an OS — a consistent interface regardless of what's behind it.

---

## Patterns of the loop

Different tasks follow the same loop but with different patterns:

### Browse and read
```
/open index.md → /nav main → /open @docs → /open report.md#summary
```
The AI navigates through documents, drilling into specific sections.

### Search and explore
```
/open search.md → /act.search --q "pricing" → /open @result_1
```
The AI searches, gets results as a document, follows links.

### Multi-step workflow
```
/open deploy.md → /act.build → /act.test → /act.deploy --env staging
```
Each action returns a status document. The AI reads the result and
decides whether to proceed.

### Edit and verify
```
/open report.md → /edit report.md → /replace report.md#intro "new text" → /refresh
```
The AI opens a document, enters edit mode, modifies a block, and
reloads to verify.

### Build and run
```
/exec npm test → (read output) → /open bash:dev → npm run build → npm run deploy
```
Quick checks with `/exec` (stateless), longer workflows in a
`bash` session (stateful). Shell output is plain text — the AI
reads it like any other content.

All five patterns are the same loop: open, read, decide, act. The
commands are always `/open` and `/act`. The context is always Markdown
or plain text.

---

## Summary

The AI Loop is simple by design:

1. AI reads Markdown — understands what's here, where to go, what to do
2. AI issues a command — `/open` to navigate, `/act` to execute
3. AI receives Markdown — the result is a new document to read
4. Repeat

No translation layer. No schema lookup. No adapter. The document
is the interface, and the interface is always the same.
