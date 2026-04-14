/**
 * Client tests: SSE parsing, stripContentPrefix, sseToExecResult, ping
 */
import { parseSSE, stripContentPrefix, sseToExecResult, ping } from '@string-os/client';
import { assert, section } from './runner.js';

await section('client — stripContentPrefix', async () => {
  assert(
    stripContentPrefix('re: /act.search\nactual content') === 'actual content',
    'strips re: prefix',
  );
  assert(
    stripContentPrefix('re: [req1] /act.search\nactual content') === 'actual content',
    'strips re: prefix with request_id',
  );
  assert(
    stripContentPrefix('no prefix here') === 'no prefix here',
    'passes through non-prefixed content',
  );
  assert(
    stripContentPrefix('re: /act.search') === '',
    'returns empty when no newline after prefix',
  );
  assert(
    stripContentPrefix('re: /cmd\nline1\nline2') === 'line1\nline2',
    'preserves multiline content after prefix',
  );
});

await section('client — parseSSE', async () => {
  const raw = [
    'event: head',
    'data: {"ok":true,"code":null}',
    '',
    'event: content',
    'data: "re: /act.search\\nHello World"',
    '',
    'event: done',
    'data: {}',
    '',
  ].join('\n');

  const events = parseSSE(raw);
  assert(events.length === 3, 'parses 3 events');
  assert(events[0].event === 'head', 'first event is head');
  assert(events[1].event === 'content', 'second event is content');
  assert(events[2].event === 'done', 'third event is done');
});

await section('client — sseToExecResult', async () => {
  const raw = [
    'event: head',
    'data: {"ok":true,"code":null,"meta":{"uri":"test.md","title":"Test"}}',
    '',
    'event: content',
    `data: ${JSON.stringify('re: /act.search\n## Seoul\n- Temperature: 18°C')}`,
    '',
    'event: done',
    'data: {}',
    '',
  ].join('\n');

  const result = sseToExecResult(raw);
  assert(result.ok === true, 'ok is true');
  assert(result.code === null, 'code is null');
  assert(result.content === '## Seoul\n- Temperature: 18°C', 'content prefix stripped');
  assert((result.meta as any)?.title === 'Test', 'meta parsed');
});

await section('client — sseToExecResult error', async () => {
  const raw = [
    'event: head',
    'data: {"ok":false,"code":"NOT_FOUND","meta":null}',
    '',
    'event: content',
    `data: ${JSON.stringify('re: /open missing.md\nERROR(NOT_FOUND): File not found')}`,
    '',
    'event: done',
    'data: {}',
    '',
  ].join('\n');

  const result = sseToExecResult(raw);
  assert(result.ok === false, 'ok is false');
  assert(result.code === 'NOT_FOUND', 'code is NOT_FOUND');
  assert(result.content.includes('ERROR(NOT_FOUND)'), 'error content preserved');
});

await section('client — ping false on closed port', async () => {
  // Port 19999 should not be in use
  const alive = await ping(19999);
  assert(alive === false, 'ping returns false for closed port');
});
