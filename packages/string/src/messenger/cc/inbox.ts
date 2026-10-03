/**
 * The port the cc-channel adapter delivers through. Delivery into a Claude Code agent is a push
 * into that agent's String event inbox; the delivered signal is the attached CC session's
 * READ-ACK of the event — never the webhook's 202 (that is transport-accepted, not received).
 *
 * Everything is keyed by the **message id** (an idempotency key the adapter owns), not by the
 * inbox's internal event id. That makes redelivery safe (the hub redelivers on reconnect, and a
 * bridge can restart) and lets the inbox report acks only for messenger messages, never for the
 * agent's unrelated inbox traffic (cron, other channels).
 *
 * In production this wraps `EventStore.append` / `POST /webhook/<token>` for the push (recording
 * `key → eventId` so a repeat push re-attaches instead of appending a duplicate) and a watch of
 * the agent's event store for acks (the `--mcp` channel auto-acks only after the
 * `notifications/claude/channel` hand-off resolves; no live session → the event stays `pending`,
 * i.e. not delivered). In tests it is in-memory. The adapter carries no daemon/HTTP dependency.
 */
export interface AgentEventInbox {
  /**
   * Idempotently push a message body under `key` (the message id). If an event for `key` already
   * exists in the inbox — the hub redelivered, or the bridge restarted — NO new event is created:
   * a still-pending event is left to be read, and an already-acked one re-reports its ack so the
   * delivered fact reaches the hub again. Exactly one inbox event per key ever reaches the agent.
   */
  push(key: string, body: string): Promise<void>;
  /**
   * Register the read-ack handler. Acks are reported by `key` (the message id), **edge-triggered**
   * (at most once per key unless a repeat push re-attaches), and only for events this inbox
   * pushed — never for the agent's unrelated inbox events. Called once by the adapter.
   */
  onAck(cb: (key: string) => void): void;
  /** Stop watching / release resources. */
  close(): void;
}
