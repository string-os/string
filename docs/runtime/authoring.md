---
title: Authoring
---

This is a guide for writing SFMD documents — whether you're a human
setting up a String app or an AI generating documents for other AI
agents to use.

---

## The basics

An SFMD document is a Markdown file. Start with content, then add
structure as needed.

```markdown
# My Dashboard

Welcome to the dashboard. Here's what you can do.
```

This is already a valid SFMD document. It renders in any Markdown
viewer and any AI can read it through String. Everything below is
optional — add what you need.

---

## Adding metadata

Use YAML frontmatter for document metadata:

```markdown
---
title: Weather Dashboard
description: Real-time weather for configured cities
---

# Weather Dashboard

Current conditions and forecasts.
```

Frontmatter is parsed by String and available to the runtime.
In standard Markdown viewers, it's either hidden or shown as-is.

---

## Defining blocks

Blocks make sections of a document independently addressable.
Wrap content with HTML comment markers:

```markdown
<!-- #current -->
## Current Conditions
- Temperature: 20°C
- Humidity: 38%
- Wind: 2 m/s (W)
<!-- /current -->

<!-- #forecast -->
## 7-Day Forecast
Monday: 22°C, Clear
Tuesday: 19°C, Cloudy
...
<!-- /forecast -->
```

Now AI can load just what it needs:

```
/open dashboard.md#current    → only the current conditions
/open dashboard.md#forecast   → only the forecast
```

### Block ID rules

- Use lowercase letters, numbers, hyphens: `#pricing`, `#quick-start`
- Keep IDs stable — AI may save references to them
- IDs must be unique within a document
- Blocks can be nested but should not overlap

### When to use blocks

- Long documents where AI rarely needs the whole thing
- Sections that update independently (current weather vs forecast)
- Content that other documents want to include

---

## Setting up navigation

### Step 1: Create a nav file

A nav file is a plain Markdown file containing shortcuts:

```markdown
# nav/main.md

[@home Home](../index.md)
[@dashboard Dashboard](../dashboard.md)
[@settings Settings](../settings.md)
[@help Help](../help.md)
```

Each line: `[@id Label](relative-path)`. Paths are relative to the
nav file's location.

### Step 2: Reference it from documents

Add a nav directive to any document that should have this menu:

```markdown
[!nav:main](./nav/main.md)

# Dashboard

Welcome to the dashboard.
```

The directive is metadata — String parses it and registers the menu.
It's not shown to the AI as content. In a standard Markdown viewer,
it renders as a regular link.

### Step 3: AI uses it

```
/nav main
→ @home, @dashboard, @settings, @help

/open @settings
→ navigates to settings.md
```

### Multiple menus

For larger apps, use multiple menus:

```markdown
[!nav:main](./nav/main.md)
[!nav:admin](./nav/admin.md)
```

AI can check each independently: `/nav main`, `/nav admin`.

---

## Including content from other files

Use the include directive to embed a block from another document:

```markdown
[!include:pricing](./components/pricing.md)
```

String loads `pricing.md`, extracts the `#pricing` block, and
inserts it into the document. The directive renders as a regular
link in standard Markdown viewers.

If the path is omitted, String resolves it automatically from a
source directory named after the current file:

```markdown
[!include:pricing]()
```

For a file named `dashboard.md`, this resolves to
`dashboard.source/pricing.md`.

Includes are useful for:
- Reusing content across multiple documents
- Breaking large documents into maintainable pieces
- Assembling pages from shared components

---

## Defining actions

Actions let AI do things — call APIs, run commands, submit data.

### Step 1: Add an invocation hint

Show the AI how to call the action:

```markdown
**Search for a city:**
`/act.search_city --name "{City Name}"`
```

This is what the AI sees. One line, readable, with parameter hints.

### Step 2: Define the action spec

Add a fenced code block with the `act.` prefix:

````markdown
```act.search_city
GET https://api.weather.com/search
  name: string (required) "City name to search"
  unit: string (optional) "celsius|fahrenheit"
```
````

String parses this block and registers the action. The block is not
shown to the AI — it's metadata. In a standard Markdown viewer, it
renders as a code block.

### Action spec format

First line declares the type and endpoint:

```
GET https://api.example.com/endpoint
POST https://api.example.com/endpoint
CLI command-name {args}
```

Following lines define parameters:

```
  name: type (constraints) "description"
```

- **type**: `string`, `number`, `boolean`, `path`
- **constraints**: `required`, `optional`, value hints
- **description**: quoted, explains the parameter

### Step 3: Add a response template (optional)

