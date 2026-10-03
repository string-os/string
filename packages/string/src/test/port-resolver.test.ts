/**
 * Tests for resolveDaemonPort — the single source of truth for the daemon port.
 *
 * The incident this guards against (2026-10-03): the old `Number(process.env.STRING_PORT) || 3923`,
 * duplicated across the CLI, turned an INVALID STRING_PORT into the LIVE default 3923 — most sharply
 * "0", which `Number('0')` parses to the falsy `0`. A misconfigured test/child then silently wrote
 * to the live daemon. resolveDaemonPort keeps the unset→default behaviour but makes any set-but-
 * invalid value a hard error instead of a silent 3923.
 */
import { assert, section } from './runner.js';
import { resolveDaemonPort, StringPortError, DEFAULT_DAEMON_PORT } from '../config.js';

/** Resolve against an isolated env object (never process.env) so the test is hermetic. */
function resolve(stringPort: string | undefined): { port?: number; error?: string } {
  const env: NodeJS.ProcessEnv = {};
  if (stringPort !== undefined) env.STRING_PORT = stringPort;
  try {
    return { port: resolveDaemonPort(env) };
  } catch (e) {
    return { error: e instanceof StringPortError ? e.message : `WRONG ERROR TYPE: ${String(e)}` };
  }
}

await section('resolveDaemonPort — unset/empty fall back to the default (unchanged behaviour)', async () => {
  assert(resolve(undefined).port === DEFAULT_DAEMON_PORT, 'unset STRING_PORT → default 3923');
  assert(resolve('').port === DEFAULT_DAEMON_PORT, 'empty STRING_PORT → default 3923');
  assert(resolve('   ').port === DEFAULT_DAEMON_PORT, 'whitespace STRING_PORT → default 3923');
});

await section('resolveDaemonPort — valid ports pass through', async () => {
  assert(resolve('1').port === 1, 'min port 1');
  assert(resolve('3923').port === 3923, 'the default, set explicitly');
  assert(resolve('8080').port === 8080, 'a normal high port');
  assert(resolve('65535').port === 65535, 'max port 65535');
  assert(resolve(' 8080 ').port === 8080, 'surrounding whitespace tolerated');
});

await section('resolveDaemonPort — invalid values are a HARD error, never a silent 3923', async () => {
  // The crux of the incident: "0" must NOT become 3923.
  const zero = resolve('0');
  assert(zero.port === undefined && !!zero.error, '"0" throws instead of resolving');
  assert(zero.error!.includes('STRING_PORT') && zero.error!.includes('"0"'),
    'the error names STRING_PORT and the offending value');

  assert(!!resolve('abc').error, 'non-numeric throws');
  assert(!!resolve('-1').error, 'negative throws');
  assert(!!resolve('0.5').error, 'non-integer throws');
  assert(!!resolve('1.5').error, 'fractional throws');
  assert(!!resolve('65536').error, 'above the max port throws');
  assert(!!resolve('99999').error, 'well above the range throws');
  assert(!!resolve('NaN').error, 'the literal "NaN" throws');
  assert(!!resolve('   0  ').error, '"0" with whitespace still throws (not coerced to default)');
});
