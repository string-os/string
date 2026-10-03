/**
 * S4 — cc-channel adapter. Proofs (design §4a, Leo-approved):
 *  - delivered is acked on the recipient session's READ-ACK, never on the push (webhook 202);
 *  - with no session attached the message stays pending — not falsely delivered (offline guard);
 *  - the ack is correlated back to the right message id;
 *  - sender attribution is visible in the delivered event;
 *  - an unknown/duplicate ack is ignored.
 */
import { assert, section } from './runner.js';
import { CcChannelAdapter } from '../messenger/cc/adapter.js';
import type { DeliveryAck } from '../messenger/types.js';
import { FakeAgentInbox } from './fake-cc-inbox.js';

const tick = (n = 3): Promise<void> => new Promise((r) => setTimeout(r, n));

function setup() {
  const inbox = new FakeAgentInbox();
  const acks: DeliveryAck[] = [];
  const adapter = new CcChannelAdapter({ inbox, onAck: (a) => acks.push(a) });
  return { inbox, acks, adapter };
}

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

  inbox.readAck(inbox.pushed[0]?.eventId ?? ''); // the session reads + acks the event
  await tick();
  assert(acks.length === 1 && acks[0]?.messageId === 'm1' && acks[0]?.state === 'delivered', 'delivered on read-ack');
  await adapter.close();
});

await section('cc adapter: offline guard — no attached session means not delivered', async () => {
  const { inbox, acks, adapter } = setup();
  await adapter.start(); // no session attached
  await adapter.deliver({ id: 'm1', from: 'leo', to: 'nova', body: 'anyone home?' });
  await tick();
  assert(acks.length === 0, 'message not delivered while offline');
  assert(inbox.pendingCount === 1, 'the event stays pending in the inbox (queued)');

  // The session attaches and drains the backlog → now it is read-acked → delivered.
  inbox.attach();
  await tick();
  assert(acks.some((a) => a.messageId === 'm1' && a.state === 'delivered'), 'delivered once a session attaches');
  await adapter.close();
});

await section('cc adapter: each read-ack is correlated to the right message', async () => {
  const { inbox, acks, adapter } = setup();
  inbox.attach();
  await adapter.start();
  await adapter.deliver({ id: 'm1', from: 'leo', to: 'nova', body: 'first' });
  await adapter.deliver({ id: 'm2', from: 'milo', to: 'nova', body: 'second' });
  await tick();
  const ids = acks.map((a) => a.messageId).sort();
  assert(ids.length === 2 && ids[0] === 'm1' && ids[1] === 'm2', 'both messages delivered, correct ids');
  await adapter.close();
});

await section('cc adapter: sender attribution is visible in the delivered event', async () => {
  const { inbox, adapter } = setup();
  await adapter.start();
  await adapter.deliver({ id: 'm1', from: 'founder', to: 'nova', body: 'ship it' });
  assert(/\[from founder\]/.test(inbox.pushed[0]?.body ?? ''), 'event body names the sender');
  assert(/ship it/.test(inbox.pushed[0]?.body ?? ''), 'event body carries the message verbatim');
  await adapter.close();
});

await section('cc adapter: an unknown or duplicate ack is ignored', async () => {
  const { inbox, acks, adapter } = setup();
  inbox.attach();
  await adapter.start();
  await adapter.deliver({ id: 'm1', from: 'leo', to: 'nova', body: 'hi' });
  await tick();
  assert(acks.length === 1, 'delivered once');
  // Re-ack the same event id, and an id we never pushed — neither should re-fire.
  inbox.emitAck(inbox.pushed[0]?.eventId ?? '');
  inbox.emitAck('evt_fake_does_not_exist');
  await tick();
  assert(acks.length === 1, 'duplicate / unknown acks are ignored (idempotent)');
  await adapter.close();
});
