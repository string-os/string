---
title: Events and Local Webhooks
---

String events are an agent-local text inbox. A local process can POST text to
an agent's webhook URL; String stores it as a pending event. The agent reads
the event through CLI, MCP, or SDK and decides what to do.

String does not execute webhook payloads. A webhook creates a message, not a
command.

---

## Create a local webhook

```bash
string webhook show
```

This prints the current agent's local URL:

```text
http://127.0.0.1:3923/webhook/wh_...
```

The token is stored in the agent registry. Rotate it with:

```bash
string webhook rotate
```

## Send an event

```bash
curl -X POST \
  -H 'Content-Type: text/plain' \
  --data 'Run the scheduled Moltbook follow-up now.' \
  http://127.0.0.1:3923/webhook/wh_...
```

The daemon accepts text up to 64 KiB and returns:

```json
{ "ok": true, "agent_id": "default", "event_id": "evt_..." }
```

## Read events

From CLI:

```bash
string event /events
string event '/events.read evt_...'
string event '/events.ack evt_...'
```

From MCP:

```json
{ "topic": "event", "cmd": "/events" }
{ "topic": "event", "cmd": "/events.read evt_..." }
{ "topic": "event", "cmd": "/events.ack evt_..." }
```

## Claude Code channel

String can also deliver local webhook events as a Claude Code Remote Control
channel. The normal `string --mcp` server provides both the `string` MCP tool
and the channel capability, so tool calls and event push use the same agent id:

```json
{
  "mcpServers": {
    "string": {
      "command": "string",
      "args": ["--mcp", "--agent", "default"]
    }
  }
}
```

Start Claude Code with that MCP config as a development channel. You can also
load Anthropic's official Discord channel at the same time:

```bash
claude \
  --mcp-config .mcp.json \
  --channels plugin:discord@claude-plugins-official \
  --dangerously-load-development-channels server:string
```

When a local process POSTs text to the agent webhook, Claude receives it as a
channel message from `String`. The same event remains in the `event` topic so
the agent can read and acknowledge it explicitly.

If your installed Claude Code build exposes only `--remote-control` and not the
channel flags above, update Claude Code before using this integration. The
String side still uses the official MCP channel protocol.

Useful commands:

| Command | Meaning |
|---|---|
| `/events` | List pending events |
| `/events list --all` | List pending and acked events |
| `/events.read <id>` | Read the full event text |
| `/events.ack <id>` | Mark an event handled |
| `/events.clear` | Delete acked events |
| `/events.clear --all` | Delete all events |

## Security model

- The daemon still binds only to `127.0.0.1`.
- The webhook URL contains an agent-specific random token.
- Webhook bodies are stored as text and never interpreted as String commands.
- Bad tokens are rejected.
- Claude Code channel delivery is notification-only. It does not mark an event
  acknowledged; agents should still use `/events.ack <id>` when handled.
- The initial implementation is local-only; internet-facing webhooks need an
  explicit auth and relay design.
