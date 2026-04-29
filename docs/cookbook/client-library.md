---
title: 03 — Client library
---

# 03 — Client library

**Goal:** embed `@string-os/client` in your own agent code so a single tool on the LLM's tool list covers every SFMD app the user installs. About 15 minutes.

This is the recommended integration path when you are building the agent framework itself. If you are wiring `string` into an existing framework with a shell tool, start with chapter [00](./00-weather.md) instead — it uses the CLI and requires no code changes.

---

## What the library is

[`@string-os/client`](https://www.npmjs.com/package/@string-os/client) is a ~185-line TypeScript module with zero dependencies. It uses only Node's built-in `http` module and speaks to a running `stringd` daemon over loopback HTTP. The [`string` CLI itself](https://github.com/string-os/string/blob/main/packages/string/src/cli.ts) is built on the same library — if you wrote the CLI from scratch using `@string-os/client`, the result would be nearly identical.

The library exposes five functions:

| Function | Purpose |
|----------|---------|
| `ping(port)` | Health check: is `stringd` up? |
| `health(port)` | Full health info: user count, session count |
| `ensureUser(port, { id, home })` | Idempotent user registration |
| `exec(port, userId, topic, cmd)` | Run one command, return the structured result |
| `shutdown(port)` | Graceful daemon shutdown |

Everything an agent needs is in `exec`. The others are lifecycle.

---

## Install

```bash
npm install @string-os/client
```

And make sure the daemon is running. The CLI auto-starts it on first use; if you are skipping the CLI, start the daemon yourself once:

```bash
string --daemon start
```

In production, you would typically spawn `stringd` as a subprocess from your agent host on startup and shut it down on exit. The client library does not manage the daemon lifecycle — that is on you.

---

## The minimum working integration

```typescript
import { ping, ensureUser, exec } from "@string-os/client";

const PORT = 3100;
const USER = "default";
const HOME = `${process.env.HOME}/.string/users/default`;

// One-time setup on agent startup
if (!(await ping(PORT))) {
  throw new Error("stringd is not running — run `string --daemon start`");
}
await ensureUser(PORT, { id: USER, home: HOME });

// Your agent's one tool-call wrapper
async function stringTool(topic: string, cmd: string): Promise<string> {
  const result = await exec(PORT, USER, topic, cmd);
  if (!result.ok) {
    return `ERROR(${result.code}): ${result.content}`;
  }
  return result.content;
}
```

Test it:

```typescript
console.log(await stringTool("app:weather", "/open app:weather"));
// # Weather
// A three-action weather app...

console.log(await stringTool("app:weather", "/act.now --city Seoul"));
// seoul: Sunny +20°C ↘6km/h
```

Notice what is absent: no envelope parsing, no JSON wrapping, no SSE stream handling. `exec` handles all of that internally and returns just the payload.

---

## The return shape

`exec` returns an `ExecResult`:

```typescript
interface ExecResult {
  ok: boolean;            // true on success, false on any error
  code: string | null;    // null on success, a short error code on failure
  content: string;        // the rendered payload (no envelope)
  meta: object | null;    // current document metadata, or null
}
```

- **`ok`** — for flow control. An LLM tool wrapper typically branches on this.
- **`code`** — short, machine-readable error identifiers like `NOT_FOUND`, `INVALID_PAYLOAD`, `MISSING_FIELD`, `EXIT_1`. Lets the LLM discriminate between "try again" errors and "this is not going to work" errors without regex-matching on error prose.
- **`content`** — the payload. For `/open`, this is the rendered viewport. For `/act`, this is the action's output (typically stdout for CLI actions, response body for HTTP actions). For errors, this is the error message.
- **`meta`** — present when the command implicitly involves a document load. Contains `uri`, `title`, `current_block` when set. Usually useful for session state tracking, less so for single tool calls.

A typical LLM wrapper looks like this:

```typescript
async function stringTool(topic: string, cmd: string) {
  const result = await exec(PORT, USER, topic, cmd);
  return {
    success: result.ok,
    code: result.code ?? null,
    output: result.content,
  };
}
```

The LLM sees `{ success, code, output }` and decides what to do next.

---

## The single-tool pattern

Here is the payoff — the reason Path 2 is recommended over Path 1 once you are building the agent yourself.

Your LLM has a tool list. For an MCP-based integration, every server contributes its own tools: `weather_now`, `weather_forecast`, `calendar_list`, `calendar_create`, `wiki_search`, and so on. The list grows linearly with installed tools.

With `@string-os/client`, you expose **one tool** to the LLM:

```json
{
  "name": "string",
  "description": "Use an installed SFMD app, browse a markdown site, or open a file. Pass a topic (e.g. 'app:weather', 'web:hn', 'file:main') and a command that starts with /. Discover what an app does by calling /open followed by /act. Installed apps: weather, calendar, wiki.",
  "parameters": {
    "type": "object",
    "properties": {
      "topic": {
        "type": "string",
        "description": "Topic in type:name form. Use 'app:<name>' for installed apps, 'web:<name>' for websites, 'file:<name>' for ad-hoc file sessions."
      },
      "cmd": {
        "type": "string",
        "description": "A string command starting with /. Examples: /open app:weather, /act.now --city Seoul, /info, /nav main."
      }
    },
    "required": ["topic", "cmd"]
  }
}
```

When the user installs the weather app, nothing changes for the LLM. The `string` tool covers it already. The LLM discovers the weather app the way a human discovers a website: by visiting it with `/open app:weather` and reading what comes back. The runtime returns a viewport with `[actions] /act.now --city <string> | /act.forecast --city <string>` in it, which is enough for the LLM to invoke what it needs next turn.

Install twenty apps. The LLM's tool list still has one entry. The prompt size does not grow. The verb the LLM learns is still `string(topic, cmd)`.

This is the property that makes `string` different from an MCP tool soup or a function-calling schema forest. Chapter [02](./02-compare.md) puts numbers on it.

---

## Multi-session agents

The `exec` function's `topic` argument is how you scope work to a session. The daemon holds state per topic — current document, history stack, variables set with `/set`, shortcuts registered by the current page. Two concurrent sessions on two different topics do not step on each other.

```typescript
// Two independent sessions for two apps
const weather = await exec(PORT, USER, "app:weather", "/act.now --city Seoul");
const hn = await exec(PORT, USER, "web:hn", "/open https://news.ycombinator.com");
```

Each topic runs in its own queue inside the daemon. If the agent calls one topic rapidly, commands serialize within that topic but run concurrently with other topics. The daemon caps each topic's queue at 16 commands; see the [stringd protocol spec](https://github.com/string-os/string/blob/main/docs/stringd-protocol-v0.1.md) for queueing semantics.

For multi-user agents — say, a web service fielding requests from many end users — give each end user their own `userId` and call `ensureUser` once per user. The daemon scopes session state by `(userId, topic)`. One running daemon can serve many users cleanly.

```typescript
async function runFor(endUserId: string, topic: string, cmd: string) {
  const home = `/var/lib/string-users/${endUserId}`;
  await ensureUser(PORT, { id: endUserId, home });
  return exec(PORT, endUserId, topic, cmd);
}
```

---

## Error handling

`exec` never throws on application-level errors. It returns `{ ok: false, code, content }`. It does throw on transport-level failures (daemon unreachable, TCP connection error). The typical pattern:

```typescript
async function stringTool(topic: string, cmd: string) {
  try {
    const result = await exec(PORT, USER, topic, cmd);
    return {
      success: result.ok,
      code: result.code,
      output: result.content,
    };
  } catch (err) {
    // Daemon down or unreachable
    return {
      success: false,
      code: "TRANSPORT_ERROR",
      output: `stringd is not reachable on port ${PORT}: ${String(err)}`,
    };
  }
}
```

Common application-level error codes the LLM will see:

| Code | When |
|------|------|
| `NOT_FOUND` | File, shortcut, menu, or block not found |
| `INVALID_TARGET` | `/open` got a malformed URI or path |
| `INVALID_PAYLOAD` | Missing required field, wrong type |
| `COMMAND_UNSUPPORTED` | Command not recognized, or plain text sent to a non-bash topic |
| `EXIT_<n>` | CLI action exited with non-zero code `<n>` |
| `LOAD_ERROR` | Network error fetching a remote document |

Give the LLM the code directly. It is short and stable, and the model can decide to retry, try a different approach, or report back based on the code alone.

---

## Lifecycle notes

- **Daemon startup.** The library does not auto-start `stringd`. Either start it before your agent initializes (`string --daemon start`), spawn it as a subprocess from your agent host, or run it under a service manager. Connection refused on port 3100 means it isn't running.
- **Daemon shutdown.** Call `shutdown(PORT)` on graceful exit if you own the daemon. If multiple agents share a daemon, leave it alone.
- **Config.** Port is `STRINGD_PORT` (default `3100`). User ID defaults to `"default"`. Home directory default is `~/.string/users/<userId>`. All three are typically fine; override them for multi-user or multi-tenant deployments.
- **Logs.** The daemon writes structured logs to stderr when started with `--log`. For production you want those piped somewhere durable.

---

## A footnote on the protocol

The wire format between the library and the daemon is HTTP/SSE — a `POST /exec` request, a Server-Sent Events response with `head`, `content`, and `done` frames. The response is a channel-framed block internally (what you see in the CLI as `<𝒞=…>…</𝒞>`), and the library strips the framing before returning. That framing convention is an early prototype of a broader channel protocol we are working on separately. For now, it is an implementation detail — you do not need to parse it, brand it, or think about it. The library handles it, and the surface you see is `{ ok, code, content, meta }`.

The full wire spec, for anyone implementing a client in another language, lives at [`docs/stringd-protocol-v0.1.md`](https://github.com/string-os/string/blob/main/docs/stringd-protocol-v0.1.md).

---

## Next

- **[00 — Weather app](./00-weather.md)** — the end-to-end walkthrough using the CLI. Useful as a sanity check before you wire the library in.
- **[01 — Anatomy](./01-anatomy.md)** — what an SFMD app looks like on disk. The file your agent's users will install.
- **[02 — Why markdown + /command](./02-compare.md)** — the comparison with MCP and function calling, where the single-tool pattern pays off.
