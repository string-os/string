/**
 * The port the cc-channel adapter delivers through. Delivery into a Claude Code agent is a push
 * into that agent's String event inbox; the delivered signal is the attached CC session's
 * READ-ACK of the event — never the webhook's 202 (that is transport-accepted, not received).
 *
 * In production this wraps `EventStore.append` / `POST /webhook/<token>` for the push and a watch
 * of the agent's event store for acks (the `--mcp` channel auto-acks only after the
 * `notifications/claude/channel` hand-off resolves, so an ack means the session actually took the
 * event; no live session → the event stays `pending`, i.e. not delivered). In tests it is
 * in-memory. The adapter depends only on this interface, so it carries no daemon/HTTP dependency.
 */
export interface AgentEventInbox {
  /** Push a message body as a local-webhook event; resolves with the stored event id. */
  push(body: string): Promise<string>;
  /**
   * Register the handler for read-acks — event ids the attached CC session has acked. Called
   * once by the adapter. The inbox may replay acks for events pushed while offline once a
   * session (re)attaches and drains the backlog. Acks are **edge-triggered**: each event id is
   * reported at most once (a polling implementation must dedupe), so the adapter never has to
   * guard against the same ack firing twice.
   */
  onAck(cb: (eventId: string) => void): void;
  /** Stop watching / release resources. */
  close(): void;
}
