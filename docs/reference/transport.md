---
title: Transport
---

String communicates through messages. Each message has three
core elements — regardless of how they're encoded on the wire.

---

## Core elements

Every String message consists of:

| Element | What it is |
|---------|------------|
| **Channel** | `string` — identifies this as a String message |
| **Topic** | Which session receives the message (file, web, app) |
| **Payload** | The content — a command, text, or a response |

That's the entire interface. Everything else is how these three
elements are represented in a specific transport.

---

## Topic

The topic identifies which session the message is for:

```
file:main                file topic (default)
file:docs                file topic
web:docs                 web topic
app:gmail:work           app topic
bash:dev                 bash topic
```

Topics use the `type:name` format. Bare names default to `file:`.
Empty/absent topics default to `file:main`. See [04-topics.md](./04-topics.md).

---

## Payload

The payload is what goes inside the message. It is not always
a command.

### Commands

```
/open #decisions
/act.search_city --name "Seoul"
/replace :L5-L10
New content for those lines
```

Commands start with `/`. A command must be the **first line**
of the payload, and each channel block carries exactly **one
command**. To send two commands, use two channel blocks.

Commands with content (`/replace`, `/append`, `/set`) include
the content starting from the **next line** after the command:

```
<𝒞=string:file:notes>
/replace ~/notes/meeting.md:L5
This line replaces line 5.
This is a second line.
</𝒞>
```

The command is `/replace :L5`. Everything from the next line to
`</𝒞>` is the content.

### Command-only

All payloads must start with `/`. Plain text without a command
prefix is rejected with `COMMAND_UNSUPPORTED`.

```
<𝒞=string:file:notes>
# Meeting Notes
Content goes here.
</𝒞>
```

```
✗ COMMAND_UNSUPPORTED: Commands must start with /. Use /help for details.
```

**Exception:** Bash topics (`bash:name`) accept plain text as shell
input. Every line sent to a bash topic is treated as shell stdin,
not a String command:

```
<𝒞=string:bash:dev>
echo "this goes to the shell"
</𝒞>
```

To send String commands to a bash topic, use the `//` prefix (strips
one slash):

```
<𝒞=string:bash:dev>
//info
</𝒞>
```

This sends `/info` as a String command instead of executing `//info`
in the shell. See [04-topics.md](./04-topics.md#bash) for bash
topic semantics.

Use explicit commands for all operations:

```
<𝒞=string:file:notes>
/write ~/notes/meeting.md
# Meeting Notes
Content goes here.
</𝒞>
```

### Responses

String responses are Markdown content, `✓` feedback, or
`✗` errors:

```
## Decisions
1. Move deadline to April 1
2. Switch to weekly syncs
```

```
✓ ~/notes/meeting.md#decisions — Added 2 lines
```

```
✗ NOT_FOUND: file not found
  path: ~/notes/missing.md
```

---

## ChanFlow encoding

The current transport is ChanFlow — a protocol that routes
messages between AI and multiple channels using tagged blocks.

### Format

```
<𝒞=string:topic>
payload
</𝒞>
```

The `𝒞` character identifies a ChanFlow channel tag. `string`
is the channel. Everything after `:` is the typed topic.

### AI → String

AI tags have only channel and topic — nothing else:

```
<𝒞=string:file:notes>
/open ~/notes/meeting.md#decisions
</𝒞>
```

```
<𝒞=string:app:weather:korea>
/act.search_city --name "Seoul"
</𝒞>
```

### String → AI

Response tags MAY include optional attributes:

```
<𝒞=string:file:notes time="2026-03-19T14:30+09:00">
## Decisions
1. Move deadline to April 1
2. Switch to weekly syncs
</𝒞>
```

```
<𝒞=string:file:notes time="2026-03-19T14:31+09:00" mode=edit>
✓ ~/notes/meeting.md#decisions — Added 2 lines, removed 1 line

 11  │ <!-- #decisions -->
 12  │ ## Decisions
 13 -│ (none yet)
 13 +│ 1. Move deadline to April 1
 14 +│ 2. Switch to weekly syncs
 15  │ <!-- /decisions -->
</𝒞>
```

### Response attributes

| Attribute | Description |
|-----------|-------------|
| `time` | ISO 8601 timestamp of the response |
| `mode` | Session mode when applicable (e.g. `edit`) |

Attributes are always optional. Additional attributes may be
added in the future — AI should ignore unknown attributes.

### Multiple topics

AI can address multiple topics in one turn. String responds
with separate blocks for each:

```
<𝒞=string:web:api-docs>
/open @authentication
</𝒞>

<𝒞=string:file:code>
/open ~/src/auth.md#oauth-flow
</𝒞>
```

Response:

```
<𝒞=string:web:api-docs time="2026-03-19T14:32+09:00">
# Authentication
OAuth2 is required for all API endpoints...
</𝒞>

<𝒞=string:file:code time="2026-03-19T14:32+09:00">
## OAuth Flow
1. Redirect to provider
2. Receive callback with code
</𝒞>
```

---

## String as a channel

In ChanFlow, String is one of many channels:

```
<𝒞=string:file:main>
/open ~/report.md#summary
</𝒞>

<𝒞=slack:dev-team>
Here's the Q1 summary: ...
</𝒞>

<𝒞=email:manager@company.com>
Please review the attached Q1 report.
</𝒞>
```

Each channel has its own protocol. String's:
- **Input:** commands (must start with `/`)
- **Output:** Markdown content, `✓` feedback, or `✗` errors
- **State:** per-topic sessions with variables and history

---

## Session lifecycle

### First contact

When AI sends a message to a topic for the first time, String
creates the session automatically:

```
<𝒞=string:file:project>
/open ~/new-project/index.md
</𝒞>
```

No explicit session creation needed.

### Persistence

Sessions persist across turns. Variables, history, and current
location are maintained:

```
# Turn 1
<𝒞=string:app:weather:korea>
/act.search_city --name "Seoul"
</𝒞>

# Turn 5 (later)
<𝒞=string:app:weather:korea>
/act.get_forecast --city {city}
</𝒞>
```

`{city}` was set by the response template in turn 1. It's still
available in turn 5.

### Close

```
<𝒞=string:web:research>
/close
</𝒞>
```

`/close` ends the session. State is discarded. The topic can
be reopened fresh.

---

## Summary

| Concept | Description |
|---------|-------------|
| **Core elements** | Channel (`string`) + Topic + Payload |
| **Topic** | `type:name` — typed session identifier |
| **Payload** | Command only (`/...`) — plain text rejected |
| **ChanFlow** | Current encoding: `<𝒞=string:type:name>` ... `</𝒞>` |
| **Asymmetry** | AI sends no attributes; responses may have `time`, `mode` |
| **Session** | Auto-created on first use, persists across turns |
