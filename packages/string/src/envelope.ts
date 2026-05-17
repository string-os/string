/**
 * ChanFlow envelope — the canonical text framing for a String response.
 *
 * Every rendered response (CLI stdout, MCP tool result, future transports)
 * is wrapped with this envelope so the topic stays attached to the body and
 * a reader can identify which session produced which output. Keeping the
 * envelope in one place means every surface shows the exact same shape.
 *
 *   <𝒞=string:main>
 *   Session info
 *   ...
 *   </𝒞>
 */

export const CHANFLOW_OPEN = (topic: string): string => `<𝒞=string:${topic}>`;
export const CHANFLOW_CLOSE = '</𝒞>';

export function wrapEnvelope(topic: string, body: string): string {
  return `${CHANFLOW_OPEN(topic)}\n${body}\n${CHANFLOW_CLOSE}`;
}
