/**
 * CLI argv → command-string re-encoding.
 *
 * bash splits argv correctly, but the `string` CLI rebuilds a single command
 * string (`positional.join(' ')`) before handing it to the command layer, which
 * re-tokenizes on whitespace (`parsePosixFlags`). Without re-quoting, a value
 * like `--message "long sentence"` collapses to `--message long sentence` and
 * the extra words are re-parsed as stray positional arguments ("Too many
 * positional arguments … got N"). This module re-encodes each argv token so the
 * round-trip through `parsePosixFlags` reproduces the ORIGINAL argv exactly.
 */

/**
 * Re-encode one argv token so `parsePosixFlags` re-tokenizes it back to exactly
 * this one token — whitespace, quotes and all.
 *
 * `parsePosixFlags`'s tokenizer has NO backslash escaping: `'` and `"` are pure
 * toggle characters that get stripped, and only UNquoted whitespace splits
 * tokens. It DOES accumulate adjacent quoted/bare runs into a single token. So
 * we encode by wrapping each run of non-`'` characters in single quotes and
 * each run of `'` in double quotes, concatenated with no separator — which the
 * tokenizer reassembles verbatim. This round-trips any string, including
 * apostrophes and mixed quote types.
 */
export function encodeArgForReparse(s: string): string {
  // A token with no whitespace and no quote characters re-tokenizes as itself,
  // so leave it bare. This keeps commands (`/act.send`), flags (`--message`,
  // `--key=value`) and topics (`app:x`) byte-identical so routing and flag
  // parsing see them exactly as before.
  if (s !== '' && !/[\s'"]/.test(s)) return s;
  if (s === '') return "''"; // best-effort; an empty operand isn't representable
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === "'") {
      let j = i;
      while (j < s.length && s[j] === "'") j++;
      out += `"${s.slice(i, j)}"`; // run of single-quotes → wrap in double quotes
      i = j;
    } else {
      let j = i;
      while (j < s.length && s[j] !== "'") j++;
      out += `'${s.slice(i, j)}'`; // run of everything else → wrap in single quotes
      i = j;
    }
  }
  return out;
}
