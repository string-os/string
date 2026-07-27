/**
 * S2 fix: CLI argv → command-string re-encoding round-trips through the command
 * layer's tokenizer. The contract: `encodeArgForReparse` must produce a string
 * that `parsePosixFlags` re-tokenizes back to the ORIGINAL argv — so a
 * multi-word value survives instead of being re-split into stray positionals
 * ("Too many positional arguments … got N").
 */
import { encodeArgForReparse } from '../cli-args.js';
import { parsePosixFlags } from '../commands/helpers.js';
import { assert, section } from './runner.js';

/** Rebuild a command string from argv exactly as cli.ts does. */
const rejoin = (argv: string[]) => argv.map(encodeArgForReparse).join(' ');

await section('encodeArgForReparse — leaves safe tokens byte-identical', () => {
  for (const t of ['/act.send', '--message', '--key=value', 'app:agent-message', 'plain', 'a-b_c.d', '-x']) {
    assert(encodeArgForReparse(t) === t, `bare token unchanged: ${t}`);
  }
});

await section('S2 — multi-word --flag value survives as ONE value (the reported failure)', () => {
  // bash argv for: /act.send --message "long sentence here"
  const argv = ['/act.send', '--message', 'long sentence here'];
  const p = parsePosixFlags(rejoin(argv));
  assert(p !== null, 'parse ok');
  assert(p!.flags.message === 'long sentence here', `--message kept whole: ${JSON.stringify(p!.flags)}`);
  // The words must NOT leak into positionals — that was the "got 74" bug.
  assert(p!.rest.length === 1 && p!.rest[0] === '/act.send',
    `no stray positionals: ${JSON.stringify(p!.rest)}`);
});

await section('S2 — --key=value with spaces is preserved', () => {
  // bash argv for: --message="long sentence here"  →  one token
  const p = parsePosixFlags(rejoin(['--message=long sentence here']));
  assert(p!.flags.message === 'long sentence here', `=value with spaces kept: ${JSON.stringify(p!.flags)}`);
});

await section('S2 — multi-word positional operand stays a single operand', () => {
  const p = parsePosixFlags(rejoin(['hello there world', 'second']));
  assert(p!.rest.length === 2, `two operands, not six: ${JSON.stringify(p!.rest)}`);
  assert(p!.rest[0] === 'hello there world' && p!.rest[1] === 'second', 'operands intact');
});

await section('S2 — apostrophes, double quotes, and mixed quotes all round-trip', () => {
  const cases = [
    "it's a test",           // single quote
    'say "hi" now',          // double quotes
    `a'b"c mix`,             // both quote types
    "trailing apostrophe '",
    "multiple '' quotes ''",
  ];
  for (const value of cases) {
    const p = parsePosixFlags(rejoin(['--message', value]));
    assert(p!.flags.message === value, `round-trip: ${JSON.stringify(value)} → ${JSON.stringify(p!.flags.message)}`);
  }
});

await section('S2 — a realistic worker dispatch brief survives intact', () => {
  const brief = 'Please build the auth module. Use JWTs, refresh tokens, and a "remember me" flag. Deadline: Friday.';
  const argv = ['/act.send', '--message', brief];
  const p = parsePosixFlags(rejoin(argv));
  assert(p!.flags.message === brief, 'long natural-language brief preserved verbatim');
  assert(p!.rest.length === 1, 'no stray positionals from the brief');
});
