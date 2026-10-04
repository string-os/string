#!/usr/bin/env node
/**
 * crew-send — send ONE cross-machine message through this box's agent bridge.
 *
 *   crew-send <to> <message...>
 *
 * The sender is $STRING_AGENT_ID (this box's agent identity); crew-send refuses to run if it is
 * unset rather than guess. It POSTs to the bridge's loopback send listener
 * (http://127.0.0.1:$CREW_BRIDGE_SEND_PORT/send, default port 3941) and prints the hub's verdict.
 * The hub stamps the real sender from the bridge's capability token, so this cannot spoof another
 * agent; a rejection is reported as a failure (non-zero exit), never a fake success.
 */

const DEFAULT_SEND_PORT = 3941;

function fail(msg: string, code = 1): never {
  process.stderr.write(`crew-send: ${msg}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const from = process.env.STRING_AGENT_ID?.trim();
  if (!from) {
    fail('STRING_AGENT_ID is not set; refusing to guess the sender', 2);
  }

  const argv = process.argv.slice(2);
  if (argv.length < 2 || argv[0] === '-h' || argv[0] === '--help' || argv[0]?.startsWith('-')) {
    process.stderr.write(
      'usage: crew-send <to> <message...>\n' +
        '  from    = $STRING_AGENT_ID (required)\n' +
        '  port    = $CREW_BRIDGE_SEND_PORT (default 3941)\n',
    );
    process.exit(argv.length === 0 ? 2 : 0);
  }
  const to = argv[0]!;
  const body = argv.slice(1).join(' ');
  const port = Number(process.env.CREW_BRIDGE_SEND_PORT) || DEFAULT_SEND_PORT;
  const url = `http://127.0.0.1:${port}/send`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, body }),
    });
  } catch (err) {
    fail(
      `cannot reach the bridge at ${url} (${(err as Error).message}). Is the bridge running on this box?`,
    );
  }

  const text = await res.text();
  let parsed: { state?: string; messageId?: string; reason?: string; error?: string } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON body; fall through to the raw text below */
  }

  if (res.ok && parsed.state === 'accepted') {
    process.stdout.write(`sent ${from} -> ${to} (${parsed.messageId ?? 'accepted'})\n`);
    return;
  }

  const reason = parsed.reason ?? parsed.error ?? (text || `HTTP ${res.status}`);
  fail(`NOT sent (HTTP ${res.status}): ${reason}`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
