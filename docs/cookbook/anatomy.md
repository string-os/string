# 01 — Anatomy of an SFMD app

**Goal:** understand every line of `apps/weather/index.md`, then see how larger apps compose multiple files. By the end you can read any SFMD app your agent installs and write your own.

This is reference material. The previous chapter showed what the weather app *does*; this one shows what it *is*.

---

## The file we'll deconstruct

[`apps/weather/index.md`](./apps/weather/index.md) — the relevant first half:

````markdown
---
title: Weather
name: weather
type: app
version: 0.1.0
---

# Weather

A three-action weather app, backed by [wttr.in](https://wttr.in) for
the weather data and [Nominatim](https://nominatim.openstreetmap.org/)
(OpenStreetMap) for resolving city names. No API key, no signup, no
server to run. Works the moment it is installed.

## Actions

- `/act.now --city <name>` — current conditions, one line
- `/act.forecast --city <name>` — detailed forecast with wind and humidity
- `/act.search --q <query>` — resolve a free-form location query to
  canonical names you can pass to `now` / `forecast`.

For multi-word cities passed directly to `now` / `forecast`, use `+` in
place of spaces: `--city New+York`. Or pass them through `search` first.

```act.now
GET https://wttr.in/{city}?format=%l:+%C+%t+%w&m
  city: string (required) "City name"
```

```act.forecast
GET https://wttr.in/{city}?format=%l:+%C+%t+%w+%h+%p&m
  city: string (required) "City name"
```
````

The `act.search` block and its response template come later in the file
and are covered in their own section below.

The three pieces above — frontmatter, body, action blocks — are the
**minimum** shape an SFMD app can take and still be useful: a single
file, no build step, no helper scripts. Start here because everything
else builds on it.

---

## Frontmatter (lines 1–6)

```yaml
---
title: Weather
name: weather
type: app
version: 0.1.0
---
```

YAML at the top of the file. Four keys matter to the runtime:

| Key | Purpose |
|-----|---------|
| `title` | Shown by `/info`. Used by agents when they describe what they're looking at. |
| `name` | The package name when the file is installed. Must match `[a-zA-Z0-9_-]+` — the installer sanitizes it. This is how the file becomes addressable as a bare `weather`. |
| `type` | `app` or `tool`. Tells the installer which registry to use — `/open app:weather` works for apps, `/tool:weather` for tools. |
| `version` | SemVer string. Surfaced by `/info` so agents can check which version they're looking at. |

Anything else you add to the frontmatter is preserved but ignored by the runtime. Use custom keys for your own tooling without fear of collision.

---

## Body

```markdown
# Weather

A three-action weather app, backed by [wttr.in](https://wttr.in) for
the weather data and [Nominatim](https://nominatim.openstreetmap.org/)
(OpenStreetMap) for resolving city names. No API key, no signup, no
server to run. Works the moment it is installed.

## Actions

- `/act.now --city <name>` — current conditions, one line
- `/act.forecast --city <name>` — detailed forecast with wind and humidity
- `/act.search --q <query>` — resolve a free-form location query to
  canonical names you can pass to `now` / `forecast`.
```

Plain CommonMark. Anything you can write in a regular markdown file works here — headings, lists, emphasis, links, code spans, fenced code blocks, tables. The renderer strips SFMD-specific blocks (action blocks, nav directives, include directives) but leaves everything else alone.

**The body is what the agent reads as prose.** Write it for an agent that has already opened the app and wants to know how to use it — one or two paragraphs of context, a quick reference for the actions, any gotchas. The bulleted `/act.now --city <name>` lines exist for the agent to read, not for the runtime to parse.

The two links (wttr.in and nominatim.openstreetmap.org) turn into auto-assigned shortcuts so the URLs stay out of the agent's working context. `/nav page` lists them. For a small app this is mostly cosmetic; for a page with many links it is what keeps the viewport short.

---

## Action blocks

Each `act.<name>` fenced code block declares one invocable action.

````
```act.now
GET https://wttr.in/{city}?format=%l:+%C+%t+%w&m
  city: string (required) "City name"
```
````

Three parts:

### 1. The block header

````
```act.now
````

The fence language is `act.<id>` where `<id>` is the action name. IDs must match `[a-zA-Z0-9_-]+`. The caller invokes it as `/act.now`.

### 2. The invocation template

```
GET https://wttr.in/{city}?format=%l:+%C+%t+%w&m
```

The first line of the block is `<METHOD> <template>`.

- **Method** is one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE` (HTTP methods) or `CLI` (shell command). HTTP methods construct an HTTP request; `CLI` runs the template as a shell command via `/bin/bash -c`. Most APIs are HTTP, so HTTP methods are the common case; `CLI` is for wrapping local tools (`gh`, `aws`, `kubectl`, etc.) or for HTTP APIs that need shell glue the runtime doesn't provide.
- **Template** is the URL (for HTTP) or the command line (for CLI). Use `{field}` to substitute a field value into the template — for HTTP, the value is URL-encoded; for CLI, it is shell-quoted. Either way, the template author writes the natural form and the runtime handles the encoding.

For this action, the URL is `https://wttr.in/{city}?format=%l:+%C+%t+%w&m`. The `{city}` placeholder lives in the path; everything after `?` is wttr.in's format-string query parameter (the `%l`, `%C`, etc. are wttr.in's format codes, not URL encoding). The runtime's URL parser passes the format codes through verbatim, so the request that hits wttr.in is exactly what's written.

### 3. The field list

```
  city: string (required) "City name"
```

Every indented line below the template is one field. The syntax is:

```
  <name>: <type> [(required|optional)] ["description"] [= "default"]
```

- `<name>`: the flag the caller passes. `city` becomes `--city` on the command line.
- `<type>`: `string`, `number`, or `boolean`. Used for validation.
- `(required)` / `(optional)`: whether the caller must provide this flag.
- `"description"`: human-readable hint. Shown in the `/act` listing and in `--help`.
- `= "default"`: default value if the caller omits the flag.

The weather app has one field per action — `city`, required, no default. A missing `--city` flag returns a structured error and never touches the shell.

---

## How `{city}` becomes safe

When you call `/act.now --city Seoul`, the runtime does four things in order:

1. **Parse the flag string.** `--city Seoul` becomes the payload `{ city: "Seoul" }`.
2. **Validate against the field list.** `city` is required; it is present; done. A missing required field returns an error and never makes the request.
3. **Substitute into the template.** Every `{field}` in the URL is replaced with the value the caller provided, URL-encoded. `Seoul` has no special chars so it stays as `Seoul`. `New York` would become `New%20York`. `; rm -rf /` would become `%3B%20rm%20-rf%20%2F` — fully URL-escaped, no shell to break out of.
4. **Run.** For HTTP methods, the substituted URL is fetched. Any remaining payload fields not consumed by URL substitution are appended as query parameters (so a field named `limit` would land as `?limit=10`).

The template author does not write encoding logic. The runtime does it once, the same way, for every SFMD HTTP action ever written.

### What about CLI actions?

For `CLI` method actions, the substitution rule is slightly different but the principle is identical: `{field}` is **shell-quoted**, not URL-encoded. A value like `; rm -rf /` becomes `'; rm -rf /'` — wrapped in single quotes that bash parses as a literal string, not as a command separator. The template author writes the natural shell command and the runtime handles the quoting.

The one rule for CLI templates: **don't wrap `{field}` in outer quotes** (the slot self-quotes, like bash's `"$@"`). For HTTP templates, there's no analogous footgun — URL encoding always works regardless of the surrounding URL syntax.

