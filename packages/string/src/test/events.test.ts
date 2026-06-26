import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import { Browser } from '../index.js';
import { EventStore } from '../events.js';
import * as client from '@string-os/client';
import { assert, section } from './runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../cli.ts');

interface Env {
  root: string;
  dataDir: string;
  configFile: string;
  port: number;
  base: NodeJS.ProcessEnv;
}

function makeEnv(): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'string-events-'));
  const dataDir = path.join(root, 'daemon');
  const configFile = path.join(root, 'config.json');
  const port = 23000 + Math.floor(Math.random() * 9000);
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    STRING_DATA_DIR: dataDir,
    STRING_CONFIG: configFile,
    STRING_PORT: String(port),
    STRING_LOG: '0',
  };
  return { root, dataDir, configFile, port, base };
}

function runCli(
  env: Env,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('npx', ['tsx', CLI, ...args], {
    env: { ...env.base, ...extraEnv },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function startDaemon(env: Env): Promise<{ stop: () => void }> {
  const child = spawn('npx', ['tsx', CLI, '--daemon', 'foreground', String(env.port)], {
    env: env.base,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 100; i++) {
    if (await client.ping(env.port)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return {
    stop: () => { try { process.kill(-child.pid!); } catch { /* already gone */ } },
  };
}

function postText(urlString: string, text: string): Promise<{ status: number; body: string }> {
  const url = new URL(urlString);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      agent: false, // no keep-alive: avoid orphan pooled-socket resets (see client request helper)
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
      },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf-8'),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(text);
    req.end();
  });
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

await section('events — EventStore list/read/ack/clear', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'string-event-store-'));
  try {
    const store = new EventStore(home);
    const event = await store.append('agent-a', 'Hello event\nsecond line');
    assert(event.id.startsWith('evt_'), 'event id generated');

    const list = await store.list();
    assert(list.length === 1, 'pending event listed');
    assert(list[0].preview === 'Hello event', 'preview uses first line');

    const read = await store.read(event.id);
    assert(read?.text.includes('second line'), 'read returns full text');

    const ack = await store.ack(event.id);
    assert(ack?.status === 'ack', 'ack marks event handled');
    assert((await store.list()).length === 0, 'acked event hidden from pending list');
    assert((await store.list({ includeAck: true })).length === 1, 'acked event visible with includeAck');

    const cleared = await store.clear();
    assert(cleared === 1, 'clear removes acked event');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await section('events — Browser commands list/read/ack', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'string-event-browser-'));
  try {
    const event = await new EventStore(home).append('agent-b', 'Run scheduled task now.');
    const b = new Browser({ home });

    const list = await b.exec('/events');
    assert(list.ok, '/events ok');
    assert(list.content.includes(event.id), '/events lists event id');

    const read = await b.exec(`/events.read ${event.id}`);
    assert(read.ok, '/events.read ok');
    assert(read.content.includes('Run scheduled task now.'), '/events.read shows text');
    assert(read.content.includes(`/events.ack ${event.id}`), '/events.read includes ack next step');

    const ack = await b.exec(`/events.ack ${event.id}`);
    assert(ack.ok, '/events.ack ok');

    const after = await b.exec('/events');
    assert(!after.content.includes(event.id), 'acked event not in pending list');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await section('events — local webhook appends text to current agent inbox', async () => {
  const env = makeEnv();
  const daemon = await startDaemon(env);
  const home = path.join(env.root, 'agent-home');
  let channel: ReturnType<typeof spawn> | null = null;
  try {
    assert(await client.ping(env.port), 'daemon up for webhook test');

    const add = runCli(env, ['agent', 'add', 'hooked', '--home', home]);
    assert(add.code === 0, `agent add ok. stderr: ${add.stderr}`);
    const use = runCli(env, ['agent', 'use', 'hooked']);
    assert(use.code === 0, 'agent use ok');

    const show = runCli(env, ['event', 'webhook', 'show']);
    assert(show.code === 0, `webhook show ok. stderr: ${show.stderr}`);
    const webhookUrl = show.stdout.split('\n').find(line => line.startsWith('http://127.0.0.1:'));
    assert(!!webhookUrl, `webhook URL printed. stdout: ${show.stdout}`);

    const posted = await postText(webhookUrl!, 'scheduled event: check notifications');
    assert(posted.status === 202, `webhook POST accepted. got ${posted.status}: ${posted.body}`);
    const postedJson = JSON.parse(posted.body) as { event_id: string; agent_id: string };
    assert(postedJson.agent_id === 'hooked', 'webhook resolves target agent');

    const list = runCli(env, ['event', 'list']);
    assert(list.code === 0, `event list ok. stderr: ${list.stderr}`);
    assert(list.stdout.includes(postedJson.event_id), 'event list includes posted event');
    assert(list.stdout.includes('string event read <id>'), 'event list shows CLI read form');

    const read = runCli(env, ['event', 'read', postedJson.event_id]);
    assert(read.code === 0, 'event read ok');
    assert(read.stdout.includes('scheduled event: check notifications'), 'event read includes webhook text');

    const ack = runCli(env, ['event', 'ack', postedJson.event_id]);
    assert(ack.code === 0, 'event ack ok');

    const bad = await postText(`http://127.0.0.1:${env.port}/webhook/bad-token`, 'bad');
    assert(bad.status === 401, 'bad webhook token rejected');

    let watched: client.AgentEvent | null = null;
    const watcher = client.watchAgentEvents(env.port, 'hooked', event => { watched = event; });
    await wait(100);
    const streamed = await postText(webhookUrl!, 'streamed event for SDK watcher');
    assert(streamed.status === 202, 'second webhook POST accepted');
    await waitFor(() => watched?.text === 'streamed event for SDK watcher');
    watcher.close();
    assert(watched?.agentId === 'hooked', 'SDK watcher receives agent event');

    channel = spawn('npx', ['tsx', CLI, '--mcp', '--agent', 'hooked'], {
      env: env.base,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let channelOut = '';
    let channelErr = '';
    channel.stdout.setEncoding('utf-8');
    channel.stderr.setEncoding('utf-8');
    channel.stdout.on('data', chunk => { channelOut += chunk; });
    channel.stderr.on('data', chunk => { channelErr += chunk; });

    channel.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'string-test', version: '0.0.0' },
      },
    }) + '\n');
    await waitFor(() => channelOut.includes('"id":1'), 5000);
    assert(channelOut.includes('"claude/channel"'), 'combined MCP server advertises Claude channel capability');

    channel.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }) + '\n');
    await wait(150);

    channel.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }) + '\n');
    await waitFor(() => channelOut.includes('"id":2'), 5000);
    assert(channelOut.includes('"name":"string"'), 'combined MCP server still exposes string tool');

    const channelPosted = await postText(webhookUrl!, 'claude channel delivery test');
    assert(channelPosted.status === 202, 'webhook POST accepted for Claude channel');
    await waitFor(
      () => channelOut.includes('notifications/claude/channel')
        && channelOut.includes('"content":"claude channel delivery test"')
        && channelOut.includes('"source":"string"'),
      5000,
    ).catch(e => {
      throw new Error(`${e.message}. stdout: ${channelOut} stderr: ${channelErr}`);
    });
  } finally {
    channel?.kill('SIGTERM');
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await section('events — stream backfills pending events that arrived while disconnected', async () => {
  const env = makeEnv();
  const daemon = await startDaemon(env);
  const home = path.join(env.root, 'agent-home-backfill');
  let watcher: ReturnType<typeof client.watchAgentEvents> | null = null;
  try {
    assert(await client.ping(env.port), 'daemon up for backfill test');
    assert(runCli(env, ['agent', 'add', 'lonely', '--home', home]).code === 0, 'agent add ok');
    assert(runCli(env, ['agent', 'use', 'lonely']).code === 0, 'agent use ok');
    const show = runCli(env, ['event', 'webhook', 'show']);
    const webhookUrl = show.stdout.split('\n').find(line => line.startsWith('http://127.0.0.1:'));
    assert(!!webhookUrl, 'webhook URL printed');

    // Event arrives with NO stream connected → persisted as pending, delivered to nobody live.
    const posted = await postText(webhookUrl!, 'missed while offline');
    assert(posted.status === 202, 'webhook accepted while no stream connected');

    // Connect AFTER the fact: the backfill must replay the pending event on connect.
    const received: client.AgentEvent[] = [];
    watcher = client.watchAgentEvents(env.port, 'lonely', e => received.push(e));
    await waitFor(() => received.some(e => e.text === 'missed while offline'), 5000);
    assert(received.some(e => e.text === 'missed while offline'), 'backfill replayed the pending event on connect');

    // A second connect must NOT re-deliver it — still pending (unacked), but de-duped
    // within this daemon session so reconnect churn can't re-flood the agent.
    const received2: client.AgentEvent[] = [];
    const watcher2 = client.watchAgentEvents(env.port, 'lonely', e => received2.push(e));
    await wait(600);
    watcher2.close();
    assert(received2.length === 0, 'already-delivered pending event is not re-flooded on reconnect');
  } finally {
    watcher?.close();
    daemon.stop();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await section('events — watchAgentEvents self-reconnects after the stream drops', async () => {
  const PORT = 39411;
  let server: http.Server | null = null;
  const mkServer = () => new Promise<http.Server>((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/events/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: ready\ndata: {"agent_id":"t"}\n\n');
        setTimeout(() => res.write(
          `event: event\ndata: ${JSON.stringify({ id: 'e', agentId: 't', text: 'tick', source: 'test', receivedAt: 'now' })}\n\n`,
        ), 50);
      } else { res.writeHead(404); res.end(); }
    });
    s.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  const received: string[] = [];
  server = await mkServer();
  const watcher = client.watchAgentEvents(PORT, 't', e => received.push(e.text), () => {},
    { minReconnectMs: 100, maxReconnectMs: 500, idleTimeoutMs: 4000 });

  // Poll for conditions (not fixed sleeps) so the test is deterministic on slow CI.
  await waitFor(() => received.length === 1, 5000);
  assert(received.length === 1, 'received the event on first connect');

  // Simulate a daemon restart: drop the server, bring it back on the same port.
  server!.closeAllConnections?.(); await new Promise<void>(r => server!.close(() => r()));
  await wait(200);
  server = await mkServer();

  await waitFor(() => received.length >= 2, 8000);
  assert(received.length >= 2, 'watcher auto-reconnected and delivered a post-restart event');

  watcher.close();
  await wait(300);
  const afterClose = received.length;
  // After close(), bringing the server up again must NOT resurrect delivery.
  // (A negative assertion — give it well over the backoff window to (not) fire.)
  server!.closeAllConnections?.(); await new Promise<void>(r => server!.close(() => r()));
  server = await mkServer();
  await wait(1000);
  assert(received.length === afterClose, 'close() stops reconnecting for good');

  server!.closeAllConnections?.(); await new Promise<void>(r => server!.close(() => r()));
});
