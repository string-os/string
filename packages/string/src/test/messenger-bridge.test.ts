/**
 * S4b — the hub bridge (agent-box side). Proofs:
 *  - versioned hello handshake; helloOk resolves start, helloReject is fatal (no retry);
 *  - a `deliver` routes to the recipient's adapter and the adapter's delivered ack is relayed;
 *  - human sender => interrupt mode, agent sender => steer;
 *  - redelivery is idempotent — not dispatched twice, and a missed ack is re-asserted;
 *  - an unknown recipient yields an error frame, never a crash;
 *  - outbound send correlates its sendResult;
 *  - a dropped connection reconnects + re-hellos and keeps delivering;
 *  - acks produced while disconnected are flushed on reconnect.
 */
import { assert, section } from './runner.js';
import { Bridge } from '../messenger/hub/bridge.js';
import { FakeHub, FakeInboundAdapter, stamped } from './fake-hub.js';

const tick = (n = 5): Promise<void> => new Promise((r) => setTimeout(r, n));

function setup(opts?: { baseBackoffMs?: number }) {
  const hub = new FakeHub();
  const errors: string[] = [];
  const bridge = new Bridge({
    bridgeId: 'bridge-agentbox',
    machineId: 'agentbox',
    token: 'tok-fake-nova-0000', // obviously-fake fixture
    connect: hub.connect,
    baseBackoffMs: opts?.baseBackoffMs ?? 2,
    maxBackoffMs: 8,
    onError: (r) => errors.push(r),
  });
  const adapter = new FakeInboundAdapter((a) => bridge.reportAck(a));
  bridge.register('nova', adapter);
  return { hub, bridge, adapter, errors };
}

await section('bridge: versioned hello handshake resolves start', async () => {
  const { hub, bridge } = setup();
  await bridge.start();
  assert(hub.hellos.length === 1, 'sent exactly one hello');
  assert(hub.hellos[0]?.token === 'tok-fake-nova-0000', 'hello carried the capability token');
  assert(hub.hellos[0]?.protocolVersion === '0.4.0', 'hello carried protocol 0.4.0');
  await bridge.close();
});

await section('bridge: deliver routes to the recipient adapter and relays the delivered ack', async () => {
  const { hub, bridge, adapter } = setup();
  await bridge.start();
  hub.deliver(stamped('m1', 'leo', 'nova', 'do the thing'));
  await tick();
  assert(adapter.delivered.length === 1 && adapter.delivered[0]?.id === 'm1', 'adapter got the message');
  assert(adapter.delivered[0]?.body === 'do the thing', 'body passed through');
  assert(hub.acks.some((a) => a.messageId === 'm1' && a.state === 'delivered'), 'delivered ack relayed to hub');
  await bridge.close();
});

await section('bridge: human sender gets interrupt mode, agent sender gets steer', async () => {
  const { hub, bridge, adapter } = setup();
  await bridge.start();
  hub.deliver(stamped('m1', 'leo', 'nova', 'agent msg'));
  hub.deliver(stamped('m2', 'founder', 'nova', 'human msg'));
  await tick();
  assert(adapter.modes[0] === 'steer', 'agent sender => steer');
  assert(adapter.modes[1] === 'interrupt', 'founder (human) => interrupt');
  await bridge.close();
});

await section('bridge: redelivery is idempotent — no second dispatch, ack re-asserted', async () => {
  const { hub, bridge, adapter } = setup();
  await bridge.start();
  hub.deliver(stamped('m1', 'leo', 'nova', 'once'));
  await tick();
  assert(adapter.delivered.length === 1, 'dispatched once');
  assert(hub.acks.filter((a) => a.messageId === 'm1').length === 1, 'acked once');

  hub.deliver(stamped('m1', 'leo', 'nova', 'once')); // hub redelivered (missed our ack)
  await tick();
  assert(adapter.delivered.length === 1, 'NOT dispatched a second time');
  assert(hub.acks.filter((a) => a.messageId === 'm1').length === 2, 're-asserted the delivered ack');
  await bridge.close();
});

await section('bridge: unknown recipient yields an error frame, not a crash', async () => {
  const { hub, bridge, adapter } = setup();
  await bridge.start();
  hub.deliver(stamped('m9', 'leo', 'ghost', 'nobody home'));
  await tick();
  assert(adapter.delivered.length === 0, 'nothing delivered to the registered adapter');
  assert(hub.errors.some((e) => e.ref === 'm9' && /no adapter/.test(e.reason)), 'hub told: no adapter for recipient');
  await bridge.close();
});

await section('bridge: outbound send correlates its sendResult', async () => {
  const { hub, bridge } = setup();
  await bridge.start();
  const outcome = await bridge.send('nova', { to: 'leo', body: 'reporting in' });
  assert(outcome.state === 'accepted' && typeof outcome.messageId === 'string', 'got the hub-assigned result');
  assert(hub.sends.some((s) => s.from === 'nova' && s.to === 'leo' && s.body === 'reporting in'), 'hub saw the send');
  await bridge.close();
});

await section('bridge: a dropped connection reconnects, re-hellos, and keeps delivering', async () => {
  const { hub, bridge, adapter } = setup();
  await bridge.start();
  hub.drop();
  await tick(20); // let the backoff reconnect + re-hello
  hub.deliver(stamped('m1', 'leo', 'nova', 'after reconnect'));
  await tick();
  assert(hub.hellos.length >= 2, 're-hello after reconnect');
  assert(adapter.delivered.some((m) => m.id === 'm1'), 'delivered after reconnect');
  await bridge.close();
});

await section('bridge: helloReject is fatal — start rejects and there is no retry', async () => {
  const { hub, bridge, errors } = setup();
  hub.rejectHello = 'unknown token';
  let threw = false;
  try {
    await bridge.start();
  } catch (e) {
    threw = true;
    assert(/unknown token/.test((e as Error).message), 'start rejected with the hub reason');
  }
  assert(threw, 'start did not silently succeed on a refused hello');
  await tick(20);
  assert(hub.hellos.length === 1, 'did not retry a refused hello');
  assert(errors.some((r) => /unknown token/.test(r)), 'surfaced the refusal via onError');
  await bridge.close();
});

await section('bridge: acks produced while disconnected are flushed on reconnect', async () => {
  const { hub, bridge, adapter } = setup();
  adapter.autoDeliver = false; // ack by hand
  await bridge.start();
  hub.deliver(stamped('m1', 'leo', 'nova', 'slow handling'));
  await tick();
  assert(hub.acks.length === 0, 'not acked yet (session still handling)');

  hub.drop();
  await tick(); // bridge observes the drop
  adapter.ack('m1'); // the read-ack lands while the bridge is reconnecting → buffered
  await tick(20); // reconnect + flush
  assert(hub.acks.some((a) => a.messageId === 'm1' && a.state === 'delivered'), 'buffered ack flushed after reconnect');
  await bridge.close();
});
