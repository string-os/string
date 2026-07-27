---
title: Actions
---

Actions define executable operations within a document. They are
written as fenced code blocks with an `act.` info string prefix.

---

## Definition syntax

An action is defined in a fenced code block whose info string
starts with `act.`:

````markdown
```act.action_id
TYPE endpoint_or_command
  param1: type (constraints) "description"
  param2: type (constraints) "description"
```
````

- **Info string:** `act.` followed by the action ID
- **First line:** action type and topic
- **Following lines:** parameter definitions (indented)

---

## Action ID rules

Action IDs MUST follow these rules:

| Rule | Valid | Invalid |
|------|-------|---------|
| Lowercase letters | `search` | `Search` |
| Numbers allowed | `get_v2` | — |
| Underscores allowed | `search_city` | — |
| Hyphens allowed | `search-city` | — |
| Must start with a letter | `deploy` | `2deploy` |

**Pattern:** `[a-z][a-z0-9_-]*`

Action IDs MUST be unique within a document.

---

## Action types

The first line of the code block declares the type and topic.

### GET

```
GET https://api.example.com/search
```

HTTP GET request. Parameters are sent as query string.

### POST

```
POST https://api.example.com/submit
```

HTTP POST request. Parameters are sent as JSON body.

### PUT

```
PUT https://api.example.com/resource/{id}
```

HTTP PUT request. Parameters are sent as JSON body.
Replaces the entire resource. Standard REST semantics.

### PATCH

```
PATCH https://api.example.com/resource/{id}
```

HTTP PATCH request. Parameters are sent as JSON body.
Updates specific fields. Standard REST semantics.

### DELETE

```
DELETE https://api.example.com/resource/{id}
```

HTTP DELETE request. Parameters are sent as query string
(same as GET).

### CLI

```
CLI command-name --flag {param}
```

Shell command execution. Parameters are substituted into the
command template.

---

## Parameter definitions

Each parameter is defined on its own line, indented with spaces:

```
  name: type (constraints) "description"
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Parameter name |
| `type` | Yes | Data type |
| `constraints` | No | Parenthesized constraints |
| `description` | No | Quoted description text |

### Types

| Type | Description |
|------|-------------|
| `string` | Text value |
| `number` | Numeric value (integer or float) |
| `boolean` | True or false |
| `path` | File path |
| `tuple` | Multi-slot value (typically a tuple shortcut like `@reply-3`). The URI/body template addresses individual slots with `{name[N]}`. See [Shortcuts → Tuple value shortcuts](./shortcuts.md#tuple-value-shortcuts). |

### Constraints

Constraints appear in parentheses, comma-separated:

| Constraint | Meaning |
|-----------|---------|
| `required` | Parameter must be provided |
| `optional` | Parameter may be omitted (default) |
| value hints | Allowed values, e.g. `celsius\|fahrenheit` |
| `max:N` | Maximum value or length |
| `min:N` | Minimum value or length |

### Examples

```
  q: string (required) "Search query"
  limit: number (optional, max:50) "Maximum results"
  unit: string (optional) "celsius|fahrenheit"
  verbose: boolean (optional) "Enable detailed output"
  manifest: path (required) "Kubernetes manifest file"
```

### Loading a field value from a file

For a long or multi-line value, pass `--<field>-file <path>` instead of
`--<field>`: the file's contents become that field's value. Handy for a brief
you don't want to shell-quote; `--message-file <(some-command)` covers the pipe
case via process substitution.

- Only recognized when the action declares field `<field>`. An undeclared
  `--x-file` is left as an ordinary flag.
- Passing both `--<field>` and `--<field>-file` is an error, not a precedence
  choice. So is an unreadable path or a file larger than 1 MiB.
- The value is treated as literal data: `{curly}` and other text pass through
  without `{var}` substitution.
- **Security:** a file value that contains a shell metacharacter (`$` or a
  backtick) is refused, because field values are interpolated into the action's
  command and those characters would be executed. Keep such content out of the
  file (a shell-safe substitution path that lifts this restriction is planned).

---

## Complete definition examples

### GET action

````markdown
```act.search_city
GET https://api.weather.com/search
  name: string (required) "City name to search"
  unit: string (optional) "celsius|fahrenheit"
