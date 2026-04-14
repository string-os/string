# Writing Skills

A skill is a single SFMD (`.md`) file that defines actions an AI agent can execute. Skills are the primary way to extend String's capabilities.

## Basic Structure

```markdown
---
name: my-tool
default: run
---

# My Tool

Description of what this tool does.

\`\`\`act.run
CLI echo "Hello, $ARGS"
\`\`\`
```

### Frontmatter

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Tool identifier (used in `/tool:name`) |
| `default` | No | Action to run when tool is invoked without specifying one |
| `description` | No | Human-readable description |
| `env` | No | Required environment variables |

## Action Types

### CLI Actions

Run shell commands. Use `$ARGS` for passthrough or named parameters.

**Passthrough** — forward all arguments:

```markdown
\`\`\`act.run
CLI git $ARGS
\`\`\`
```

Usage: `/tool:git status`, `/tool:git log --oneline -5`

**Named parameters** — structured invocation:

```markdown
\`\`\`act.search
CLI grep -r {pattern} {path}
  pattern: string "Search pattern" (required)
  path: string "Directory to search" (required)
\`\`\`
```

Usage: `/act.search --pattern "TODO" --path ./src`

### HTTP Actions

Call REST APIs with any HTTP method.

```markdown
\`\`\`act.get-issue
GET https://api.github.com/repos/{owner}/{repo}/issues/{number}
-H "Authorization: Bearer $GITHUB_TOKEN"
-H "Accept: application/vnd.github.v3+json"
  owner: string "Repository owner" (required)
  repo: string "Repository name" (required)
  number: number "Issue number" (required)
\`\`\`
```

Supported methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`.

### Headers

Use `-H "Key: Value"` syntax (curl-style) on lines before the field definitions:

```markdown
\`\`\`act.create
POST https://api.example.com/items
-H "Authorization: Bearer $API_TOKEN"
-H "Content-Type: application/json"
  title: string "Item title" (required)
  body: string "Item body"
\`\`\`
```

## Response Templates

Define how action responses are processed:

```markdown
\`\`\`act.forecast
GET https://wttr.in/{city}?format=j1
  city: string "City name" (required)
\`\`\`

\`\`\`act.forecast.response
{temperature} = {Response.body.current_condition.0.temp_C}
{description} = {Response.body.current_condition.0.weatherDesc.0.value}

Weather in {city}: {temperature}C, {description}
\`\`\`
```

**Assignment lines** (`{var} = {Response.body.path}`) extract values from the JSON response and store them as session variables.

**Output lines** are rendered with variable substitution and returned to the AI.

## Variables

| Syntax | Scope | Description |
|--------|-------|-------------|
| `{var}` | Session | AI-managed, in-memory, lost on session close |
| `$VAR` | Persistent | File-backed via EnvStore, survives restarts |

### Context Variables (for tools)

| Variable | Value |
|----------|-------|
| `$ARGS` | Raw argument string from invocation |
| `$CURRENT_FILE` | Path of the currently open file |
| `$CWD` | Current working directory |
| `$CURRENT_URI` | URI of the current document |

## Examples

### Git (CLI passthrough)

```markdown
---
name: git
default: run
---

# Git

\`\`\`act.run
CLI git $ARGS
\`\`\`
```

### GitHub Issues (REST API)

```markdown
---
name: github-issue
default: list
env:
  - name: GITHUB_TOKEN
    description: GitHub personal access token
---

# GitHub Issues

\`\`\`act.list
GET https://api.github.com/repos/{owner}/{repo}/issues
-H "Authorization: Bearer $GITHUB_TOKEN"
  owner: string "Repository owner" (required)
  repo: string "Repository name" (required)
\`\`\`

\`\`\`act.create
POST https://api.github.com/repos/{owner}/{repo}/issues
-H "Authorization: Bearer $GITHUB_TOKEN"
  owner: string "Repository owner" (required)
  repo: string "Repository name" (required)
  title: string "Issue title" (required)
  body: string "Issue body"
\`\`\`
```

### File Search (CLI structured)

```markdown
---
name: file-search
default: grep
---

# File Search

\`\`\`act.grep
CLI grep -rn {pattern} {path}
  pattern: string "Search pattern" (required)
  path: string "Directory" (required)
\`\`\`

\`\`\`act.find
CLI find {path} -name {name}
  path: string "Directory" (required)
  name: string "File name pattern" (required)
\`\`\`
```

## Installing Skills

```bash
# Install as a tool
string file:main '/install --tool ./skills/git.md'

# Install from URL
string file:main '/install --tool https://example.com/skills/git.md'

# Use the tool
string file:main '/tool:git status'
```

Skills can also be fetched directly by URL — no installation needed. An AI agent can fetch any hosted `.md` file and use its actions.

## Skill vs App

| | Skill (Tool) | App |
|---|---|---|
| Invocation | `/tool:name` | `/open` or `app:name` |
| Scope | Single file, single task | Multi-page, persistent session |
| Result | Returns output, no context switch | Opens as a document |
| State | Stateless (per-invocation) | Session state preserved |

Both use the same `act.*` block syntax. The difference is in how they're invoked and whether they maintain state.
