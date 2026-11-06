import assert from 'node:assert/strict';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from '../dist/mcp-tools.js';
import {
  acceptsRealtimeUpsert,
  createWebhook,
  loadWebhookSettings,
  selectIncoming,
} from '../dist/webhook.js';

const KEY = 'super-secret-webhook-key';
const PREVIEW = 'zebra-message-preview';
const GROUP = '120363000000000000@g.us';

function message(overrides = {}) {
  return {
    key: { remoteJid: '15555550100@s.whatsapp.net', fromMe: false, id: 'm1', ...overrides.key },
    messageTimestamp: 1_700_000_000,
    pushName: 'Ada',
    message: { conversation: PREVIEW },
    ...overrides,
    key: { remoteJid: '15555550100@s.whatsapp.net', fromMe: false, id: 'm1', ...overrides.key },
  };
}

function clock() {
  const state = { now: 1_700_000_000_000, timers: [] };
  return {
    now: () => state.now,
    delay(ms, fn) {
      const timer = { at: state.now + ms, fn, cancelled: false };
      state.timers.push(timer);
      return { cancel() { timer.cancelled = true; } };
    },
    async advance(ms) {
      state.now += ms;
      for (let turn = 0; turn < 20; turn += 1) {
        const due = state.timers.filter((timer) => !timer.cancelled && timer.at <= state.now);
        state.timers = state.timers.filter((timer) => timer.cancelled || timer.at > state.now);
        if (due.length === 0) return;
        for (const timer of due) timer.fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error('webhook timers did not settle');
    },
  };
}

const groups = new Set([GROUP]);
assert.equal(acceptsRealtimeUpsert('notify'), true);
assert.equal(acceptsRealtimeUpsert('append'), false);
assert.equal(acceptsRealtimeUpsert(undefined), false);

const direct = selectIncoming(message(), groups, 'Ada Chat', 1_700_000_000_000);
assert.equal(direct.chatJid, '15555550100@s.whatsapp.net');
assert.equal(direct.chatName, 'Ada Chat');
assert.equal(direct.senderName, 'Ada');
assert.equal(direct.text, PREVIEW);
assert.equal(direct.timestamp, '2023-11-14T22:13:20.000Z');
assert.equal(selectIncoming(message({ key: { fromMe: true } }), groups, '', 0), null);
assert.equal(selectIncoming(message({ key: { remoteJid: '999@g.us', id: 'g1' } }), groups, '', 0), null);
assert.equal(selectIncoming(message({ key: { remoteJid: GROUP, id: 'g2', participant: '15555550199@s.whatsapp.net' }, pushName: '' }), groups, 'Group', 0).senderName, '15555550199');
assert.equal(selectIncoming(message({ key: { remoteJid: 'status@broadcast', id: 's' } }), groups, '', 0), null);
assert.equal(selectIncoming(message({ message: { reactionMessage: { text: 'ok' } } }), groups, '', 0), null);
assert.equal(selectIncoming(message({ message: { protocolMessage: { type: 0 } } }), groups, '', 0), null);
assert.equal(selectIncoming(message({ message: { conversation: '   ' } }), groups, '', 0), null);
assert.equal(selectIncoming(message({ message: { imageMessage: { caption: '' } } }), groups, '', 0).text, '[image]');
assert.equal(selectIncoming(message({ message: { conversation: 'x'.repeat(250) } }), groups, '', 0).text.length, 200);
assert.equal(selectIncoming(message({ key: { remoteJid: '15555550101@lid', id: 'lid' } }), groups, '', 0).chatJid.endsWith('@lid'), true);

const loggedErrors = [];
const writeError = console.error;
console.error = (line) => loggedErrors.push(String(line));
assert.equal(loadWebhookSettings({}, 'personal', () => ''), null);
assert.equal(loadWebhookSettings({ WEBHOOK_URL: '   ' }, 'personal', () => ''), null);
assert.equal(loadWebhookSettings({ WEBHOOK_URL: 'https://user:secret@example.test/hook' }, 'personal', () => ''), null);
console.error = writeError;
assert.equal(loggedErrors.join('\n').includes('user:secret'), false);
const loaded = loadWebhookSettings({
  WEBHOOK_URL: 'https://example.test/hook',
  WEBHOOK_GROUP_JIDS: `${GROUP}, nope, 222@g.us`,
}, 'personal', () => 'Named');
assert.equal(loaded.keyHeader, 'Authorization');
assert.equal(loaded.keyPrefix, 'Bearer ');
assert.equal(loaded.batchMs, 600_000);
assert.equal(loaded.maxPerHour, 6);
assert.deepEqual([...loaded.groupJids], [GROUP, '222@g.us']);
const bare = loadWebhookSettings({
  WEBHOOK_URL: 'https://example.test/hook',
  WEBHOOK_KEY: KEY,
  WEBHOOK_KEY_PREFIX: '',
  WEBHOOK_KEY_HEADER: 'X-Webhook-Key',
}, 'personal', () => '');
assert.equal(bare.keyPrefix, '');
assert.equal(bare.keyHeader, 'X-Webhook-Key');

const offCalls = [];
const off = createWebhook(null, { fetch: async () => { offCalls.push(1); return new Response('no'); } });
off.push(message());
assert.equal(offCalls.length, 0);
assert.equal(off.status().enabled, false);

const time = clock();
const calls = [];
const logs = [];
let remainingFailures = 1;
const webhook = createWebhook({
  url: 'https://example.test/hook',
  key: KEY,
  keyHeader: 'Authorization',
  keyPrefix: 'Bearer ',
  groupJids: groups,
  batchMs: 1_000,
  maxPerHour: 1,
  session: 'personal',
  chatName: () => 'Ada Chat',
}, {
  now: time.now,
  delay: time.delay,
  log: (line) => logs.push(line),
  fetch: async (_url, init) => {
    calls.push(init);
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      return new Response('no', { status: 500 });
    }
    return new Response('ok', { status: 200 });
  },
});

