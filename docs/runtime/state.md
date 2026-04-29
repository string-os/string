---
title: State
---

# State

State is what turns a document into an application.

A static document has content. An application has content that changes
based on what happened before. In String, the difference between the
two is state — variables that flow between actions and shape what the
AI sees next.

No database. No backend session store. Just variables.

---

## How state flows

Every action produces a result. That result is available as `Response`
until the next action runs.

```
/act.login --provider github
→ Response.body.access_token = "ghp_abc123..."
→ Response.body.user = "agent01"
```

A response template stores parts of it as session variables:

````markdown
```act.login.response
{token} = {Response.body.access_token}
{user} = {Response.body.user}
```
````

Now subsequent actions can use those values:

```
/act.get_repos --token {token}
/act.create_issue --token {token} --title "Bug report"
```

This is the loop that makes state work:

```
act → Response → response template stores {var} → act (using {var}) → ...
```

Each turn builds on the last. The AI doesn't need to remember the
access token in its context — it's in the session. The AI just
references `{token}` and String substitutes the value.

---

## Variable types

String has two kinds of variables with different lifecycles and
purposes.

### `{variable}` — Session variables

Ephemeral variables that live in a session. Created by response
templates when actions run, consumed by subsequent actions.

```
{city} = {Response.body.city}
{temp} = {Response.body.temperature}
```

- **Set by:** response templates (primary), AI `/set` (possible)
- **Scoped to:** the topic session — each topic has its own set
- **Lifetime:** the session — lost when the session closes
- **Storage:** in-memory only
- **Used in:** action URI path params, flag values, response output

Session variables are the working memory of a running app. A weather
app calls `/act.search`, the response template stores `{city}` and
`{temp}`, and subsequent actions reference them. When the session
ends, they're gone.

### `$variable` — Persistent variables

Durable variables stored on disk. Set by the human (via config file)
or by the AI (via `/set`). Persist across sessions and restarts.

```
$API_KEY
$DEFAULT_REGION
$USER_EMAIL
```

- **Set by:** human (config file) or AI (`/set $VAR = "value"`)
- **Scoped to:** user account, with optional app/config narrowing
- **Lifetime:** persistent until explicitly changed or deleted
- **Storage:** file-backed (EnvStore)
- **Used in:** action definitions (URI, headers, CLI commands)
- **Declared as requirements:** `env:` in frontmatter

Persistent variables are the configuration layer. An API key set once
is available to every action that needs it. An app can declare what
it requires, and String tells the AI what's missing.

---

## Two lifecycles

The two variable types serve different moments in the workflow.

**`{var}` — runtime data flow:**

The document developer designs the data pipeline. Response templates
extract values from API responses and store them as `{var}`. Actions
use those values. The AI doesn't need to know the plumbing — it
calls `/act.search`, and `{city}` is populated by the template.

```
Document developer writes:     AI at runtime:
  response template              /act.search --name "Seoul"
  {city} = {Response.body.city}  → {city} is now "Seoul"
  {temp} = {Response.body.temp}  → {temp} is now "24"
                                 /act.forecast --city {city}
```

**`$var` — configuration and credentials:**

Before the app runs, `$var` values need to be in place. The human
sets API keys in the config. The AI sets app-specific parameters
when required.

```
Human sets once:               AI uses in actions:
  $API_KEY = "sk-abc..."        act.search → GET ...?key=$API_KEY
  $DEFAULT_REGION = "KR"        act.weather → ...&region=$DEFAULT_REGION
```

**What goes where:**

| | `{var}` | `$var` |
|---|---|---|
| API response data | Yes | No |
| API keys, credentials | No | Yes |
| User preferences | No | Yes |
| Intermediate computation | Yes | No |
| Cross-session config | No | Yes |

---

## $var storage and cascade

Persistent variables are stored in files, organized by scope:

```
~/.string/
  config.json          ← global (env section)
  apps/
    weather/
      env.json         ← app:weather scope
      korea/
        env.json       ← app:weather:korea scope
```

**Global** — the user's `~/.string/config.json` file holds a unified
config with an `env` section:

```json
{
  "env": {
    "API_KEY": "sk-abc123",
    "DEFAULT_REGION": "KR"
  }
}
```

**App scope** — `~/.string/apps/{app}/env.json` holds variables
specific to an app:

```json
{
  "WEATHER_PROVIDER": "openweather"
}
```

**Config scope** — `~/.string/apps/{app}/{config}/env.json` holds
variables for a specific configuration of an app.

**Resolution cascade** — most specific wins:

```
config env → app env → global env
(highest)              (lowest)
```

When an action references `$API_KEY`, String looks in the config
scope first, then the app scope, then global. The first match wins.

---

## Requirements — `env:` in frontmatter

