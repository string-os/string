---
title: stringd Protocol v0.1
---

**Status:** Normative. This document specifies the wire protocol between a String client and a `stringd` daemon. Any client implementation (TypeScript, Python, Go, anything else) that conforms to this document can drive a running `stringd`. The reference implementations are [`@string-os/client`](https://www.npmjs.com/package/@string-os/client) (TypeScript) and [`string-os`](https://pypi.org/project/string-os) (Python, planned).

**Version:** 0.1 — matches `@string-os/string@0.1.x`. Breaking changes to this protocol will bump the major version of the daemon and be documented in `stringd-protocol-v0.2.md`, with explicit migration notes.

**Transport:** HTTP/1.1 over loopback (`127.0.0.1`) by default. Port: `3100` by default, configurable via `STRINGD_PORT`.

---

## Security model

`stringd` is a **single-user, loopback-only** daemon. The protocol is designed around these assumptions — conforming implementations MUST NOT loosen them without an explicit versioned extension.

1. **Loopback only.** The daemon binds `127.0.0.1`. It is not a network service. Do not put it behind a reverse proxy, do not expose it in a shared container, do not publish the port. CORS is permissive for local-tooling convenience, not as a security boundary.
2. **`X-User-Id` is identity, not authentication.** It selects which user record a request operates under. Any process on the loopback interface can set any value. The trust assumption is "same host, same OS user" — processes on the same machine running as the same UID are trusted to not lie to each other.
3. **No per-request signing or token auth.** `/health` and `/shutdown` accept any caller. A hostile local process can shut the daemon down; this is equivalent to sending `SIGTERM`, which such a process could already do.
4. **Request body cap.** The daemon rejects bodies larger than 10 MiB to prevent trivial OOM. Clients SHOULD NOT send JSON payloads anywhere near this bound.
5. **Shell execution is by design.** `/exec` and CLI-method actions run under `/bin/bash -c`. This is a deliberate property of the agent runtime, not a vulnerability. Embedders who need sandboxing must provide it at the OS level (containers, firejail, VMs).

If your deployment needs multi-tenant access, remote use, or per-request authentication, **do not run v0.1 of `stringd`**. These are planned for v0.2 as an explicit protocol extension.

---

## Concepts

A **user** is the top-level identity. Each user has a home directory (`user.home`) and an optional allowlist of additional accessible paths. Users are registered via `POST /users` and persist across daemon restarts in `${STRINGD_DATA_DIR}/users.json` (default: `.stringd/users.json` in the daemon's working directory).

A **topic** is the unit of session scope. A topic is either a bare name — a free-form `tab` (e.g. `main`, `docs`) — or canonical: `app:name[:config]` (e.g. `app:weather:korea`) or `bash:name` (e.g. `bash:dev`). The bare names `app`, `bash`, `tool`, `system` are reserved as `hub` aggregators. A topic belongs to a user. The runtime maintains per-topic state (current document, variables, history, bash PTY if applicable).

A **command** is a single `/open`, `/act`, `/nav`, `/info`, `/set`, `/edit`, etc. invocation. Commands execute in a topic's context. A client sends one command per `POST /exec` call; the daemon responds with a Server-Sent Events (SSE) stream containing a head event, a content event, and a done event.

---

## Base URL and headers

All endpoints are served under `http://127.0.0.1:${STRINGD_PORT}`. The daemon does not bind to external interfaces.

All requests that operate on user data must include the user ID header:

```
X-User-Id: <user_id>
```

Endpoints that do not require a user (`/users`, `/health`, `/shutdown`) ignore this header if present.

CORS is permissive: the daemon sends `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Headers: Content-Type, X-User-Id` on every response, and responds to `OPTIONS` preflight with `204 No Content`. Clients should not rely on CORS for security — `stringd` is intended for loopback only.

All request bodies, where present, MUST be `Content-Type: application/json`.

All error responses are JSON: `{ "error": "<human-readable reason>" }` with an appropriate HTTP status. Some errors include a machine-readable code field: `{ "error": "QUEUE_FULL", "message": "..." }`.

---

## Endpoints

### Users

#### `GET /users` — list users

**Response 200:**
```json
{
  "users": [
    { "id": "default", "home": "/home/alice/.string/users/default", "allowedPaths": [], "createdAt": "2026-04-14T05:52:00.000Z" }
  ]
}
```

#### `POST /users` — register or update a user

**Request:**
```json
{ "id": "default", "home": "/home/alice/.string/users/default" }
```

Both fields are required. `home` must be an absolute path. Registration is idempotent: if `id` already exists, the call updates `home` and preserves `createdAt`.

**Response 200:**
```json
{ "user_id": "default", "home": "/home/alice/.string/users/default", "created": true }
```

`created: true` if the user was newly registered, `false` if the call updated an existing user.

**Errors:**
- `400 { "error": "id required" }`
- `400 { "error": "home required" }`

#### `DELETE /users/:user_id` — delete a user

Removes the user record and any in-memory runtime state (sessions, bash PTYs). Does not delete files in the user's home directory.

**Response 200:**
```json
{ "user_id": "default", "deleted": true }
```

`deleted: false` if the user did not exist.

---

### Sessions (topics)

#### `GET /sessions?user_id=<id>` — list active sessions

The `user_id` query parameter is optional. If omitted, returns sessions across all users.

**Response 200:**
```json
{
  "sessions": [
    {
      "user_id": "default",
      "topic": "main",
      "topic_type": "tab",
      "executing": false,
      "queue_length": 0,
      "doc": {
        "uri": "file:///home/alice/work/index.md",
        "title": "Home",
        "current_block": null
      }
    }
  ]
}
```

The `doc` field is `null` if no document has been opened in the session yet.

#### `POST /sessions` — create or touch a session

Ensures a session exists for the given user+topic. Does not execute any command — the session starts empty and waits for the first `/exec` call.

**Request:**
```json
{ "user_id": "default", "topic": "main" }
```

**Response 200:**
```json
{ "user_id": "default", "topic": "main", "topic_type": "tab", "created": true }
```

**Errors:**
- `400 { "error": "user_id required" }`
- `401 { "error": "Unknown user: <id>" }`
- `400 { "error": "Invalid topic: <raw>" }`

#### `DELETE /sessions/:user_id/:topic` — close a session

Releases the topic's runtime state and closes any bash PTY.

**Response 200:**
```json
{ "user_id": "default", "topic": "main", "deleted": true }
```

`deleted: false` if the session did not exist.

**Errors:**
- `400 { "error": "Expected /sessions/:user_id/:topic" }`

---

### Exec (the hot path)

#### `POST /exec` — execute one command in a topic

This is the primary endpoint. Clients send a command; the daemon returns an SSE stream with the result.

**Headers:**
- `X-User-Id: <user_id>` (required)
- `Content-Type: application/json` (required)
- `Accept: text/event-stream` (recommended; the daemon emits SSE regardless)

**Request body:**
```json
{
  "cmd": "/open ./README.md",
  "topic": "main",
  "request_id": "optional-client-request-id"
}
```

- `cmd` (required, non-empty): the command line. Must start with `/`.
- `topic` (required): `type:name` form. Must parse successfully.
- `request_id` (optional): opaque client-chosen string. Echoed back in the `head` event and included as a prefix in the `content` body (`re: [request_id] /cmd\n...`). Use this to correlate requests when multiple are in flight.

**Response (success path):** HTTP 200 with headers:

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

Body: three SSE events in order.

##### Event 1: `head`

Metadata about the command result. Always sent first.

```
event: head
data: {"ok":true,"code":null,"cmd":"/open ./README.md","request_id":null,"user_id":"default","topic": "main","topic_type": "tab","meta":{"uri":"file:///home/alice/work/README.md","title":"README","current_block":null}}
```

Fields:
- `ok` (boolean): whether the command succeeded.
- `code` (string | null): command result code. `null` on success, a short error code like `"NOT_FOUND"` or `"INTERNAL_ERROR"` on failure.
- `cmd` (string): the command as received, possibly truncated for display. Do not use this for re-execution.
- `request_id` (string | null): echo of the client's `request_id`, or `null`.
- `user_id` (string): the user the command ran as.
- `topic` (string): the topic, canonicalized.
- `topic_type` (string): one of `"tab"`, `"app"`, `"bash"`, `"hub"`.
- `meta` (object | null): current document metadata after the command, or `null` if no document is loaded.
  - `uri` (string): absolute URI of the current document.
  - `title` (string | null): document title from frontmatter.
  - `current_block` (string | null): current block anchor, e.g. `"#welcome"`.

##### Event 2: `content`

The actual output of the command. Always sent second.

```
event: content
data: "re: /open ./README.md\n# Hello\nContent of the document..."
```

The data field is a JSON-encoded string (note the quotes — SSE `data:` lines are JSON, not raw).

**Content body format:**

```
re: [optional-request-id] /cmd
<body>
```

Or on error:

```
re: [optional-request-id] /cmd
ERROR(CODE): <error message>
```

Clients should strip the first line (`re: ...`) to get the raw output. The reference `@string-os/client` exposes a helper `stripContentPrefix(raw)` for this.

##### Event 3: `done`

Signals stream completion. Always sent last.

```
event: done
data: {}
```

After `done`, the daemon calls `res.end()` and closes the stream. Clients should treat the absence of `done` (e.g. connection drop) as an incomplete result.

##### Queueing and contention

A topic processes one command at a time. If a second command arrives while the first is executing, it is queued (up to `MAX_QUEUE_SIZE = 16`). If the queue is full, the new request returns immediately:

**Error 429:**
```json
{ "error": "QUEUE_FULL", "message": "Topic default:main has 16 commands queued. Try again later." }
```

If a queued request waits longer than `QUEUE_WAIT_TIMEOUT_MS = 60000` (1 minute), it times out:

**Error 504:**
```json
{ "error": "QUEUE_TIMEOUT", "message": "Timed out waiting in queue." }
```

If the client disconnects while waiting in the queue, the request is aborted silently (no response).

##### Other errors

- `400 { "error": "X-User-Id header required" }` — missing header
- `401 { "error": "Unknown user: <id>" }` — user not registered
- `400 { "error": "Invalid JSON body — expected { \"cmd\": \"...\" }" }` — malformed JSON
- `400 { "error": "Empty command — provide non-empty \"cmd\" field" }` — missing `cmd`
- `400 { "error": "Invalid topic: <raw>" }` — topic did not parse

---

### MCP

#### `POST /mcp` · `GET /mcp` · `DELETE /mcp` — Model Context Protocol endpoint

Serves the [Model Context Protocol](https://modelcontextprotocol.io) over the Streamable HTTP transport. One tool — `string({ topic, cmd })` — wraps the entire command surface (same as `/exec`).

**Headers:**
- `X-User-Id: <user_id>` (optional, defaults to `"default"`)
- `Content-Type: application/json` for POST
- `Accept: application/json, text/event-stream` (recommended)

**Body:** JSON-RPC 2.0 messages (`initialize`, `tools/list`, `tools/call`, etc.). See the [MCP spec](https://modelcontextprotocol.io/specification) for the wire format.

**Tool output (`tools/call` for `string`):**

```json
{
  "content": [{ "type": "text", "text": "<𝒞=string:TOPIC>\n<body>\n</𝒞>" }],
  "isError": false
}
```

The body is wrapped in a **ChanFlow envelope** identical to the CLI's stdout — the topic lives in the opening tag, so no separate `structuredContent` field is needed. On error, `isError` is `true` and the body carries the code as `ERROR(CODE): <message>` (e.g. `ERROR(NOT_FOUND): …`).

Unknown users are **auto-registered** on first touch — no `POST /users` needed. Home is derived as `~/.string/users/{user_id}`. This is unique to `/mcp` (the `/exec` endpoint still requires explicit registration via `POST /users`).

Stateless mode: a fresh server+transport per request, no session IDs. Concurrent calls on the same topic from a single user are serialized with a `BUSY` rejection (no queue at v0.1).

See [Runtime → MCP](../runtime/mcp.md) for client setup examples.

---

### Lifecycle

#### `GET /health` — daemon health and stats

**Response 200:**
```json
{ "ok": true, "users": 1, "sessions": 3 }
```

No auth required. Clients use this as a liveness check before sending a command. `sessions` counts active topics across all users.

#### `POST /shutdown` — request daemon shutdown

Sends a final JSON response, then exits the process after a 50 ms grace period.

**Response 200:**
```json
{ "ok": true, "message": "stringd shutting down" }
```

No auth required. Clients are responsible for deciding whether shutdown is appropriate (stringd is typically user-scoped, but a hostile client on loopback can call this).

---

## Client implementation checklist

A conforming v0.1 client SHOULD:

1. **Ping the daemon** via `GET /health` before the first `/exec` call. Auto-start the daemon if unreachable (out of scope for this document — each language has its own spawn mechanism).
2. **Ensure the user** exists via `POST /users` before the first `/exec` call. Registration is idempotent — calling it on every client startup is fine.
3. **Accept `text/event-stream`** on `/exec` requests, parse the three SSE events, and return a structured result:
   ```
   { ok: boolean, code: string | null, content: string, meta: object | null }
   ```
4. **Strip the `re: [request_id] /cmd\n` prefix** from the `content` event data before returning it to the caller.
5. **Handle SSE parse failures gracefully** — if `head` arrives but `content` or `done` does not, return a synthetic `{ ok: false, code: "STREAM_INCOMPLETE" }`.
6. **Surface 429/504 queue errors** as distinct from generic failures so the caller can retry with backoff.
7. **NOT retry `/exec` calls automatically** — commands can have side effects. Retries are the caller's decision.

A conforming client MAY:

- Cache the daemon port after the first `ping`.
- Expose `shutdown()` and `health()` as public methods.
- Spawn a daemon subprocess when `ping()` fails on loopback.
- Reuse an HTTP keep-alive connection across commands (the daemon supports it).

A conforming client MUST NOT:

- Send `/exec` calls without an `X-User-Id` header.
- Interpret the SSE `data:` field as raw bytes — it is always a JSON-encoded value.
- Assume the `meta` field in the `head` event is non-null.
- Assume commands are synchronous from the daemon's perspective — always wait for the `done` event.

---

## Reference implementations

- **TypeScript:** [`@string-os/client`](https://github.com/string-os/string/tree/main/packages/client) — 185 lines, uses only Node.js built-in `http`.
- **Python:** [`string-os`](https://github.com/string-os/string-py) — planned for v0.1.x.

If you implement this protocol in another language, open an issue at <https://github.com/string-os/string/issues> with a link to your implementation and we will list it here.

---

## Changelog

- **v0.1.0** (2026-04-14): initial release. Endpoints: `/users` (GET/POST/DELETE), `/sessions` (GET/POST/DELETE), `/exec` (POST), `/health` (GET), `/shutdown` (POST). SSE event triple: `head`/`content`/`done`. Wire field `topic_type` (not `target_type`).
