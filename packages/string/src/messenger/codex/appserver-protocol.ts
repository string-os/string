/**
 * The subset of the Codex app-server JSON-RPC wire the adapter uses, transcribed from the
 * measured protocol (codex-cli 0.155.1, `codex app-server generate-ts`; transcript recorded
 * 2026-10-03). Only the frames the adapter sends or reacts to are modelled here.
 *
 * Methods the adapter MAY send: `thread/resume`, `turn/start`, `turn/interrupt`.
 * `thread/start` is listed ONLY so the name is nameable in assertions — the adapter must
 * NEVER send it; creating a thread is spawn-agent's job (a new thread is a context-less agent
 * the founder's tmux viewer cannot see).
 */

export const METHODS = {
  threadStart: 'thread/start', // adapter MUST NOT send this
  threadResume: 'thread/resume',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',
} as const;

export const NOTIFICATIONS = {
  turnStarted: 'turn/started',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  turnCompleted: 'turn/completed',
} as const;

export interface RpcRequest<P = unknown> {
  id: number;
  method: string;
  params?: P;
}

export interface RpcResponse<R = unknown> {
  id: number;
  result?: R;
  error?: { code: number; message: string };
}

export interface RpcNotification<P = unknown> {
  method: string;
  params?: P;
}

export type RpcFrame = RpcRequest | RpcResponse | RpcNotification;

export function isResponse(f: RpcFrame): f is RpcResponse {
  return typeof (f as RpcResponse).id === 'number' && !('method' in f);
}

export function isNotification(f: RpcFrame): f is RpcNotification {
  return typeof (f as RpcNotification).method === 'string' && !('id' in f);
}

export function isRequest(f: RpcFrame): f is RpcRequest {
  return typeof (f as RpcRequest).id === 'number' && 'method' in f;
}

// --- request params ---
export interface ThreadResumeParams {
  threadId: string;
}
export interface TurnStartParams {
  threadId: string;
  input: string;
  /** Echoed verbatim as the recorded userMessage item's `clientId` — our delivery observable. */
  clientUserMessageId?: string;
  /** "Ignored when this request steers an already-active turn." */
  turnTrigger?: string;
}
export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

// --- items + notification params ---
export type ItemType = 'userMessage' | 'agentMessage' | (string & {});
export interface TurnItem {
  id: string;
  type: ItemType;
  /** Present on userMessage items: echoes our clientUserMessageId. */
  clientId?: string;
  text?: string;
  threadId: string;
  turnId: string;
}
export interface TurnStartedParams {
  threadId: string;
  turnId: string;
}
export interface ItemEventParams {
  threadId: string;
  turnId: string;
  item: TurnItem;
}
export interface TurnCompletedParams {
  threadId: string;
  turnId: string;
}
