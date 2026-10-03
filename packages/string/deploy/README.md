# deploy/ — agent-box String bridge

Ops artifacts for running the **agent-box** side of the cross-machine messenger: one String bridge
that dials OUT to the hub and delivers messages into local agents through their String event
inboxes (reusing the daemon's existing `POST /webhook/<token>` path — no second write path).

| File | What it is |
| --- | --- |
| `crew-messenger-bridge.service` | A **user** systemd unit (`systemctl --user`) that runs the bridge bin. Runs as the agent-box user; no root, no inbound port. |
| `bridge.env.example` | Env template (no secrets). Copy to `~/.config/crew-messenger/bridge.env` (0600). |

The bin is `src/messenger/hub/bridge-bin.ts`. It reads the token from the 0600 file named by
`CREW_BRIDGE_TOKEN_FILE` (never logged), resolves each agent's home + webhook URL from the local
`stringd` over HTTP (`GET /agents`, `POST /agents/<id>/webhook`), and dials `CREW_BRIDGE_HUB_URL`.

## Install (do NOT enable yet)

1. `cp deploy/bridge.env.example ~/.config/crew-messenger/bridge.env` and edit it: set
   `CREW_BRIDGE_AGENTS`, the token-file path, and substitute `__HOME__`.
2. Place the capability token (minted on V1, handed to this operator) at
   `~/.config/crew-messenger/agentbox.token`, `chmod 600`.
3. `cp deploy/crew-messenger-bridge.service ~/.config/systemd/user/`, substitute `__REPO__` with
   this checkout's path, then `systemctl --user daemon-reload`.

## Start — gated

**Do not start the bridge until Leo confirms the hub is up and this PR is merged.** The first live
step is **one agent (nova)** — `CREW_BRIDGE_AGENTS=nova` — before widening to the rest of the
authorized Claude Code roster (`ada aria keel leo nova scout suri vega vera`). Starting it writes
real events into those agents' live String inboxes, so it is an explicit, supervised step.

**Claude Code agents only.** The Codex (node) sessions `atlas`, `milo`, `pike` never read-ack
String events, so delivery to them would never confirm and their mail would queue forever. They are
not in the hub roster and the bin refuses to start if any is listed in `CREW_BRIDGE_AGENTS`
(override `CREW_BRIDGE_DENY_AGENTS` only if that roster changes).

**One non-idempotent window.** The daemon assigns the event id, so the dedup entry is persisted only
after the webhook 202. A bridge crash in the gap between the daemon's append and that persist loses
the record; on restart the hub redelivers and a second event is POSTed, so the recipient sees the
message twice. This is rare (a crash in that millisecond) and accepted; closing it needs a
caller-supplied idempotency key on the webhook, out of scope here.

When cleared: `systemctl --user start crew-messenger-bridge`, watch
`journalctl --user -u crew-messenger-bridge -f`, confirm the hello + heartbeat, then send one
message to nova end-to-end before enabling (`systemctl --user enable crew-messenger-bridge`) and
widening the agent list.