webhook.push(message());
await time.advance(500);
assert.equal(calls.length, 0);
webhook.push(message({ key: { id: 'm2' }, message: { conversation: 'second preview' } }));
await time.advance(500);
assert.equal(calls.length, 1);
await time.advance(1_000);
assert.equal(calls.length, 2, 'a 500 is retried once');
assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
const body = JSON.parse(calls[1].body);
assert.equal(body.account, 'personal');
assert.equal(body.accountJid, null);
assert.equal(body.accountPhone, null);
assert.equal(body.messages.length, 2);
assert.equal(body.dropped, 0);
assert.equal(body.messages[0].fromMe, false);
assert.equal(body.messages[0].text, PREVIEW);
assert.equal(calls[1].headers['X-Webhook-Signature'], undefined);
assert.equal(body.messages[1].chatName, 'Ada Chat');
assert.equal(webhook.status().sentBatches, 1);
assert.equal(webhook.status().sentMessages, 2);
assert.equal(webhook.status().lastError, null);
assert.match(webhook.status().lastSentAt, /^\d{4}-\d{2}-\d{2}T/);

webhook.push(message({ key: { id: 'm3' }, message: { conversation: 'dropped-preview-text' } }));
await time.advance(1_000);
assert.equal(calls.length, 2);
assert.equal(webhook.status().dropped, 1);
assert.match(logs.at(-1), /dropped 1 messages; hourly cap 1 reached/);

const clientError = clock();
const clientCalls = [];
const clientLogs = [];
const clientWebhook = createWebhook({
  url: 'https://example.test/hook',
  key: KEY,
  keyHeader: 'Authorization',
  keyPrefix: 'Bearer ',
  groupJids: groups,
  batchMs: 10,
  maxPerHour: 5,
  session: 'personal',
  chatName: () => '',
}, {
  now: clientError.now,
  delay: clientError.delay,
  log: (line) => clientLogs.push(line),
  fetch: async () => {
    clientCalls.push(1);
    throw Object.assign(new Error(`boom ${KEY} ${PREVIEW}`), { name: 'TimeoutError' });
  },
});
clientWebhook.push(message({ key: { id: 't1' } }));
await clientError.advance(10);
await clientError.advance(1_000);
assert.equal(clientCalls.length, 2);
assert.equal(clientWebhook.status().failedBatches, 1);
assert.equal(clientWebhook.status().lastError, 'error=timeout');
assert.equal(clientWebhook.status().sentBatches, 0);