Apps and tools can declare which `$var` values they need. This is
done in frontmatter:

```yaml
---
env:
  - API_KEY: "OpenWeather API key"
  - DEFAULT_REGION: "Default region code"
    default: US
---
```

When the app or tool is loaded, String checks whether the required
variables are set. If `$API_KEY` is missing, String reports:

```
ERROR(ENV_REQUIRED): tool requires $API_KEY — "OpenWeather API key"
```

The AI then knows to ask the user for the value and set it:

```
/set $API_KEY = "sk-abc123"
```

Variables with a `default` value pass validation even when unset.

Only `$var` can be declared as requirements. `{var}` is runtime
data — it doesn't make sense to require it before the app runs.

---

## Setting variables

### `/set $VAR` — persistent variables

AI or human sets persistent variables with `/set`:

```
<𝒞=string:app:weather:korea>
/set $API_KEY = "sk-abc123"
</𝒞>
```

The scope is determined by the current topic:

| Topic | Stores in |
|--------|-----------|
| `file:main` | Global (`config.json`) |
| `app:weather` | App scope (`apps/weather/env.json`) |
| `app:weather:korea` | Config scope (`apps/weather/korea/env.json`) |

Multiple variables at once:

```
<𝒞=string:app:weather>
/set
$API_KEY = "sk-abc123"
$DEFAULT_REGION = "KR"
</𝒞>
```

### `/set {var}` — session variables

AI can also set session variables directly, though the recommended
path is through response templates:

```
/set {city} = "Seoul"
```

For multiline values, use a fenced code block with the variable name:

```
<𝒞=string:app:search>
/set
```{prompt}
You are a research assistant.
Summarize the results in bullet points.
Keep it under 200 words.
```
</𝒞>
```

Single and double quotes both work for inline values:

```
/set {region} = 'TH'
/set $REGION = "TH"
```

### Listing variables

`/set` with no arguments shows all variables in the current scope:

```
/set
→ {city} = "Seoul"
→ {temp} = "24"
→ $API_KEY = "sk-abc123"
→ $DEFAULT_REGION = "KR"
```

---

## Substitution

Both variable types are substituted by the String runtime at
execution time.

**In action definitions (document-level):**

````markdown
```act.search
GET https://api.weather.com/search?key=$API_KEY
  name: string (required)
```
````

Here `$API_KEY` is resolved from the EnvStore when the action runs.

**In AI commands (flag values):**

```
/act.search --name {city}
```

Here `{city}` is resolved from the session. The AI references the
variable; String substitutes.

**In response templates:**

````markdown
```act.search.response
{city} = {Response.body.name}
Current weather in {city}: {Response.body.description}
```
````

Only `{var}` can be assigned in response templates. `$var` cannot
be assigned here — it's configuration, not runtime data.

**Substitution summary:**

| Where | `{var}` | `$var` |
|-------|---------|--------|
| Action definition (URI, headers) | Substituted | Substituted |
| AI command flag values | Substituted | Substituted |
| Response template assignment | Yes (`{var} = {Response...}`) | **No** |
| Response template output | Substituted | Not applicable |

---

## State as application

Traditional applications separate code from state and manage state
through databases, session stores, and caches. String collapses this
into two layers.

An SFMD document defines actions (code). Variables hold state —
`{var}` for runtime data, `$var` for configuration. Together, they
form an application:

```
Document (actions + templates)
  +
Variables ({var} session + $var persistent)
  =
Application
```

Consider an email client:

```
/open app:gmail:work

Session state (from actions):
  {token} = "ya29.abc..."       ← from act.login.response
  {inbox_count} = "12"          ← from act.refresh.response
  {current_folder} = "inbox"    ← from act.switch.response

Persistent config (from /set or config file):
  $GMAIL_CLIENT_ID = "..."      ← set once, used by act.login
  $GMAIL_CLIENT_SECRET = "..."  ← set once, used by act.login
```

The document defines what actions exist (login, refresh, compose,
search). Session `{var}` tracks where the user is (inbox, 12
messages, authenticated). Persistent `$var` holds credentials set
once and reused across sessions.

The AI navigates it the same way it navigates any String document —
`/open` to see, `/act` to do. The difference is that state
accumulates across turns, making each action aware of what came
before.

---

## Summary

| Concept | Rule |
|---------|------|
| **`{variable}`** | Session-scoped, set by response templates, ephemeral |
| **`$variable`** | Persistent, set by human or AI, file-backed |
| **Response** | Last action result, overwritten on next action |
| **Response template** | Can assign `{var}` only — not `$var` |
| **`env:` requires** | Declares required `$var` — not `{var}` |
| **`$var` cascade** | config scope > app scope > global |
| **`/set`** | Sets `{var}` (session) or `$var` (persistent) |
| **Core insight** | Document + variables = application |