```
````

### POST action

````markdown
```act.create_alert
POST https://api.weather.com/alerts
  city: string (required) "Topic city"
  condition: string (required) "rain|snow|temp"
  threshold: number (optional) "Trigger value"
```
````

### PUT action

````markdown
```act.update_alert
PUT https://api.weather.com/alerts/{alert_id}
  alert_id: string (required) "Alert ID"
  condition: string (required) "New condition"
```
````

### PATCH action

````markdown
```act.patch_settings
PATCH https://api.weather.com/accounts/{account_id}/settings
  account_id: string (required) "Account ID"
  unit: string (optional) "celsius|fahrenheit"
```
````

### DELETE action

````markdown
```act.delete_alert
DELETE https://api.weather.com/alerts/{alert_id}
  alert_id: string (required) "Alert ID"
```
````

### CLI action

````markdown
```act.deploy
CLI kubectl apply -f {manifest}
  manifest: path (required) "Kubernetes manifest file"
```
````

The reference String runtime executes `CLI` actions only from local
`file://` documents: local SFMD files and apps installed as local copies.
Web-hosted SFMD and linked remote apps may run HTTP actions, but they
cannot run local commands.

---

## Headers

HTTP actions MAY declare custom headers on the first line using
curl-style `-H` flags:

```
GET https://api.example.com/data -H "Authorization: Bearer $TOKEN"
```

### Syntax

Headers are appended after the URL on the first line:

```
METHOD url -H "Header-Name: value" -H "Another: value"
```

- `-H "Key: Value"` — curl-compatible syntax
- Multiple headers: repeat `-H` flags
- `$variable` — persistent variable (configuration, credentials)
- `{variable}` — session variable (runtime data)

### Examples

````markdown
```act.inbox
GET https://gmail.googleapis.com/v1/users/me/messages -H "Authorization: Bearer {access_token}"
  maxResults: number (optional)
  q: string (optional) "Search query"
```
````

````markdown
```act.create_issue
POST https://api.github.com/repos/{repo}/issues -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3+json"
  title: string (required)
  body: string (optional)
```
````

### Rules

1. Headers appear on the first line only, after the URL.
2. Each header is a separate `-H "Key: Value"` flag.
3. Variable substitution (`{var}` and `$var`) applies to header values.
4. No default headers are injected for actions — only declared
   headers are sent.

---

## Body template

HTTP actions (`POST`, `PUT`, `PATCH`) default to sending the payload
fields as a flat JSON object (`JSON.stringify(payload)`). When the API
expects a different body shape — nested objects, specific field names,
type wrappers — declare an explicit body template using the `body:`
directive inside the action block.

### Syntax

````markdown
```act.generate
POST https://api.example.com/v1/generate -H "Authorization: Bearer $API_KEY"
  prompt: string (required) "Input text"
  filename: string (required) "Output path"
  resolution: string "1K, 2K, or 4K" = "1K"

  body:
    {
      "contents": [{"parts": [{"text": "{prompt}"}]}],
      "config": {"size": "{resolution}"}
    }
```
````

- **`body:`** is an indented directive line. Continuation lines
  (indented more than the `body:` line itself) are part of the body.
  Blank lines inside the body are preserved.
- **`{field}`** placeholders are substituted from the action's payload.
  When a placeholder appears inside a JSON string literal (between
  `"`), the value is JSON-string-escaped (quotes, backslashes,
  control chars, unicode). Outside a JSON string, the value is
  inserted raw.
