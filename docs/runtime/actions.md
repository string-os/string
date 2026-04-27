# Actions

Actions are how AI does things through String — calling APIs, running
commands, submitting data. An action is declared inside a document,
invoked with a single line, and its response comes back as Markdown.

---

## What AI sees

When AI reads a document, actions appear as one-line hints:

```markdown
# Weather Dashboard

**Search for a city:**
`/act.search_city --name "{City Name}"`

**Set a weather alert:**
`/act.create_alert --condition "{rain|snow|temp}"`
```

That's all the AI needs. The name, the flags, the expected values —
readable at a glance. The AI doesn't see the underlying implementation.
It doesn't need to.

If the AI wants more detail, it asks:

```
/act.search_city --help
```

String returns the full schema — parameter types, which are required,
what the action does. But this is on-demand, not forced into context.

---

## Where actions are defined

Action definitions live inside the same document, in fenced code
blocks with an `act.` info string:

````markdown
```act.search_city
GET https://api.weather.com/search
  name: string (required) "City name to search"
  unit: string (optional) "celsius|fahrenheit"
```
````

String parses these blocks and registers the actions. The blocks are
not shown to the AI when it reads the document — they are metadata,
not content. In a standard Markdown viewer, they render as ordinary
code blocks. Graceful degradation.

---

## Action types

The first line of the definition block declares the HTTP method
(or `CLI` for shell commands).

### GET

```act.search_city
GET https://api.weather.com/search
  name: string (required) "City name"
  unit: string (optional) "celsius|fahrenheit"
```

Parameters are appended as a query string. The AI invokes it as:

```
/act.search_city --name "Seoul"
```

String sends `GET https://api.weather.com/search?name=Seoul`.

### POST

```act.create_alert
POST https://api.weather.com/alerts
  city: string (required) "Topic city"
  condition: string (required) "rain|snow|temp"
  threshold: number (optional) "Trigger value"
```

Parameters are sent as a JSON body. The AI invokes it as:

```
/act.create_alert --city "Seoul" --condition "rain"
```

String sends a POST with `{"city": "Seoul", "condition": "rain"}`.

### PUT / PATCH

```act.update_alert
PUT https://api.weather.com/alerts/{alert_id}
  alert_id: string (required) "Alert ID"
  condition: string (required) "New condition"
```

```act.patch_settings
PATCH https://api.weather.com/users/{user_id}/settings
  user_id: string (required) "User ID"
  unit: string (optional) "celsius|fahrenheit"
```

Same as POST — parameters are sent as a JSON body. PUT replaces the
entire resource, PATCH updates specific fields. Standard REST semantics.

### DELETE

```act.delete_alert
DELETE https://api.weather.com/alerts/{alert_id}
  alert_id: string (required) "Alert ID"
```

Same as GET — parameters are appended as a query string (or
substituted into the URL path).

### CLI

```act.deploy
CLI kubectl apply -f {manifest}
  manifest: path (required) "Kubernetes manifest file"
```

String executes the command with parameters substituted. The AI
invokes it as:

```
/act.deploy --manifest ./app.yaml
```

String runs `kubectl apply -f ./app.yaml`.

---

## Headers

HTTP actions can declare custom headers using curl-style `-H` flags
on the first line:

```act.inbox
GET https://gmail.googleapis.com/v1/users/me/messages -H "Authorization: Bearer {access_token}"
  maxResults: number (optional)
  q: string (optional) "Gmail search query"
```

```act.create_issue
POST https://api.github.com/repos/{repo}/issues -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3+json"
  title: string (required)
  body: string (optional)
```

Multiple headers: `-H "..." -H "..."` on the same line. Both
`{var}` (session) and `$var` (persistent) are both substituted in
header values.

String does not inject default headers for actions — only the
declared `-H` headers are sent. This is standard REST behavior.
(`Accept: text/markdown` is only injected for `/open`, not `/act`.)

---

## Invocation syntax

All actions use POSIX CLI syntax:

```
/act.action_name --flag value --flag2 "value with spaces"
```

- Flags are `--name value` pairs
- Quoted values for strings with spaces
- Boolean flags: `--verbose` (no value = true)
- The dot-notation (`/act.name`) is the standard form

All four forms are equivalent:

```
/act.search_city --name "Seoul"
/act search_city --name "Seoul"
/action.search_city --name "Seoul"
/action search_city --name "Seoul"
```

`/act` and `/action` are interchangeable. Dot-notation and
space-separated forms are both valid. Dot-notation is preferred
in documentation and action hints for readability.

---

## Response templates

By default, String passes the raw response to the AI as Markdown.
This works for many cases — the AI reads the result and decides
what to do next.

For structured responses, a response template can format the output
and store values for later use. Response templates are defined in a
companion code block:

````markdown
```act.search_city.response
{temp} = {Response.body.temperature}
{city} = {Response.body.city}
## {city}
- Temperature: {temp}°C
- Condition: {Response.body.condition}
- Humidity: {Response.body.humidity}%
```
````

### Two things happen in a response block

**Assignment lines** — `{var} = {expression}`

