import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from '../dist/mcp-tools.js';
import { MemoryStore } from '../dist/store.js';

const dir = await mkdtemp(path.join(tmpdir(), 'whatsapp-search-'));
const group = '120363300000000001@g.us';
const other = '120363300000000002@g.us';
const sender = '111111111111111@lid';
const store = new MemoryStore(path.join(dir, 'history.sqlite'));

store.upsertMessage({
  key: { remoteJid: group, id: 'a1', fromMe: false, participant: sender },
  messageTimestamp: 1_700_000_000,
  pushName: 'sender-name',
  message: { conversation: 'alpha-token in the first saved row' },
});
store.upsertMessage({
  key: { remoteJid: group, id: 'a2', fromMe: true },
  messageTimestamp: 1_700_000_100,
  message: { conversation: 'ALPHA-token later' },
});
store.upsertMessage({
  key: { remoteJid: other, id: 'b1', fromMe: false, participant: sender },
  messageTimestamp: 1_700_000_050,
  message: { conversation: 'alpha-token in the other chat' },
});
store.upsertMessage({
  key: { remoteJid: group, id: 'wild', fromMe: false },
  messageTimestamp: 1_700_000_200,
  message: { conversation: '100%_done is literal' },
});
store.upsertMessage({
  key: { remoteJid: group, id: 'almost', fromMe: false },
  messageTimestamp: 1_700_000_250,
  message: { conversation: '100%Zdone is a different row' },
});
store.upsertMessage({
  key: { remoteJid: group, id: 'long', fromMe: false },
  messageTimestamp: 1_700_000_300,
  message: { conversation: `${'x'.repeat(180)} alpha-token tail` },
});
store.upsertMessage({
  key: { remoteJid: group, id: 'pending', fromMe: true },
  messageTimestamp: 1_700_000_400,
  message: { conversation: 'alpha-token pending removal' },
});
store.markDeleteRequested(group, 'pending');
store.upsertMessage({
  key: { remoteJid: group, id: 'revoked', fromMe: false },
  messageTimestamp: 1_700_000_500,
  message: { conversation: 'alpha-token revoked' },
});
store.markDeletedForEveryone(group, 'revoked');

const calls = [];
const wa = {
  getStatus: () => ({ state: 'disconnected', hasCreds: true }),
  getSocket: () => { throw new Error('search must not open the socket'); },
  getStore: () => store,
  resolveJid: async () => { throw new Error('search must not resolve a chat'); },
  start: async () => {},
};
const app = createMcpExpressApp({ host: '127.0.0.1' });
const handler = toNodeHandler(createMcpHandler(() => createMcpServer(wa, { role: 'test', allowSend: false, allowDelete: false })));
app.all('/mcp', (req, res) => { void handler(req, res, req.body); });
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/mcp`;

async function call(args) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whatsapp_search_messages', arguments: args } }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const json = body.startsWith('event:')
    ? JSON.parse(body.split('\n').find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(body);
  return json.result;
}

try {
  const listed = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const listedBody = await listed.text();
  const listedJson = listedBody.startsWith('event:')
    ? JSON.parse(listedBody.split('\n').find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(listedBody);
  assert.ok(listedJson.result.tools.some((tool) => tool.name === 'whatsapp_search_messages'));

  const page = await call({ query: 'alpha-token', chat: group, limit: 2 });
  assert.equal(page.isError, undefined);
  const first = JSON.parse(page.content[0].text);
  assert.equal(first.messages.some((message) => message.id === 'pending' || message.id === 'revoked'), false);
  assert.equal(first.messages.some((message) => message.jid === other), false);
  assert.equal(JSON.stringify(first).includes(sender), false);
  assert.equal(JSON.stringify(first).includes('sender-name'), false);
  assert.equal(first.nextOffset, 2);
  assert.equal(first.messages.length, 2);
  assert.ok(first.messages[0].snippet.startsWith('…'));
  assert.ok(first.messages[0].snippet.length <= 162);

  const rest = await call({ query: 'alpha-token', chat: group, limit: 2, offset: first.nextOffset });
  const older = JSON.parse(rest.content[0].text);
  assert.equal(older.nextOffset, undefined);
  const ids = [...first.messages, ...older.messages].map((message) => message.id);
  assert.deepEqual(ids, ['long', 'a2', 'a1']);
  const hit = [...first.messages, ...older.messages];
  assert.equal(hit.find((message) => message.id === 'a2').fromMe, true);
  assert.equal(hit.find((message) => message.id === 'a2').sentByAccount, 'test');
  assert.equal(hit.find((message) => message.id === 'a1').fromMe, false);
  assert.equal(Object.hasOwn(hit.find((message) => message.id === 'a1'), 'sentByAccount'), false);
  assert.equal(first.account, 'test');
  assert.equal(older.messages.find((message) => message.id === 'a1').snippet, 'alpha-token in the first saved row');

  const ranged = JSON.parse((await call({
    query: 'alpha-token', chat: group, since: 1_700_000_000, until: 1_700_000_000,
  })).content[0].text);
  assert.deepEqual(ranged.messages.map((message) => message.id), ['a1']);

  const literal = JSON.parse((await call({ query: '100%_done', chat: group })).content[0].text);
  assert.deepEqual(literal.messages.map((message) => message.id), ['wild']);

  const backwards = await call({ query: 'alpha-token', since: 20, until: 10 });
  assert.equal(backwards.isError, true);
  assert.equal(calls.length, 0);
  console.log('PASS: saved-message search pages, filters by chat and time, hides deleted rows, and does not contact WhatsApp');
} finally {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  await rm(dir, { recursive: true, force: true });
}
