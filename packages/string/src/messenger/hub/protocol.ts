/**
 * The crew-messenger hub <-> bridge wire protocol, VENDORED into the String bridge.
 *
 * The canonical copy lives in H1R-AI/crew-messenger `src/protocol/` (types.ts + fsm.ts +
 * version.ts). This is a faithful copy the bridge stamps so it can prove it still matches intent:
 * both sides exchange PROTOCOL_VERSION in the `hello` frame and an EXACT-match mismatch refuses
 * the connection loudly (pre-1.0 any minor may break the wire). Keep this in lockstep with the
 * canonical copy; bump together.
 */

export type AgentName = string;

export const HUMAN_IDENTITIES = ['founder', 'cso'] as const;
export type HumanIdentity = (typeof HUMAN_IDENTITIES)[number];

export function isHumanIdentity(name: string): name is HumanIdentity {
  return (HUMAN_IDENTITIES as readonly string[]).includes(name);
}

/** The full delivery FSM state set (hub-owned). A bridge may assert only `delivered`/`answered`. */
export type DeliveryState =
  | 'accepted'
  | 'dispatched'
  | 'delivered'
  | 'answered'
  | 'failed'
  | 'deadLettered'
  | 'rejected';

/** The only delivery states a BRIDGE may assert over the wire. */
export type BridgeAckState = Extract<DeliveryState, 'delivered' | 'answered'>;

/** A file reference. Files travel by link only (MVP) — a URL, never inline bytes. */
export interface AttachmentRef {
  url: string;
  name?: string;
  sizeBytes?: number;
}

/** What a bridge submits outbound on behalf of a local agent. The hub stamps the real `from`. */
export interface OutboundMessage {
  to: AgentName;
  body: string;
  clientUserMessageId?: string;
  attachments?: AttachmentRef[];
}

/** A message after the hub has stamped identity + id + timestamp and logged it. */
export interface StampedMessage extends OutboundMessage {
  id: string;
  from: AgentName | HumanIdentity;
  createdAtMs: number;
  attempts?: number;
}

/** ws envelope between a bridge and the hub. */
export type Frame =
  | { t: 'hello'; protocolVersion: string; bridgeId: string; machineId: string; token: string }
  | { t: 'helloOk'; protocolVersion: string; hubId: string }
  | { t: 'helloReject'; reason: string }
  | { t: 'send'; clientRef: string; from: AgentName; msg: OutboundMessage }
  | { t: 'sendResult'; clientRef: string; state: DeliveryState; messageId?: string; reason?: string }
  | { t: 'deliver'; msg: StampedMessage }
  | { t: 'ack'; messageId: string; state: BridgeAckState; clientUserMessageId?: string }
  | { t: 'error'; reason: string; ref?: string }
  | { t: 'heartbeat'; machineId: string; atMs: number };

export type FrameType = Frame['t'];

export function isFrame<T extends FrameType>(x: unknown, t: T): x is Extract<Frame, { t: T }> {
  return typeof x === 'object' && x !== null && (x as { t?: unknown }).t === t;
}

export const PROTOCOL_VERSION = '0.4.0';

export type VersionCheck = { ok: true } | { ok: false; reason: string };

/** Compare a peer's advertised version against this build's. Exact-match pre-1.0. */
export function checkProtocolVersion(theirs: string | undefined): VersionCheck {
  if (theirs === PROTOCOL_VERSION) return { ok: true };
  return {
    ok: false,
    reason: `protocol version mismatch: bridge speaks ${PROTOCOL_VERSION}, peer sent ${theirs || '(none)'}`,
  };
}