````markdown
```act.search_city.response
{city} = {Response.body.city}
{temp} = {Response.body.temperature}
## Weather in {city}
- Temperature: {temp}°C
- Condition: {Response.body.condition}
```
````

Without a response template, the raw response is shown as Markdown.
With one, the output is formatted and variables can be stored for
later use.

### Complete example

````markdown
**Search for a city:**
`/act.search_city --name "{City Name}"`

```act.search_city
GET https://api.weather.com/search
  name: string (required) "City name"
```

```act.search_city.response
{city} = {Response.body.city}
{temp} = {Response.body.temperature}
## {city}
- Temperature: {temp}°C
- Condition: {Response.body.condition}
```
````

---

## Using shortcuts

Shortcuts give stable names to paths and URLs.

### Inline shortcuts

```markdown
Visit the [@docs Documentation](https://docs.example.com/v2) for
more details, or check the [@changelog Changelog](./changelog.md).
```

AI sees `[Documentation][@docs]` — short and stable. If the URL
changes, update the shortcut definition. AI code that references
`@docs` doesn't break.

### Reference shortcuts

For cleaner documents, define shortcuts separately:

```markdown
Check the [Documentation][@docs] and [Changelog][@changelog].

[@docs]: https://docs.example.com/v2
[@changelog]: ./changelog.md
```

Same result — AI sees `[Documentation][@docs]`. The URL
definitions sit at the bottom, keeping the prose readable.
This is standard CommonMark reference link syntax with `@` IDs.

### Shortcuts with secrets

For URLs that contain API keys or tokens:

```markdown
[@api API Endpoint](https://api.example.com/v2?key=$API_KEY)
```

The `$API_KEY` is resolved by the runtime. The AI sees `@api`
and navigates to it — the key is never in the AI's context.

---

## Document structure patterns

### Minimal document

Just content. No blocks, no nav, no actions.

```markdown
# README

This project does X. Install with `npm install`.
```

Works fine. Not every document needs SFMD features.

### Content document

Blocks for addressing, nav for context.

```markdown
---
title: API Reference
---

[!nav:main](./nav/main.md)

<!-- #auth -->
## Authentication
Use Bearer tokens for all requests.
<!-- /auth -->

<!-- #endpoints -->
## Endpoints
...
<!-- /endpoints -->
```

### Interactive document

Actions with response templates.

````markdown
---
title: Weather Dashboard
---

[!nav:main](./nav/main.md)

# Weather Dashboard

`/act.search_city --name "{City Name}"`
`/act.set_alert --condition "{rain|snow|temp}"`

<!-- #current -->
## Current Conditions
Search for a city to see weather data.
<!-- /current -->

```act.search_city
GET https://api.weather.com/search
  name: string (required)
```

```act.search_city.response
{city} = {Response.body.city}
## {city}
- Temperature: {Response.body.temperature}°C
- Condition: {Response.body.condition}
```

```act.set_alert
POST https://api.weather.com/alerts
  condition: string (required) "rain|snow|temp"
  city: string (optional) "defaults to current city"
```
````

### Multi-page app

```
my-app/
├── string.md           # Entry point
├── search.md           # Search page with search action
├── detail.md           # Detail view
├── settings.md         # Configuration page
└── nav/
    └── main.md         # Shared navigation
```

Each page has its own actions relevant to that page. Navigation
menus tie them together. The AI moves between pages with `/open`
and acts within pages with `/act`.

---

## Authoring checklist

- [ ] Content is readable as plain Markdown (no String required)
- [ ] Block IDs are stable and descriptive
- [ ] Include directives reference existing blocks
- [ ] Nav directives point to existing menu files
- [ ] Menu file paths are relative to the menu file's directory
- [ ] Action specs have clear parameter descriptions
- [ ] Response templates extract only what's needed
- [ ] `$` variables are only in action specs, never in content
- [ ] Shortcuts use `@` prefix with short, stable names

---

## Summary

| Element | Syntax | Purpose |
|---------|--------|---------|
| **Frontmatter** | `---` YAML `---` | Document metadata |
| **Block** | `<!-- #id -->` ... `<!-- /id -->` | Addressable section |
| **Nav directive** | `[!nav:name](path)` | Register a menu |
| **Include** | `[!include:id](path)` | Embed a block from another file |
| **Menu file** | `[@id Label](path)` per line | Navigation entries |
| **Shortcut** | `[@id Label](url)` | Named reference |
| **Action hint** | `` `/act.name --flag "value"` `` | What AI sees |
| **Action spec** | ```` ```act.name ```` | Action definition |
| **Response template** | ```` ```act.name.response ```` | Output formatting |