---

## Response handling

For `CLI` actions, stdout becomes the action result. Stderr is appended. A non-zero exit code surfaces as an error with a code like `EXIT_1`.

For `HTTP` actions, the response body is returned as the action's output text. The current document stays where it was — calling an action is "fetch this and read the result", not "navigate to a new page." For wttr.in's plain-text format, the response IS the agent's success message; nothing more to do.

If you want to do something more structured with an HTTP response (extract a JSON field, decode base64, write to a file, format a custom success line), declare a sibling `act.<name>.response` block. The `act.search` action below does exactly that.

---

## What the agent sees vs what's hidden

When an agent inspects the action via `/act`, `/act.<name> --help`, or the `[actions]` hint at the top of `/open`, it gets exactly the **call interface**: the verb name, each field's type and required-ness, and the description. Nothing more.

```
/act.now
   --city <string> (required) — City name
```

It does **not** see:

- the underlying method (`CLI` vs `POST` vs `GET` etc.)
- the URL or the bash template
- the request `body:` template, headers, or `$VAR` references
- the response-template `save:` / `decode:` / `to:` directives

Those are *implementation* — the runtime's job, not the agent's. Hiding them keeps the help surface focused on "what to call, what to pass" and saves prompt tokens on every call.

When you genuinely need to inspect what's behind an action — security audit, debugging an unexpected response, curiosity about the underlying API — `/source` dumps the raw `.md` file, including frontmatter, body, action blocks, and response templates:

```bash
string app:weather '/source'
```

`/source` is the escape hatch. Reach for it when you need to see the implementation; otherwise let the runtime do its job.

---

## The response template (`act.search` / `act.search.response`)

The third action in the weather file, `act.search`, hits Nominatim instead of wttr.in and returns JSON. Returning raw JSON is workable but unfriendly — the agent can parse it, but a structured prose summary is nicer. That's what a sibling `act.<id>.response` block is for.

````markdown
```act.search
GET https://nominatim.openstreetmap.org/search?format=json&limit=5 -H "User-Agent: string-cookbook-weather/0.1"
  q: string (required) "Free-form location query"
```