- **`{field[N]}`** addresses a single slot of a `tuple`-typed field
  (zero-indexed). Use this whenever the field receives a tuple
  shortcut like `@reply-3` (see
  [Shortcuts → Tuple value shortcuts](./shortcuts.md#tuple-value-shortcuts)).
  `{field}` without an index emits the tuple joined by `,` as a
  debug fallback; out-of-range indices substitute empty string.
- **Modifiers** may be appended after a pipe: `{field|modifier}`.

### Field modifiers

| Modifier | Effect |
|----------|--------|
| `{name\|base64}` | Base64-encode the field value as-is |
| `{name\|base64file}` | Read the value as a file path, base64-encode the bytes |
| `{name\|file}` | Read the value as a file path, insert the file contents |

Modifiers compose left-to-right: `{name|file|base64}` reads the file
then base64-encodes the result.

`{name|base64file}` is the common pattern for binary inputs (images,
audio) that would exceed the OS argument-length limit if the caller
encoded them inline.

### When body: is omitted

If no `body:` directive is declared, the runtime sends
`JSON.stringify(payload)` — the remaining payload fields (after URI
substitution) serialized as a flat JSON object. This matches the
behavior of most simple CRUD APIs:

```
POST https://api.example.com/resource
  title: string (required)
  body: string (optional)
```

Calling `/act.create --title "Hello" --body "World"` sends
`{"title":"Hello","body":"World"}`.

`body:` is ignored for `GET`, `DELETE`, and `CLI` methods.

---

## Invocation hint

An invocation hint is an inline code span showing how to call the
action. It is content, not metadata — it tells the reader (AI or
human) what the action looks like when invoked.

```markdown
`/act.search_city --name "{City Name}"`
`/act.search_city "{City Name}"`
```

Both forms are valid. Bare values (no leading `-`) bind to the
action's required fields in declaration order; `--name value`,
`--name=value`, and short aliases (`-n value`) are also accepted.
A bare `--` ends option processing — anything after it is positional
even if it starts with `-`.

Invocation hints are conventional, not parsed by the SFMD format
itself. They serve as documentation within the document. Runtime
binding rules are described in the [runtime actions](../runtime/actions.md)
guide.

---

## Response template

An action MAY have a companion response template defined in a
separate code block:

````markdown
```act.action_id.response
template content
```
````

The info string is `act.` + action ID + `.response`.

### Template lines

A response template contains six types of lines, recognized in
this order:

**1. Assignment lines** — store values from the response:

```
{variable} = {Response.body.field}
```

A line is an assignment if it matches the pattern:
`{identifier}` followed by ` = ` followed by an expression.

Assignment lines are evaluated but produce no output.

**2. Save directive** — extract a value from the response body into
an internal buffer:

```
save: candidates[0].content.parts[0].inlineData.data
```

The path walks the JSON response body directly (no `Response.body.`
prefix needed; `$.` is optional). Array indices (`[0]`, `[1]`, ...)
are supported alongside dotted keys.

**3. Decode directive** — reinterpret the buffer extracted by `save:`:

```
decode: base64
```

Currently supported: `base64`, `none`. After decoding, the buffer
holds the decoded bytes.

**4. For/end directive** — iterate over an array in the response:

```
for: post in Response.body.posts
{@post} = {post.id}
- {@post}: {post.title} — by {post.author.name}
end:

next: /act.read @post-N · /act.upvote @post-N
```

Each iteration registers an inline shortcut (`@post-1`, `@post-2`, …)
that maps to the post id. The `next:` line tells the agent which
actions to chain. The agent invokes `/act.<name>` explicitly — no
hidden dispatch via `/open`.

The output is intentionally plain text rather than a markdown link:
posts here are `/act`-only entities (no public URL to fetch). An AI
reading raw SFMD still sees the action declaration and the `next:`
hint and can reason about what would happen under String. For items
that are `/open`-able (pages, external resources), use standard
markdown link form so a plain markdown viewer can follow them too —
see [Shortcuts → Drill-in pattern](./shortcuts.md#drill-in-pattern-shortcut--value-in-action-responses).

When the next action needs more than one identifier — e.g. a
reply requires both `post_id` and `comment_id` — register the
shortcut as a **tuple** by wrapping the RHS in parentheses:

```
for: c in Response.body.comments
{@reply} = ({post}, {c.id})
- {@reply}: {c.author.name}: {c.content}
end:

next: /act.reply @reply-N "..."
```

`@reply-3` then carries `[post_id, comment_3_id]`. The receiving
action declares a `tuple`-typed field and addresses individual
slots with `{name[N]}` in its URI/body template — see
[Shortcuts → Tuple value shortcuts](./shortcuts.md#tuple-value-shortcuts)
for the full pattern.

`for: <var> in <path>` opens a loop. `<path>` is resolved against the
response (same path syntax as assignment lines and `save:`). `<var>`
binds each element to a name that can be referenced inside the loop
as `{var}` or `{var.field}` for object elements. `end:` closes the
nearest open loop.

Loops MAY be empty (zero iterations produce zero output). If `<path>`
resolves to a non-array value, the loop produces a warning line and
no output. Loops MUST NOT be nested in v0.1.

**5. To directive** — write the buffer to a file:

```
to: {filename}
```

The path supports `{field}` (action payload) and `{var}` (session
variable) substitution. After writing, no output is produced by
default — the author should add an explicit output line for any
user-visible success message.

**6. Output lines** — everything else:

```
## Weather in {city}
- Temperature: {temp}°C
```

Output lines are rendered as Markdown with three substitution
passes: `{Response.body.X}` (response data), then `{var}` (session
variables), then `{field}` (action payload fields — the flags the
caller passed). This allows output lines like:

```
Saved: {filename} ({mime}, {resolution})
```

where `{filename}` and `{resolution}` come from the action's
payload, and `{mime}` was set by an assignment line earlier.

### Save/decode/to pipeline

The three directives form a pipeline for extracting binary data
from JSON API responses:

1. `save:` reads a JSON path → buffer is a string (the raw value)
2. `decode: base64` converts the buffer → buffer is now bytes
3. `to: {path}` writes the bytes to a file

Example: save a Gemini-generated image:

````markdown
```act.generate.response
{mime} = {Response.body.candidates[0].content.parts[0].inlineData.mimeType}
save: candidates[0].content.parts[0].inlineData.data
decode: base64
to: {filename}
Saved: {filename} ({mime})
```
````

If `save:` resolves to `undefined` (path not found), a warning line
is emitted and `to:` is skipped. If `decode:` fails, a warning line
is emitted. These warnings become part of the output.

### Complete example (text template)

````markdown
```act.search_city.response
{city} = {Response.body.city}
{temp} = {Response.body.temperature}
## Weather in {city}
- Temperature: {temp}°C
- Condition: {Response.body.condition}
- Humidity: {Response.body.humidity}%
```
````

### Response reference syntax

Response data is accessed using dot-and-bracket notation:

| Reference | Meaning |
|-----------|---------|
| `{Response.body.field}` | Field from response body |
| `{Response.body.nested.field}` | Nested field |
| `{Response.body.items[0].name}` | Array index + field |
| `{Response.body[0].display_name}` | Top-level array element |
| `{Response.status}` | HTTP status code (HTTP actions) or exit code (CLI actions) |
| `{Response.body}` | Entire response body |
| `{Response.stdout}` | CLI actions only: standard output |
| `{Response.stderr}` | CLI actions only: standard error |
| `{Response.exit_code}` | CLI actions only: process exit code (alias of `status`) |

For CLI actions, `{Response.body}` is stdout+stderr interleaved (the same text
you'd see in a terminal); `stdout` and `stderr` give the streams separately.
The `stdout`/`stderr`/`exit_code` references exist only for CLI actions — using
them on an HTTP action is an unresolved reference (see below).

Array indices accept either `[N]` or bare-digit `.N` form, both
zero-based: `body.items[0].name` and `body.items.0.name` are
equivalent. A leading `$.` is allowed and ignored (JSONPath
compatibility).

Unresolved references are loud, not silent. A reference whose path does not
exist (a typo, a missing key, an out-of-range index) is left **visible** as its
literal `{Response.…}` in the output and a warning lists what the response
actually exposes — the same way an unknown `{var}`/`{field}` keeps its literal.
An explicit `null` in the data is a real value and still renders as an empty
string; only a genuinely missing path is treated as unresolved.

### Execution behavior

Action invocation is "call and read the result" — not navigation.
When an HTTP action completes:

- If a response template is declared, the runtime runs it and returns
  the output (text lines joined, after all substitutions and file
  writes).
- If no response template is declared, the runtime returns the
  response body as plain text. The current document stays unchanged.

In neither case does the current document switch to the response.
The action's output is rendered in the viewport; the session's
document, history, and shortcuts remain where they were before the
call. This means an agent can invoke multiple actions in sequence
without re-`/open`-ing the app between calls.

---

## Variable references in actions

Action definitions MAY reference variables:

- **`{variable}`** — session variable, substituted at invocation time
- **`$variable`** — persistent variable, substituted by the engine

```
GET https://api.example.com/search?key=$API_KEY
  q: string (required)
```

See [Variables](./variables.md) for variable syntax rules.

---

## Visibility

Action definition blocks (`act.name`) and response template blocks
(`act.name.response`) are metadata. In String runtime, they are
parsed and registered but not displayed as document content.

In a standard CommonMark viewer, they render as regular fenced
code blocks — visible but clearly marked as code.

### Help and action listings

When the runtime lists actions — via `/act`, `/act.<name> --help`,
the `[actions]` hint prepended on `/open`, or the "Actions on this
page" section in `/help` — it shows only the **call interface**:

```
/act.search_city
   --name <string> (required) — City name to search
   --unit <string> (optional) — celsius|fahrenheit
```

The action method (`GET`, `POST`, `CLI`, etc.), the URL or command
template, the `body:` template, headers, and response template
directives are **not shown**. They are implementation — the runtime's
concern, not the caller's. This keeps the help surface focused on
"what to call, what to pass" and saves context tokens.

For inspection — security audit, debugging, curiosity — `/source`
dumps the full `.md` file including all action blocks, body templates,
headers, and response templates.

---

## Rules summary

1. Definition: fenced code block with `act.` info string prefix.
2. First line: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, or `CLI` followed by endpoint/command.
3. Headers: `-H "Key: Value"` on the first line, after URL. HTTP only. CLI templates preserve `-H` as part of the command.
4. Parameters: indented, `name: type (constraints) "description"`.
5. Body template: `body:` directive (indented, multi-line). `{field}` substituted (JSON-string-aware). `{field|modifier}` for transforms. POST/PUT/PATCH only. If omitted, `JSON.stringify(payload)`.
6. Action IDs: `[a-z][a-z0-9_-]*`, unique within a document.
7. Response template: `act.id.response` info string, optional.
8. Response assignment: `{var} = {expression}` — no output.
9. Response directives: `save:` (extract JSON path to buffer), `decode:` (transform buffer), `to:` (write buffer to file). Pipeline order.
10. Response output: everything else — rendered as Markdown template with `{Response.body.X}`, `{var}`, and `{field}` substitution.
11. Non-navigation: action invocation returns output text. The current document does NOT change. Sequential actions on the same page work without re-opening.
12. Help visibility: `/act` and `--help` show verb + fields only. Method, URL, body, headers, response template are hidden. `/source` for full inspection.
13. `$variable` in definitions: resolved from extraEnv → env-store → process.env (in that order).
14. Invocation hints in inline code: conventional, not parsed.
15. In CommonMark viewers, action blocks render as code blocks.
16. `tuple` field type addresses individual slots with `{field[N]}` (zero-indexed) in URI and body templates. Bare `{field}` joins slots with `,` as a debug fallback.