const rejected = clock();
const rejectedCalls = [];
const rejectedWebhook = createWebhook({
  url: 'https://example.test/hook',
  key: KEY,
  keyHeader: 'X-Webhook-Key',
  keyPrefix: '',
  groupJids: groups,
  batchMs: 10,
  maxPerHour: 5,
  session: 'personal',
  chatName: () => '',
}, {
  now: rejected.now,
  delay: rejected.delay,
  log: (line) => logs.push(line),
  fetch: async (_url, init) => {
    rejectedCalls.push(init.headers['X-Webhook-Key']);
    return new Response('bad', { status: 400 });
  },
});
rejectedWebhook.push(message({ key: { id: 'r1' } }));
await rejected.advance(10);
assert.deepEqual(rejectedCalls, [KEY]);
assert.equal(rejectedWebhook.status().lastError, 'status=400');

const capped = clock();
const cappedCalls = [];
const cappedWebhook = createWebhook({
  url: 'https://example.test/hook',
  key: KEY,
  keyHeader: 'Authorization',
  keyPrefix: 'Bearer ',
  groupJids: groups,
  batchMs: 10,
  maxPerHour: 6,
  session: 'personal',
  chatName: () => 'Ada Chat',
}, {
  now: capped.now,
  delay: capped.delay,
  log: (line) => logs.push(line),
  fetch: async (_url, init) => {
    cappedCalls.push(JSON.parse(init.body));
    return new Response('ok', { status: 200 });
  },
});
for (let index = 0; index < 101; index += 1) {
  cappedWebhook.push(message({ key: { id: `cap-${index}` }, message: { conversation: `row ${index}` } }));
}
await capped.advance(10);
assert.equal(cappedCalls.length, 1);
assert.equal(cappedCalls[0].messages.length, 100);
assert.equal(cappedCalls[0].dropped, 1);
assert.equal(cappedCalls[0].messages.some((item) => item.text === 'row 100'), false);
assert.equal(cappedWebhook.status().dropped, 1);
assert.equal(cappedWebhook.status().sentMessages, 100);

const logged = [...logs, ...clientLogs].join('\n');
assert.equal(logged.includes(KEY), false);
assert.equal(logged.includes(PREVIEW), false);
assert.equal(logged.includes('dropped-preview-text'), false);
assert.equal(logged.includes('second preview'), false);

const wa = {
  getStatus: () => ({ state: 'disconnected', hasCreds: false }),
  getSocket: () => null,
  getStore: () => { throw new Error('webhook status must not read the store'); },
  resolveJid: async () => { throw new Error('no'); },
  getAccount: () => ({}),
  getWebhookStatus: () => webhook.status(),
  start: async () => {},
};
const app = createMcpExpressApp({ host: '127.0.0.1' });
const handler = toNodeHandler(createMcpHandler(() => createMcpServer(wa, { role: 'personal', allowSend: false, allowDelete: false })));
app.all('/mcp', (req, res) => { void handler(req, res, req.body); });
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
try {
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const listed = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const listedBody = await listed.text();
  const listedJson = listedBody.startsWith('event:')
    ? JSON.parse(listedBody.split('\n').find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(listedBody);
  const names = listedJson.result.tools.map((tool) => tool.name);
  assert.equal(names.includes('webhook_status'), false);
  assert.equal(names.includes('whatsapp_send_text'), true);
  assert.equal(names.includes('whatsapp_group_info'), true);
  assert.equal(names.length, 23);
  const called = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'whatsapp_action', arguments: { action: 'webhook_status' } },
    }),
  });
  const calledBody = await called.text();
  const calledJson = calledBody.startsWith('event:')
    ? JSON.parse(calledBody.split('\n').find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(calledBody);
  const status = JSON.parse(calledJson.result.content[0].text);
  assert.equal(status.enabled, true);
  assert.equal(status.dropped, 1);
  assert.equal(JSON.stringify(status).includes(KEY), false);
  assert.equal(JSON.stringify(status).includes(PREVIEW), false);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log('PASS: webhook filters incoming messages, sends one fixed-window batch, caps the hour, and keeps the key out of logs');
