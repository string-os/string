/**
 * S4 — cc-channel adapter. Proofs (design §4a, Leo-approved; review fixes folded in):
 *  - delivered is acked on the recipient session's READ-ACK, never on the push (webhook 202);
 *  - with no session attached the message stays pending — not falsely delivered (offline guard);
 *  - the ack is correlated back to the right message id;
 *  - redelivery is idempotent: a repeat deliver for the same message id creates no second inbox
 *    event, so the agent never acts twice (hub reconnect / bridge restart);
 *  - an ack for unrelated inbox traffic is ignored and never buffered;
 *  - sender attribution is visible in the delivered event.
 */
import { assert, section } from './runner.js';
import { CcChannelAdapter } from '../messenger/cc/adapter.js';
import type { DeliveryAck } from '../messenger/types.js';
import { FakeAgentInbox } from './fake-cc-inbox.js';

const tick = (n = 3): Promise<void> => new Promise((r) => setTimeout(r, n));

await section('cc adapter: delivered fires on the read-ack, not on the push', async () => {
  // autoAck:false — the session is attached but acks are driven by hand, so push and read-ack
  // are separable: pushing must NOT deliver; only the read-ack does.
  const inbox = new FakeAgentInbox({ autoAck: false });
  const acks: DeliveryAck[] = [];
  const adapter = new CcChannelAdapter({ inbox, onAck: (a) => acks.push(a) });
  await adapter.start();
  await adapter.deliver({ id: 'm1', from: 'leo', to: 'nova', body: 'hello' });
  await tick();
  assert(inbox.pushed.length === 1, 'the message was pushed as one inbox event');
  assert(acks.length === 0, 'push returning (202) is not receipt — no delivered yet');

  inbox.readAck('m1'); // the session reads + acks the event
  await tick();
  assert(acks.length === 1 && acks[0]?.messageId === 'm1' && acks[0]?.state === 'delivered', 'delivered on read-ack');
  await adapter.close();
});

await section('cc adapter: offline guard — no attached session means not delivered', async () => {
  const inbox = new FakeAgentInbox();
  const acks: DeliveryAck[] = [];
  const adapter = new CcChannelAdapter({ inbox, onAck: (a) => acks.push(a) });
  await adapter.start(); // no session attached
  await adapter.deliver({ id: 'm1', from: 'leo', to: 'nova', body: 'anyone home?' });
  await tick();
  assert(acks.length === 0, 'message not delivered while offline');
  assert(inbox.pendingKeys().includes('m1'), 'the event stays pending in the inbox (queued)');

  inbox.attach(); // session attaches and drains the backlog
  await tick();
  assert(acks.some((a) => a.messageId === 'm1' && a.state === 'delivered'), 'delivered once a session attaches');
  await adapter.close();
});

await section('cc adapter: each read-ack is correlated to the right message', async () => {
  const inbox = new FakeAgentInbox();
  const acks: DeliveryAck[] = [];
  const adapter = new CcChannelAdapter({ inbox, onAck: (a) => acks.push(a) });
  inbox.attach();
  await adapter.start();
  await adapter.deliver({ id: 'm1', from: 'leo', to: 'nova', body: 'first' });
  await adapter.deliver({ id: 'm2', from: 'milo', to: 'nova', body: 'second' });
  await tick();
  const ids = acks.map((a) => a.messageId).sort();
  assert(ids.length === 2 && ids[0] === 'm1' && ids[1] === 'm2', 'both messages delivered, correct ids');
  await adapter.close();
});

await section('cc adapter: redelivery is idempotent — the agent never sees a message twice', async () => {
  // Deliver, let the session read it, then the hub redelivers the SAME message id (reconnect) or
  // the bridge restarts and re-delivers. No second inbox event may be created.
  const inbox = new FakeAgentInbox();
  const acks: DeliveryAck[] = [];
  const adapter = new CcChannelAdapter({ inbox, onAck: (a) => acks.push(a) });
  inbox.attach();
  await adapter.start();
  await adapter.deliver({ id: 'm1', from: 'leo', to: 'nova', body: 'do the thing' });
  await tick();
  assert(acks.length === 1, 'delivered once');

  // Redelivery of the same message id.
  await adapter.deliver({ id: 'm1', from: 'leo', to: 'nova', body: 'do the thing' });
  await tick();
  assert(inbox.pushed.length === 1, 'no duplicate inbox event — the agent is not shown it twice');
  // Re-attaching to an already-delivered message re-reports the ack (so the hub re-learns it).
  assert(acks.every((a) => a.messageId === 'm1'), 'the re-reported ack is still for the same message');
  await adapter.close();
});

await section('cc adapter: an ack for unrelated inbox traffic is ignored (not buffered)', async () => {
  const inbox = new FakeAgentInbox({ autoAck: false });
  const acks: DeliveryAck[] = [];
  const adapter = new CcChannelAdapter({ inbox, onAck: (a) => acks.push(a) });
  await adapter.start();
  // The session reads a cron event and some other channel's event — keys we never pushed.
  inbox.emitForeignAck('evt-cron-nightly');
  inbox.emitForeignAck('evt-other-channel');
  await tick();
  assert(acks.length === 0, 'foreign acks produce no delivered and are not retained');

  // A real message still delivers normally afterwards.
  await adapter.deliver({ id: 'm1', from: 'leo', to: 'nova', body: 'real one' });
  inbox.readAck('m1');
  await tick();
  assert(acks.length === 1 && acks[0]?.messageId === 'm1', 'only the real message delivered');
  await adapter.close();
});

await section('cc adapter: sender attribution is visible in the delivered event', async () => {
  const inbox = new FakeAgentInbox();
  const acks: DeliveryAck[] = [];
  const adapter = new CcChannelAdapter({ inbox, onAck: (a) => acks.push(a) });
  await adapter.start();
  await adapter.deliver({ id: 'm1', from: 'founder', to: 'nova', body: 'ship it' });
  assert(/\[from founder\]/.test(inbox.pushed[0]?.body ?? ''), 'event body names the sender');
  assert(/ship it/.test(inbox.pushed[0]?.body ?? ''), 'event body carries the message verbatim');
  await adapter.close();
});
