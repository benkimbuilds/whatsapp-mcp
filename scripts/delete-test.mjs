import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WAMessageStubType } from '@whiskeysockets/baileys';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from '../dist/mcp-tools.js';
import { MemoryStore } from '../dist/store.js';

const dir = await mkdtemp(path.join(tmpdir(), 'whatsapp-delete-'));
const store = new MemoryStore(path.join(dir, 'history.sqlite'));
const group = '123456789@g.us';
const sender = '15555550100@s.whatsapp.net';
store.upsertMessage({ key: { remoteJid: group, id: 'incoming', fromMe: false, participant: sender }, message: { conversation: 'incoming message' } });
store.upsertMessage({ key: { remoteJid: group, id: 'outgoing', fromMe: true, participant: sender }, message: { conversation: 'outgoing message' } });
store.upsertMessage({ key: { remoteJid: sender, id: 'will-fail', fromMe: true }, message: { conversation: 'keep this' } });

const calls = [];
let fail = false;
const socket = { sendMessage: async (...args) => {
  calls.push(args);
  if (fail) throw new Error('simulated WhatsApp refusal');
  return { key: { remoteJid: args[0], id: 'revoke-protocol', fromMe: true } };
} };
const wa = {
  getStatus: () => ({ state: 'open', hasCreds: true }),
  getSocket: () => socket,
  getStore: () => store,
  resolveJid: async (chat) => chat,
};
const app = createMcpExpressApp({ host: '127.0.0.1' });
const handler = toNodeHandler(createMcpHandler(() => createMcpServer(wa, { role: 'test', allowSend: true, allowDelete: true })));
app.all('/mcp', (req, res) => void handler(req, res, req.body));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/mcp`;

async function invoke(chat, messageId) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whatsapp_delete_for_everyone', arguments: { chat, messageId } } }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  return (body.startsWith('event:') ? JSON.parse(body.split('\n').find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body)).result;
}

try {
  assert.equal((await invoke(group, 'incoming')).isError, true);
  assert.equal((await invoke(group, 'unknown')).isError, true);
  assert.equal(calls.length, 0);

  const result = await invoke(group, 'outgoing');
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).revokeRequested, true);
  assert.deepEqual(calls[0], [group, { delete: { remoteJid: group, id: 'outgoing', fromMe: true, participant: sender } }]);
  assert.ok(store.getOwnMessageKey(group, 'outgoing'));
  const requested = store.listMessages(group, 10).messages.find((m) => m.id === 'outgoing');
  assert.equal(requested.text, '[delete requested]');
  assert.equal(requested.deleteRequested, true);
  store.updateMessage(
    { remoteJid: group, id: 'outgoing', fromMe: true },
    { message: null, messageStubType: WAMessageStubType.REVOKE, key: { remoteJid: group, id: 'separate-revoke-message', fromMe: true } },
  );
  assert.equal(store.getOwnMessageKey(group, 'outgoing'), null);
  assert.equal(store.listMessages(group, 10).messages.find((m) => m.id === 'outgoing').text, '[deleted for everyone]');
  assert.equal(store.listMessages(group, 10).messages.some((m) => m.id === 'separate-revoke-message'), false);
  assert.equal((await invoke(group, 'outgoing')).isError, true);
  assert.equal(calls.length, 1);

  fail = true;
  assert.equal((await invoke(sender, 'will-fail')).isError, true);
  assert.ok(store.getOwnMessageKey(sender, 'will-fail'));
  assert.equal(store.listMessages(sender, 10).messages[0].text, 'keep this');
  console.log('PASS: only own exact message can be revoked, key is preserved, tombstone persists, failed revoke leaves history intact');
} finally {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  await rm(dir, { recursive: true, force: true });
}
