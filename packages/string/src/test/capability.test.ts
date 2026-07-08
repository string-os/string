/**
 * Invariant tests for capability tokens — the String System API auth model
 * (#47 items 2–3). Pure unit tests: fake clock, tmpdir persistence, no
 * daemon. The verifier is the single enforcement point for both bearer
 * tokens and presigned URLs, so every invariant here is a security property
 * of the fs verbs that will sit behind it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CapabilityStore,
  normalizeFsPath,
  pathWithinPrefix,
  type FsVerb,
} from '../capability.js';
import { assert, section } from './runner.js';

const HOUR = 60 * 60 * 1000;

function makeStore(startMs = 1_000_000): { store: CapabilityStore; clock: { ms: number }; file: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'string-capability-'));
  const file = path.join(root, 'capabilities.json');
  const clock = { ms: startMs };
  const store = new CapabilityStore({ persistPath: file, now: () => clock.ms });
  return { store, clock, file, root };
}

await section('capability — path normalization and containment', async () => {
  // Canonical form is workspace-relative without a leading slash.
  assert(normalizeFsPath('inbox/discord/f.pdf') === 'inbox/discord/f.pdf', 'plain path unchanged');
  assert(normalizeFsPath('/inbox/discord/f.pdf') === 'inbox/discord/f.pdf', 'URL leading slash stripped');
  assert(normalizeFsPath('inbox//discord/./f.pdf') === 'inbox/discord/f.pdf', 'redundant segments collapsed');
  assert(normalizeFsPath('inbox/a/../b') === 'inbox/b', 'inner .. resolved lexically');
  assert(normalizeFsPath('') === '', 'empty path = workspace root');
  assert(normalizeFsPath('/') === '', 'bare slash = workspace root');

  // Paths that can never be legal.
  assert(normalizeFsPath('..') === null, 'bare .. rejected');
  assert(normalizeFsPath('../etc/passwd') === null, 'leading .. rejected');
  assert(normalizeFsPath('inbox/../../etc') === null, 'traversal past root rejected');
  assert(normalizeFsPath('a\\b') === null, 'backslash separators rejected');
  assert(normalizeFsPath('a\0b') === null, 'null byte rejected');

  // Containment is segment-wise: 'inbox-evil' is not inside 'inbox'.
  assert(pathWithinPrefix('inbox/discord/f.pdf', 'inbox/discord'), 'child within prefix');
  assert(pathWithinPrefix('inbox/discord', 'inbox/discord'), 'prefix itself within prefix');
  assert(!pathWithinPrefix('inbox/discordx/f.pdf', 'inbox/discord'), 'sibling with shared string prefix refused');
  assert(!pathWithinPrefix('inbox', 'inbox/discord'), 'parent not within child prefix');
  assert(pathWithinPrefix('anything/at/all', ''), 'empty prefix grants whole workspace');
});

await section('capability — mint validation refuses bad grants', async () => {
  const { store, root } = makeStore();
  try {
    let threw = '';
    try { store.mint({ agentId: '  ', pathPrefix: 'x', verbs: ['GET'], ttlMs: HOUR }); } catch (e) { threw = String(e); }
    assert(threw.includes('agentId'), 'blank agentId refused');

    threw = '';
    try { store.mint({ agentId: 'a', pathPrefix: '../up', verbs: ['GET'], ttlMs: HOUR }); } catch (e) { threw = String(e); }
    assert(threw.includes('pathPrefix'), 'escaping pathPrefix refused at mint');

    threw = '';
    try { store.mint({ agentId: 'a', pathPrefix: 'x', verbs: [], ttlMs: HOUR }); } catch (e) { threw = String(e); }
    assert(threw.includes('verb'), 'empty verb set refused');

    threw = '';
    try { store.mint({ agentId: 'a', pathPrefix: 'x', verbs: ['EXEC' as FsVerb], ttlMs: HOUR }); } catch (e) { threw = String(e); }
    assert(threw.includes('system plane'), 'non-data verb refused by construction (boundary rule)');

    threw = '';
    try { store.mint({ agentId: 'a', pathPrefix: 'x', verbs: ['GET'], ttlMs: 0 }); } catch (e) { threw = String(e); }
    assert(threw.includes('ttlMs'), 'non-positive ttl refused');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await section('capability — verify enforces verb, scope, expiry', async () => {
  const { store, clock, root } = makeStore();
  try {
    const cap = store.mint({
      agentId: 'tldr-discord',
      pathPrefix: 'inbox/discord',
      verbs: ['PUT', 'STAT'],
      ttlMs: HOUR,
    });
    assert(cap.tokenId.startsWith('cap_') && cap.secret.startsWith('caps_'), 'token id/secret minted');

    const ok = store.verify(cap.secret, { verb: 'PUT', path: '/inbox/discord/report.pdf' });
    assert(ok.ok && ok.path === 'inbox/discord/report.pdf', 'allowed verb+path passes, path canonicalized');

    const wrongVerb = store.verify(cap.secret, { verb: 'DELETE', path: 'inbox/discord/report.pdf' });
    assert(!wrongVerb.ok && wrongVerb.reason === 'verb_not_allowed', 'verb outside grant refused');

    const planeVerb = store.verify(cap.secret, { verb: 'EXEC', path: 'inbox/discord/report.pdf' });
    assert(!planeVerb.ok && planeVerb.reason === 'verb_not_allowed', 'non-data verb refused at verify too');

    const outside = store.verify(cap.secret, { verb: 'PUT', path: 'outbox/report.pdf' });
    assert(!outside.ok && outside.reason === 'path_outside_scope', 'path outside subtree refused');

    const sibling = store.verify(cap.secret, { verb: 'PUT', path: 'inbox/discordx/f' });
    assert(!sibling.ok && sibling.reason === 'path_outside_scope', 'string-prefix sibling refused');

    const traversal = store.verify(cap.secret, { verb: 'PUT', path: 'inbox/discord/../../../secret' });
    assert(!traversal.ok && traversal.reason === 'invalid_path', 'traversal escaping the workspace refused');

    const sneaky = store.verify(cap.secret, { verb: 'PUT', path: 'inbox/discord/../../secret' });
    assert(!sneaky.ok && sneaky.reason === 'path_outside_scope',
      'lexical .. staying inside the workspace but leaving the grant refused');

    const unknown = store.verify('caps_forged', { verb: 'PUT', path: 'inbox/discord/f' });
    assert(!unknown.ok && unknown.reason === 'unknown_token', 'unknown secret refused');

    clock.ms += HOUR + 1;
    const expired = store.verify(cap.secret, { verb: 'PUT', path: 'inbox/discord/f' });
    assert(!expired.ok && expired.reason === 'expired', 'expired token refused');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await section('capability — single-use consumed exactly once (presigned form)', async () => {
  const { store, root } = makeStore();
  try {
    const cap = store.mint({
      agentId: 'tldr-discord',
      pathPrefix: 'outbox/report.pdf',
      verbs: ['GET'],
      ttlMs: HOUR,
      singleUse: true,
    });

    // Racing consumers: exactly one may win, regardless of interleaving.
    const results = await Promise.all([
      Promise.resolve().then(() => store.verify(cap.secret, { verb: 'GET', path: 'outbox/report.pdf' })),
      Promise.resolve().then(() => store.verify(cap.secret, { verb: 'GET', path: 'outbox/report.pdf' })),
    ]);
    const wins = results.filter(r => r.ok).length;
    assert(wins === 1, `concurrent double-spend: exactly one verify passes (got ${wins})`);
    const loser = results.find(r => !r.ok)!;
    assert(!loser.ok && loser.reason === 'already_used', 'second spend reports already_used');

    // A FAILED verify must not consume the token.
    const fresh = store.mint({
      agentId: 'a', pathPrefix: 'outbox/f', verbs: ['GET'], ttlMs: HOUR, singleUse: true,
    });
    const miss = store.verify(fresh.secret, { verb: 'DELETE', path: 'outbox/f' });
    assert(!miss.ok, 'wrong-verb attempt refused');
    const spend = store.verify(fresh.secret, { verb: 'GET', path: 'outbox/f' });
    assert(spend.ok, 'failed attempt did not burn the single use');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await section('capability — revocation, per-agent revocation, listing', async () => {
  const { store, root } = makeStore();
  try {
    const a1 = store.mint({ agentId: 'atlas', pathPrefix: 'inbox', verbs: ['PUT'], ttlMs: HOUR });
    const a2 = store.mint({ agentId: 'atlas', pathPrefix: 'outbox', verbs: ['GET'], ttlMs: HOUR });
    const b1 = store.mint({ agentId: 'other', pathPrefix: '', verbs: ['STAT'], ttlMs: HOUR });

    assert(store.revoke(a1.tokenId) === true, 'revoke by public token id');
    assert(store.revoke(a1.tokenId) === false, 'second revoke is a no-op');
    const revoked = store.verify(a1.secret, { verb: 'PUT', path: 'inbox/f' });
    assert(!revoked.ok && revoked.reason === 'revoked', 'revoked token refused');
    assert(store.verify(a2.secret, { verb: 'GET', path: 'outbox/f' }).ok, 'sibling token unaffected');

    assert(store.revokeAllForAgent('atlas') === 1, 'agent-delete hook revokes remaining live tokens');
    assert(!store.verify(a2.secret, { verb: 'GET', path: 'outbox/f' }).ok, 'agent token dead after revokeAll');
    assert(store.verify(b1.secret, { verb: 'STAT', path: 'x' }).ok, 'other agent untouched');

    // list() exposes public records only — never the bearer secret.
    const listed = store.list();
    assert(listed.length === 3, 'all records listed');
    assert(listed.every(r => !('secret' in r)), 'secrets never listed back out');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await section('capability — persistence round-trip and pruning', async () => {
  const { store, clock, file, root } = makeStore();
  try {
    const live = store.mint({ agentId: 'a', pathPrefix: 'inbox', verbs: ['PUT'], ttlMs: 1000 * HOUR });
    const spent = store.mint({ agentId: 'a', pathPrefix: 'f', verbs: ['GET'], ttlMs: 100 * HOUR, singleUse: true });
    assert(store.verify(spent.secret, { verb: 'GET', path: 'f' }).ok, 'single-use spent before reload');

    // Reload from disk: live token verifies, spent token stays spent.
    const reloaded = new CapabilityStore({ persistPath: file, now: () => clock.ms });
    assert(reloaded.verify(live.secret, { verb: 'PUT', path: 'inbox/f' }).ok, 'live token survives reload');
    const stillSpent = reloaded.verify(spent.secret, { verb: 'GET', path: 'f' });
    assert(!stillSpent.ok && stillSpent.reason === 'already_used', 'consumed state survives reload');

    // Dead records are pruned 7 days after death, on the next save.
    clock.ms += 8 * 24 * HOUR;
    reloaded.mint({ agentId: 'a', pathPrefix: 'x', verbs: ['STAT'], ttlMs: HOUR });
    const afterPrune = new CapabilityStore({ persistPath: file, now: () => clock.ms });
    const gone = afterPrune.verify(spent.secret, { verb: 'GET', path: 'f' });
    assert(!gone.ok && gone.reason === 'unknown_token', 'long-dead record pruned from disk');
    assert(afterPrune.verify(live.secret, { verb: 'PUT', path: 'inbox/f' }).ok, 'live token never pruned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
