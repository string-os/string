---
title: Writing your first app
---

A String app is one Markdown file (or a folder of them). The file declares
actions; the runtime turns those actions into `/act.*` commands an AI agent
can call. No build step, no scaffolding.

This page walks from hello-world to a publishable app — response templates,
credentials, multi-file layout, output conventions, security model.

## Minimal skeleton

```markdown
---
name: hello
type: app
default: greet
---

# Hello

A two-action demo.

\`\`\`act.greet
CLI echo "Hello, {name}!"
  name: string (required) "Person to greet"
\`\`\`
```

Three pieces:

- **Frontmatter** — `name` is the registry id, `type` is `app` or `tool`,
  `default` is the action that runs on `/open` with no args.
- **Body** — what the agent reads when it `/open`s the app. Keep it short —
  every line costs tokens on every call.
- **Action block** — one fenced `act.<id>` block per action. First line is
  the recipe (`CLI …` for shell, `GET|POST|…` for HTTP). Indented lines
  below declare typed fields.

Install and try:

```bash
string '/install --app ./hello.md'
string app:hello '/act.greet --name World'
# → Hello, World!
```

The runtime copies the file into `~/.string/users/default/packages/hello/`
and registers `hello` in the apps registry. From now on, `app:hello` is
addressable from any session.

## Action types

**CLI** — runs a shell command. `{field}` placeholders get the user's
argument values shell-escaped:

```markdown
\`\`\`act.search
CLI grep -rn {pattern} {path}
  pattern: string (required) "What to find"
  path: string (required) "Where to look"
\`\`\`
```

**HTTP** — calls an API. Add `-H "Header: Value"` flags on the same line;
declare a body with `-d '{...}'` if needed. `$VAR` references resolve from
the env store (set with `/set $VAR = "..."`):

```markdown
\`\`\`act.now
GET https://wttr.in/{city}?format=j1 -H "User-Agent: curl/8"
  city: string (required) "City name"
\`\`\`
```

## Response templates

Raw HTTP/CLI output is rarely what you want the agent to see. A
sibling `act.<id>.response` block reshapes the response into
agent-friendly Markdown.

Three patterns cover most apps:

**1. Variable extraction.** Pull fields out of a JSON response:

```markdown
\`\`\`act.now.response
{city} = {Response.body.location.name}
{temp} = {Response.body.current.temp_c}

Weather in {city}: {temp}°C
\`\`\`
```

**2. Iteration with `for:` / `end:`.** Render an array:

```markdown
\`\`\`act.repo.response
# Issues

for: i in Response.body
- #{i.number}: {i.title} — {i.state}
end:
\`\`\`
```

**3. Value shortcuts.** `{@var} = (...)` registers a typed shortcut the
agent can pass back to later actions. Inside a `for:` loop the slug
auto-enumerates (`@issue-1`, `@issue-2`, …):

```markdown
\`\`\`act.repo.response
# Issues

for: i in Response.body
{@issue} = ({i.repository.nameWithOwner}, {i.number})
- {@issue} {i.repository.nameWithOwner}#{i.number}: {i.title}
end:

next: /act.read @issue-N · /act.comment @issue-N "..."
\`\`\`
```

After running `/act.repo`, the agent gets:

```
# Issues

- @issue-1 string-os/string#42: ...
- @issue-2 string-os/string#43: ...

next: /act.read @issue-N · /act.comment @issue-N "..."
```

Then `/act.read @issue-1` resolves `@issue-1` to the `(repo, number)`
tuple and the receiving action templates with `{issue[0]}` / `{issue[1]}`.

The trailing `next:` line is the discovery contract: every action response
ends with concrete next commands so the agent never has to guess.

## Credentials & env

Declare required env vars in frontmatter:

```yaml
---
requires: [REPO, GITHUB_TOKEN]
---
```

On `/open` the runtime cross-checks the env store. Missing vars surface as
a `[!] Missing required env: $REPO` hint at the top of the response, with
the exact `/set` command to run.

Set persistently — vars are **app-scoped** (no global env):

```bash
string app:gh-issue '/set $REPO = "string-os/string"'
```

The cascade is `app:<name>:<config>` → `app:<name>`. Use a config
sub-topic when one app needs different credentials per account or region:

```bash
string 'app:gh-issue:work' '/set $REPO = "company/repo"'
string 'app:gh-issue:oss'  '/set $REPO = "string-os/string"'
```

For setup that needs more than one env var (signing into a service,
installing a CLI tool, etc.), ship a sibling `requirements.md`:

```
~/.string/users/default/packages/gh-issue/
├── string.md
└── requirements.md
```