Lines matching `{identifier} = ...` are variable assignments. The
value is extracted from the response and stored as a session variable.
Assignment lines produce no output.

```
{temp} = {Response.body.temperature}
{city} = {Response.body.city}
```

Available response references:

| Reference | What it returns |
|-----------|----------------|
| `{Response.body.field}` | A specific field from the response body |
| `{Response.body}` | The entire response body |
| `{Response.status}` | HTTP status code (e.g. `200`) |

**Output lines** — everything else

All other lines are rendered as a Markdown template. Variables
(both just-assigned and previously stored) are substituted.

```
## {city}
- Temperature: {temp}°C
```

### Examples

**Display only** — no assignments, just formatting:

````markdown
```act.get_status.response
**Status:** {Response.body.status}
**Uptime:** {Response.body.uptime}
```
````

**Store only** — assignments with no output lines. The action runs
silently, storing values for later use:

````markdown
```act.get_token.response
{auth_token} = {Response.body.token}
{expires} = {Response.body.expires_at}
```
````

**Both** — store values and display formatted output:

````markdown
```act.search_city.response
{temp} = {Response.body.temperature}
{city} = {Response.body.city}
## Weather in {city}
- Temperature: {temp}°C
- Condition: {Response.body.condition}
```
````

Session variables persist within the topic. A value stored by one
action can be used by subsequent actions or templates in the same
session.

---

## Single-page and multi-page apps

Actions and response templates enable two patterns for building
String apps.

### Single-page app

Everything in one document. Actions are defined inline, response
templates format the results in place.

```markdown
# Weather Dashboard

`/act.search_city --name "{City Name}"`
`/act.get_forecast --city "{City}" --days "7"`

​```act.search_city
GET https://api.weather.com/search
  name: string (required)
​```

​```act.search_city.response
{city} = {Response.body.city}
{temp} = {Response.body.temperature}
## {city}
- Temperature: {temp}°C
- Condition: {Response.body.condition}
​```

​```act.get_forecast
GET https://api.weather.com/forecast
  city: string (required)
  days: number (optional)
​```

​```act.get_forecast.response
## {Response.body.city} — {Response.body.days}-Day Forecast
{Response.body.forecast}
​```
```

The AI stays on one page. Actions update the view through templates.

### Multi-page app

Actions and content spread across multiple documents. Each page is
a separate `.md` file with its own actions.

```
weather-app/
├── index.md              # Home — search action
├── forecast.md           # 7-day forecast page
├── alerts.md             # Alert management
└── nav/
    └── main.md           # Navigation menu
```

The AI navigates with `/open` and acts with `/act`. Each page
declares its own actions. The forecast page has forecast-related
actions. The alerts page has alert-related actions.

```markdown
# index.md — navigates to forecast
/act.search_city --name "Seoul"
→ response includes [7-Day Forecast](./forecast.md)
→ AI: /open ./forecast.md

# forecast.md — has its own actions
/act.get_forecast --city "Seoul" --days "7"
```

### Choosing between them

Single-page works for simple, focused tools — a calculator, a status
dashboard, a quick search. Multi-page works for larger systems with
distinct sections — an email client, a project management tool, a
documentation site.

Both patterns use the same primitives: `/act` for actions, `/open`
for navigation. The difference is in how the documents are organized,
not in how the AI interacts with them.

---

## Default action

A document can declare a default action in its frontmatter:

```yaml
---
default: get_weather
---
```

When the document is opened (`/open`), String automatically executes
`act.get_weather`. The AI sees the document content and the action
result together, separated by a rule:

```
# Weather Dashboard

Check the weather for any city.

`/act.get_weather --city "{city}"`
`/act.set_alert --condition "{condition}"`

---
## Seoul
- Temperature: 22°C
- Condition: Sunny
```

Document first, result after. The AI reads the page context (what
this app does, what actions are available) and the live data in one
turn.

### When AI invokes an action directly

If the AI runs `/act.get_weather --city "Tokyo"` after opening the
page, only the response is returned — the document content is
already in the AI's context from the initial open.

### On refresh

`/refresh` re-renders the document and re-runs the default action,
producing the combined output again.

### Why document-declared

The default is part of the document's design, not an AI preference.
A weather dashboard should load weather on open. An inbox should
load messages. The author declares this intent in frontmatter.

If no `default` is declared, `/open` shows the document content
only. The AI decides what to do next.

---

## Summary

| Concept | How |
|---------|-----|
| **Invocation** | `/act.name --flag value` (POSIX CLI syntax) |
| **Definition** | ```` ```act.name ```` code block (parsed by String, hidden from AI) |
| **Types** | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `CLI` — first line of definition |
| **Headers** | `-H "Key: Value"` on first line — curl syntax, supports `{var}` and `$var` |
| **Response template** | ```` ```act.name.response ```` — optional formatting |
| **Assignment** | `{var} = {Response.body.field}` — session variable |
| **Output** | All non-assignment lines — rendered as Markdown |
| **Help** | `/act.name --help` — on-demand schema |
| **Default action** | `default: name` in frontmatter — runs on `/open` and `/refresh` |
