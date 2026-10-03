/**
 * S5 — codex-appserver adapter. Proofs (design §4b, Leo-approved):
 *  - resumes the existing thread by id and NEVER creates one (thread/start is spawn's job);
 *  - delivered is acked on the userMessage item carrying our clientId, not on the reply;
 *  - STEER: two deliveries during an active turn join one turn, both delivered;
 *  - reconnect resumes the same thread id and sends no thread/start;
 *  - INTERRUPT is reserved for human identities (founder/cso).
 */
import { assert, section } from './runner.js';
import { CodexAppserverAdapter } from '../messenger/codex/adapter.js';
import type { DeliveryAck } from '../messenger/types.js';
import { FakeCodexAppServer } from './fake-codex-appserver.js';

const THREAD = 'thr-nova-abc123';
const tick = (n = 3): Promise<void> => new Promise((r) => setTimeout(r, n));

function setup(isHuman?: (f: string) => boolean) {
  const fake = new FakeCodexAppServer(THREAD);
  const acks: DeliveryAck[] = [];
  const adapter = new CodexAppserverAdapter({
    threadId: THREAD,
    connect: fake.connect,
    onAck: (a) => acks.push(a),
    isHuman,
  });
  return { fake, acks, adapter };
}

await section('codex adapter: resumes the existing thread, never creates one', async () => {
  const { fake, adapter } = setup();
  await adapter.start();
  assert(fake.receivedMethods.includes('thread/resume'), 'sent thread/resume on connect');
  assert(!fake.receivedMethods.includes('thread/start'), 'never sent thread/start');
  await adapter.close();
});

await section('codex adapter: delivered acked on the userMessage item (our clientId), not the reply', async () => {
  const { fake, acks, adapter } = setup();
  await adapter.start();
  await adapter.deliver({ id: 'm1', from: 'leo', to: 'nova', body: 'hello nova' });
  await tick();
  assert(acks.length === 1, 'exactly one delivered ack');
  assert(acks[0]?.messageId === 'm1' && acks[0]?.state === 'delivered', 'ack is delivered for m1');
  assert(typeof acks[0]?.turnId === 'string', 'ack carries the turnId it delivered on');
  assert(fake.turnStarts[0]?.clientUserMessageId === 'm1', 'clientUserMessageId was set to our id');

  // The agent's later reply item must NOT produce another delivery ack.
  fake.reply('hi leo, working on it');
  await tick();
  assert(acks.length === 1, 'reply item did not count as a delivery');
  await adapter.close();
});

await section('codex adapter: STEER — two deliveries during an active turn join one turn', async () => {
  const { fake, acks, adapter } = setup();
  await adapter.start();
  await adapter.deliver({ id: 'm1', from: 'leo', to: 'nova', body: 'first' }); // starts turn
  await adapter.deliver({ id: 'm2', from: 'milo', to: 'nova', body: 'second' }); // steers active turn
  await tick();
  assert(fake.turnCount === 1, 'only one turn was created (second steered, not a new turn)');
  assert(acks.length === 2, 'both messages delivered');
  assert(acks[0]?.turnId === acks[1]?.turnId, 'both delivered on the same turn');
  await adapter.close();
});

await section('codex adapter: reconnect resumes the same thread id, sends no thread/start', async () => {
  const { fake, acks, adapter } = setup();
  await adapter.start();
  await adapter.deliver({ id: 'm1', from: 'leo', to: 'nova', body: 'before drop' });
  await tick();

  fake.dropConnection();
  await tick(); // let the adapter observe the close and begin resuming

  await adapter.deliver({ id: 'm2', from: 'leo', to: 'nova', body: 'after reconnect' });
  await tick();

  const resumes = fake.receivedMethods.filter((m) => m === 'thread/resume').length;
  assert(resumes === 2, 'resumed the thread again on reconnect (initial + reconnect)');
  assert(!fake.receivedMethods.includes('thread/start'), 'never sent thread/start across reconnect');
  const lastTurnStart = fake.turnStarts[fake.turnStarts.length - 1];
  assert(lastTurnStart?.threadId === THREAD, 'post-reconnect turn/start carries the original thread id');
  assert(acks.some((a) => a.messageId === 'm2' && a.state === 'delivered'), 'm2 delivered after reconnect');
  await adapter.close();
});

await section('codex adapter: INTERRUPT reserved for human identities (founder/cso)', async () => {
  // A founder message with mode:interrupt pre-empts the active turn.
  const human = setup((f) => f === 'founder' || f === 'cso');
  await human.adapter.start();
  await human.adapter.deliver({ id: 'm1', from: 'leo', to: 'nova', body: 'long task' }); // active turn
  await human.adapter.deliver({ id: 'm2', from: 'founder', to: 'nova', body: 'stop now' }, { mode: 'interrupt' });
  await tick();
  assert(human.fake.receivedMethods.includes('turn/interrupt'), 'founder interrupt sent turn/interrupt');
  assert(human.acks.some((a) => a.messageId === 'm2'), 'founder message still delivered');
  await human.adapter.close();

  // A non-human interrupt falls back to steer — no turn/interrupt.
  const agent = setup((f) => f === 'founder' || f === 'cso');
  await agent.adapter.start();
  await agent.adapter.deliver({ id: 'm1', from: 'leo', to: 'nova', body: 'long task' });
  await agent.adapter.deliver({ id: 'm2', from: 'milo', to: 'nova', body: 'me too' }, { mode: 'interrupt' });
  await tick();
  assert(!agent.fake.receivedMethods.includes('turn/interrupt'), 'non-human interrupt did NOT pre-empt');
  assert(agent.acks.some((a) => a.messageId === 'm2'), 'non-human message delivered via steer');
  await agent.adapter.close();
});
