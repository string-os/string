/**
 * S2 fix: CLI argv → command-string re-encoding round-trips through the command
 * layer's tokenizer. The contract: `encodeArgForReparse` must produce a string
 * that `parsePosixFlags` re-tokenizes back to the ORIGINAL argv — so a
 * multi-word value survives instead of being re-split into stray positionals
 * ("Too many positional arguments … got N").
 */
import { encodeArgForReparse, encodeBody } from '../cli-args.js';
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

await section('encodeBody — a single quoted body token is passed VERBATIM (leading / survives)', () => {
  // Regression for the CLI COMMAND_UNSUPPORTED bug: `string <topic> '<whole /command
  // with spaces>'` arrives as ONE positional. Re-encoding it wrapped the entire
  // string — leading / included — in single quotes, so the daemon rejected it with
  // "Commands must start with /". These are the tool's OWN --help examples.
  for (const body of ['/install --app ./foo.md', '/open app:moltbook', '/act.send "hi there"', "/set $X = \"y\""]) {
    assert(encodeBody([body]) === body, `single token verbatim: ${JSON.stringify(body)}`);
    assert(encodeBody([body]).startsWith('/'), `leading / preserved so the command is detectable: ${JSON.stringify(body)}`);
  }
});

await section('encodeBody — separate tokens still round-trip (command head bare, value intact)', () => {
  // `string app:x /act.send "hi there"` — separate shell words. The /command head
  // has no whitespace so it stays bare (body starts with /), and the multi-word
  // value re-tokenizes back to ONE positional (the S2 contract, still honoured).
  const body = encodeBody(['/act.send', 'hi there']);
  assert(body.startsWith('/act.send '), `command head stays bare: ${JSON.stringify(body)}`);
  const p = parsePosixFlags(body.slice('/act.send '.length));
  assert(p!.rest.length === 1 && p!.rest[0] === 'hi there', `multiword value intact: ${JSON.stringify(p!.rest)}`);
});

await section('parsePosixFlags — a backslash escapes a following quote outside quotes', () => {
  // The fidelity bug: `\"dq\"` used to tokenize to `\dq\` (backslash kept, quotes
  // toggled away). Now the backslash escapes the quote to a literal.
  const dq = parsePosixFlags('send \\"dq\\"');            // send \"dq\"
  assert(dq!.rest.length === 2 && dq!.rest[1] === '"dq"', `\\" -> literal ": ${JSON.stringify(dq!.rest)}`);
  const sq = parsePosixFlags("send \\'sq\\'");            // send \'sq\'
  assert(sq!.rest[1] === "'sq'", `\\' -> literal ': ${JSON.stringify(sq!.rest)}`);

  // A backslash before a NON-quote stays literal — paths and regexes are untouched,
  // so the encodeArgForReparse round-trip (which relies on that) is unaffected.
  assert(parsePosixFlags('x a\\b')!.rest[1] === 'a\\b', 'backslash before a letter is literal');
  assert(parsePosixFlags('x C:\\tmp\\d')!.rest[1] === 'C:\\tmp\\d', 'windows-ish path unchanged');

  // Inside single quotes everything is literal (the escape fires only OUTSIDE
  // quotes) — this is what keeps single-quoted values byte-exact.
  assert(parsePosixFlags("x 'a\\\"b'")!.rest[1] === 'a\\"b', 'backslash literal inside single quotes');
});

await section('encodeArgForReparse — a value carrying literal backslash-quotes round-trips', () => {
  // The escape must not disturb the existing round-trip: a value with a literal
  // `\"` is wrapped in single quotes by encodeArgForReparse and comes back byte-exact.
  const value = 'has \\"quotes\\" and a\\b';   // literal: has \"quotes\" and a\b
  const p = parsePosixFlags(rejoin(['--message', value]));
  assert(p!.flags.message === value, `backslash-quote value preserved: ${JSON.stringify(p!.flags.message)}`);
});