```act.search.response
{top} = {Response.body[0].display_name}
{lat} = {Response.body[0].lat}
{lon} = {Response.body[0].lon}
Top match: {top}
Coordinates: {lat}, {lon}

Other matches:
- {Response.body[1].display_name}
- {Response.body[2].display_name}
- {Response.body[3].display_name}
- {Response.body[4].display_name}

(Pass the top match to /act.now --city, or the coordinates as --city {lat},{lon})
```
````

The `act.search` block is a normal HTTP action with a `User-Agent` header (Nominatim requires one). The interesting part is the `act.search.response` block — a separate fenced block with the language tag `act.<id>.response`. The runtime matches it to the action by id at parse time and runs it after the HTTP call returns.

Three line types are recognized inside a response template:

1. **Variable assignment.** `{top} = {Response.body[0].display_name}` walks the JSON response, pulls out a value, and stores it as a session variable. No output. The path syntax supports nested keys (`a.b.c`) and array indices (`[0]`, `[1]`, etc.).
2. **Directive lines** (`save:`, `decode:`, `to:`). Used for binary file save — `save:` extracts a value into an internal buffer, `decode: base64` reinterprets it, `to: <path>` writes it to a file. Not used by `act.search`, but covered in detail in chapter [04 — Porting Nano Banana Pro](./04-porting-nano-banana-pro.md).
3. **Output text.** Any line that isn't an assignment or a directive is rendered output, with `{Response.body.X}` and `{var}` placeholders substituted in place. These lines become the agent's viewport when the action returns.

For `act.search`, the template assigns three vars (top match name, lat, lon), then renders a prose block that uses both the assigned vars and direct `{Response.body[N].display_name}` lookups for positions 2-5.

When Nominatim returns fewer than 5 matches, the unfilled positions render as empty bullet points (`- `) — a known cosmetic limitation of the hardcoded indices. A future `foreach:` directive would clean this up; for now, accept the empty bullets or prefer queries you expect to be ambiguous (`Springfield`, `Cambridge`, `Salem`).

---

## Bigger apps: multiple files

An SFMD app is **not** required to be one file. The weather app happens to be, because one file is the minimum. Larger apps compose several files using three mechanisms.

### Nav files

A nav file is a markdown file whose only job is to list shortcuts:

```markdown
<!-- nav/main.md -->
[@home Home](../index.md)
[@docs Documentation](../docs/index.md)
[@api API Reference](../docs/api.md)
```

Any page that wants this navigation references it with a directive:

```markdown
[!nav:main](./nav/main.md)
```

At load time, the runtime merges the shortcuts into the current session under the menu name `main`. `/nav main` lists them. `/open @main.home` follows one. The menu lives outside the page, so every page in the app can share the same nav without duplicating entries.

### Includes

Includes are the compiler-level way to compose one document out of many:

```markdown
# Home

[!include:intro](./sections/intro.md)

[!include:pricing](./sections/pricing.md)
```

`@string-os/compiler` reads this skeleton, resolves each `[!include:id](path)` directive, and produces a single output file with each block inlined and wrapped in `<!-- #id -->` / `<!-- /id -->` markers. The resulting file is still a normal SFMD page. The runtime does not need to know about includes — the compiler does.

Use includes when a page has several distinct sections that want their own source files, or when the same section needs to appear on multiple pages.

### Tool blocks

A `tool:<name>` block bundles several actions that share context — a base URL, authentication headers, environment variables:

````markdown
```tool:weather
GET https://api.openweathermap.org/data/2.5
  headers:
    Authorization: Bearer $WEATHER_TOKEN

  ```act.current
  GET /weather?q={city}
    city: string (required)
  ```

  ```act.forecast
  GET /forecast?q={city}&cnt={days}
    city: string (required)
    days: number = "5"
  ```
```
````

Invoking is `/tool:weather.current --city Seoul` or `/tool:weather.forecast --city Seoul --days 7`. Both inherit the base URL and auth header from the enclosing tool block. The weather app in this cookbook does not use a tool block because it has no shared context — two independent `act.` blocks are simpler.

---

## What the file does not need

Worth stating explicitly, because the absences are part of the point:

- **No tool schema.** The field list *is* the schema. The runtime parses it at open time.
- **No input validation code.** The `(required)` marker and type declaration are the validation.
- **No server.** `CLI` actions run under the daemon's shell. `HTTP` actions use the runtime's fetch path. There is nothing for the app author to deploy.
- **No auth scaffolding.** If an action needs a token, it reads `$ENV_VAR`, and the user sets it with `/set VAR value`. Scoped per-user by the env-store.
- **No tests.** The cookbook doesn't ship any. For the weather app, three `/act` calls from the terminal are the test. For larger apps, you write whatever test suite suits you — `string` is a normal Node package.

---

## Next

- **[02 — Why markdown + /command](./02-compare.md)** — the honest comparison with MCP servers and function calling.
