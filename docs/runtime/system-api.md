---
title: System API
---

String is both a channel the agent uses and the OS that trusted *system
components* (channel servers, runtime hosts) use at code level. Those two
surfaces share one capability model:

- **Channel plane (deliberate)** — the agent drives String through the shell
  (`/act`, `/open`). Costs turns; carries judgment.
- **System plane (reflex)** — the **String System API**: programmatic calls by
  trusted components with no agent turn. The shell is sugar over these
  syscalls, never a parallel system.

**Boundary rule: system components may move data; only the agent may act.**
The system plane's verb universe is `PUT / GET / DELETE / STAT` — there are no
execution verbs on this plane, and both the token minter and the request
verifier refuse anything else by construction.

---

## fs verbs

```
PUT    /fs/{workspace-path}     write bytes   (201 created / 200 overwritten)
GET    /fs/{workspace-path}     read bytes    (raw octet-stream)
DELETE /fs/{workspace-path}     remove        (idempotent: 200 + existed flag)
HEAD   /fs/{workspace-path}     STAT          (S3-style: size/mtime in headers)
```

Paths are **workspace-relative**; the capability token carries the workspace
root (an agent id), so the same URI shape works for any workspace the caller
holds a grant into. `STAT` maps to HTTP `HEAD`: `200` = exists, `404` =
missing, `Content-Length`/`Last-Modified` carry size and mtime, and refusals
are status-only (HEAD carries no body).

Every request must present a capability:

```
Authorization: Bearer <secret>        # normal form
GET /fs/outbox/report.pdf?cap=<secret> # presigned form (query param)
```

Status semantics:

| Status | Meaning |
|---|---|
| 401 | dead token: unknown, expired, revoked, or already-used single-use |
| 403 | live token, refused request: verb outside grant, path outside subtree, or symlink on the path |
| 400 | path can never be legal (escapes the workspace) |
| 404 | file not found (GET/HEAD) |
| 405 | non-data method — execution never appears on this plane |
| 409 | path is a directory, or a file blocks a parent segment |
| 413 | body exceeds `fs.max_bytes` (advertised in `/describe`) |

Containment is layered: the verifier rejects lexical escapes (`..`,
backslashes, sibling-prefix tricks), and the fs resolver refuses **symlinks
anywhere along the path** — the system plane never follows a link, so it can
never follow one out of a workspace.

## Capability tokens

A capability is identity + scope in one value:

```json
{
  "agent_id": "eve",              // workspace root
  "path_prefix": "inbox/discord", // subtree; "" = whole workspace
  "verbs": ["PUT", "STAT"],
  "ttl_ms": 3600000,
  "single_use": false             // true = presigned, consumed by first success
}
```

Tokens are opaque and stored daemon-side: revocation is immediate, single-use
consumption is atomic (two racing requests can never both pass), and deleting
an agent revokes every capability into its workspace. The **secret appears
exactly once** — in the mint response. Listing shows public records only.

### Minting

Components receive their capability at **pairing** (agent/webhook
provisioning), and the agent can mint ad-hoc grants from the shell — both go
through the same daemon route:

```
POST   /capabilities              mint  → { token_id, secret, ... }  (201)
GET    /capabilities[?agent_id=]  list  (public records, no secrets)
DELETE /capabilities/{token_id}   revoke
```

Shell form:

```
string agent capability mint --path inbox/discord --verbs put,stat --ttl 1h
string agent capability list
string agent capability revoke cap_abc123
```

## Worked example — outbound attachment (TLDR flow)

The agent has prepared `outbox/report.pdf` in its workspace and wants a
Discord channel server to deliver it. Bytes never pass through the agent
core; a reference + a narrow grant do.

1. **Mint a single-use read capability for exactly that file** (shell,
   agent-driven):

   ```
   string agent capability mint --path outbox/report.pdf --verbs get --ttl 15m --single-use
   ```

   The response shows the secret once:

   ```
   Minted capability cap_kJ2m9xQw into workspace 'eve':
     scope:   outbox/report.pdf [GET]
     expires: 2026-07-08T09:15:00.000Z   single-use
     secret: caps_EXAMPLE-NOT-A-REAL-SECRET
   ```

2. **Hand the channel server the String URI + capability** in the deliver
   intent (RCP): `string://outbox/report.pdf` + the secret.

3. **The channel server fetches the bytes with one syscall** — no agent turn:

   ```bash
   curl -H 'Authorization: Bearer caps_EXAMPLE-NOT-A-REAL-SECRET' \
        http://127.0.0.1:3923/fs/outbox/report.pdf > report.pdf
   ```

   …and uploads them to its platform. The capability is now consumed: a
   replay gets `401`, and after the TTL it would have expired anyway. The
   inbound direction is symmetric: the channel server holds a standing
   `PUT/STAT` grant on `inbox/<channel>/` from pairing, writes the file, and
   sends the agent a String-URI reference.

## Self-describe

`GET /describe` is the handshake: never assume a daemon's surface from its
port. Key off `capabilities` (presence = supported; `fs.max_bytes` and other
limits are advertised, never hardcoded) and refuse daemons whose
self-declared `instance.role` you don't recognize.