When an action fails AND the package has a `requirements.md`, the error
response auto-appends `Setup info: /open requirements.md`. The agent
knows where to go.

## Multi-file apps

One `string.md` is fine for hello-world. Real apps usually split. The
installer copies every non-`.md` sibling alongside `string.md` (helpers,
binaries) with the executable bit preserved — so an app can ship its own
CLI wrapper without external packaging.

A real layout from the cookbook (`moltbook`, an AI social network demo):

```
moltbook/
├── string.md          # entry — frontmatter, [!nav], default action
├── communities.md     # /open @communities
├── messages.md        # /open @messages
├── profile.md         # /open @profile
└── requirements.md    # API key setup
```

Wire navigation in `string.md`:

```markdown
[!nav:main]
  [Feed][@feed]
  [Communities][@communities]
  [Messages][@messages]
  [Profile][@profile]
```

The agent calls `/nav main` to see the menu, `/open @communities` to
jump. Each sub-page can declare its own actions — they're addressed as
`/act.<name>` once the page is open.

To pull a fragment of another file into the current page, use
`[!include](./communities.md#hot)` — the runtime inlines the block
identified by `<!-- #hot -->` markers.

## Output conventions

The runtime expects a few things from a well-behaved app. Following
these makes the app land naturally in any agent's loop.

- **Markdown body**, not JSON. Actions render Markdown; raw JSON is
  almost always wrong.
- **`next:` line at the end** of action responses, with the literal
  commands to run next. Discovery loop only works if every action
  carries it.
- **`✓` for feedback**, `✗ ERROR_CODE: message` for failures. Authors
  rarely emit these directly — the runtime does it — but match the
  shape if you must.
- **`/open` is pure read**, `/act` is the side-effect verb. An agent
  reading a feed should never accidentally post.
- **No repeated menu**. The runtime auto-prepends the `[actions]` line
  on `/open`; don't paste it in your body.

## Testing & validating

The compiler ships a `sfmd` CLI for static checks:

```bash
npm install -g @string-os/compiler

sfmd validate ./string.md           # parse + structural check
sfmd extract  ./string.md '#intro'  # pull one block by id
sfmd compile  ./string.md           # resolve includes, write a single file
```

Then drill the app live:

```bash
string app:myapp /open                          # see action menu + body
string app:myapp '/act --help'                  # every action's schema
string app:myapp '/act.my-action --field "v"'   # run it
string app:myapp /info                          # session state, history
```

Look for:

- Parse warnings visible on `/info` (auto-shortcut clashes, unknown
  references in code-aware regions).
- Missing-env hints prepended to `/open` output.
- A `next:` line on every action response — empty `next:` means the
  discovery loop is broken.

## Security & distribution

v0.1 trust model in one paragraph: **CLI actions run unsandboxed.** An
installed app executes with your user's permissions, makes whatever HTTP
calls its action templates declare, and reads/writes wherever the shell
allows. There is no per-host allowlist and no per-command sandbox.
Inspect `string.md` before installing — it's plain Markdown, which is
the whole point.

`$VAR` interpolation is a real shape of trust: if an action's URL or CLI
template includes `{user_input}`, the runtime shell-escapes (CLI) or
URL-encodes (HTTP) but the resulting URL/command is still
user-influenced. Treat actions as you would treat a small CLI tool
shipped over the wire.

Distribute by:

- **Local file** — `string '/install --app ./apps/myapp/string.md'`
- **HTTPS URL** — `string '/install --app https://example.com/myapp/string.md'`.
  For multi-file apps, the URL points at a manifest declaring sibling
  files; the runtime fetches each and writes them into the package
  directory.

Signed packages with proper provenance land in 0.2.

## App vs Tool

|  | App (`type: app`) | Tool (`type: tool`) |
|---|---|---|
| Invocation | `/open app:name` then `/act.x` | `/tool:name args` |
| Scope | Multi-page, persistent session | Single call, no session state |
| Use when | The agent will work in this context for a while | One-shot helper |

Both use the same action syntax. App is the default — pick tool only when
there's no per-session state worth keeping.

## What's next

- **[Cookbook](https://github.com/string-os/cookbook)** — runnable apps
  with real APIs (weather, AI social network, GitHub issue triage,
  Kanban over GitHub Projects, image generation). Clone, read, modify.
- **[Authoring guide](../runtime/authoring.md)** — deeper SFMD
  authoring: block addressing, navigation menus, includes, response
  templates.
- **[Actions reference](../sfmd/actions.md)** — full action block
  grammar.
- **[SFMD spec](../sfmd/overview.md)** — every directive and field,
  formally.
