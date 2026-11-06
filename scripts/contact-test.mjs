import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from '../dist/mcp-tools.js';
import { MemoryStore } from '../dist/store.js';

const dir = await mkdtemp(path.join(tmpdir(), 'whatsapp-contacts-'));
const dbPath = path.join(dir, 'history.sqlite');
const pn = '15555550199@s.whatsapp.net';
const lid = '111111111111111@lid';
const otherPn = '15555550200@s.whatsapp.net';
const thirdPn = '15555550201@s.whatsapp.net';
const thirdLid = '333333333333333@lid';
const fourthPn = '15555550202@s.whatsapp.net';
const fourthLid = '444444444444444@lid';
const group = '120363300000000009@g.us';
const calls = [];

const store = new MemoryStore(dbPath);
store.upsertChat({ id: pn, name: '+1 ••• ••• ••99', conversationTimestamp: 10 });
store.upsertContact({
  id: pn,
  name: 'Ada Lovelace',
  notify: 'Ada Push',
  verifiedName: 'Ada Biz',
  lid,
});
assert.equal(store.listChats(10).find((chat) => chat.id === pn)?.name, 'Ada Lovelace');
store.upsertChat({ id: lid, name: '111111111111111', conversationTimestamp: 20 });
assert.equal(store.listChats(10).find((chat) => chat.id === lid)?.name, 'Ada Lovelace');

store.upsertContact({ id: pn, notify: 'Ada Later', imgUrl: 'https://example.invalid/a' });
assert.equal(store.listChats(10).find((chat) => chat.id === pn)?.name, 'Ada Lovelace');

store.upsertChat({ id: otherPn, name: '15555550200', conversationTimestamp: 5 });
store.upsertContact({ id: otherPn, verifiedName: 'Grace Biz' });
assert.equal(store.listChats(10).find((chat) => chat.id === otherPn)?.name, 'Grace Biz');

store.upsertChat({ id: thirdLid, name: '+1 ••• ••• ••01', conversationTimestamp: 30 });
store.upsertMessage({
  key: { remoteJid: thirdLid, remoteJidAlt: thirdPn, id: 'in1', fromMe: false },
  messageTimestamp: 30,
  pushName: 'Grace Hopper',
  message: { conversation: 'hello there' },
});
assert.equal(store.listChats(20).find((chat) => chat.id === thirdLid)?.name, 'Grace Hopper');
const direct = store.listMessages(thirdLid, 10);
assert.equal(direct.name, 'Grace Hopper');
assert.equal(direct.messages.find((message) => message.id === 'in1')?.name, 'Grace Hopper');

store.upsertMessage({
  key: { remoteJid: thirdLid, id: 'out1', fromMe: true },
  messageTimestamp: 31,
  pushName: 'Not The Contact',
  message: { conversation: 'reply' },
});
assert.equal(store.listChats(20).find((chat) => chat.id === thirdLid)?.name, 'Grace Hopper');
assert.equal(store.listMessages(thirdLid, 10).messages.find((message) => message.id === 'out1')?.name, undefined);

store.upsertChat({ id: group, name: 'Book club', conversationTimestamp: 40 });
store.upsertMessage({
  key: { remoteJid: group, id: 'g1', fromMe: false, participant: pn, participantAlt: lid },
  messageTimestamp: 40,
  pushName: 'Someone Else',
  message: { conversation: 'meeting' },
});
assert.equal(store.listChats(20).find((chat) => chat.id === group)?.name, 'Book club');
const groupPage = store.listMessages(group, 10);
assert.equal(groupPage.name, 'Book club');
assert.equal(groupPage.messages[0]?.name, 'Ada Lovelace');
assert.equal(JSON.stringify(groupPage).includes(pn), false);

store.upsertChat({ id: '15555550999@s.whatsapp.net', name: '+1 ••• ••• ••99', conversationTimestamp: 1 });
assert.equal(store.listChats(30).find((chat) => chat.id === '15555550999@s.whatsapp.net')?.name, '+1 ••• ••• ••99');

store.upsertContact({ id: fourthPn, notify: 'Lin' });
store.linkJids(fourthPn, fourthLid);
store.upsertChat({ id: fourthLid, conversationTimestamp: 4 });
assert.equal(store.listChats(20).find((chat) => chat.id === fourthLid)?.name, 'Lin');

store.upsertContact({ id: '555555555555555@lid', phoneNumber: '15555550205', name: 'Digit Name' });
assert.equal(store.listChats(20).find((chat) => chat.id === '15555550205@s.whatsapp.net'), undefined);
store.upsertMessage({
  key: { remoteJid: '15555550205@s.whatsapp.net', id: 'd1', fromMe: false },
  messageTimestamp: 3,
  message: { conversation: 'digits' },
});
assert.equal(store.listMessages('15555550205@s.whatsapp.net', 5).name, 'Digit Name');

store.close();
const reopened = new MemoryStore(dbPath);
assert.equal(reopened.listChats(20).find((chat) => chat.id === lid)?.name, 'Ada Lovelace');
assert.equal(reopened.listMessages(thirdLid, 5).name, 'Grace Hopper');

const loved = reopened.findContacts('LOVELACE', 10, 0);
assert.equal(loved.contacts.length, 1);
assert.equal(loved.contacts[0].name, 'Ada Lovelace');
assert.equal(loved.contacts[0].jid, lid);
const hopper = reopened.findContacts('hopper', 10, 0);
assert.deepEqual(hopper.contacts, [{ jid: thirdLid, name: 'Grace Hopper' }]);
const biz = reopened.findContacts('biz', 10, 0).contacts.map((contact) => contact.name).sort();
assert.deepEqual(biz, ['Ada Lovelace', 'Grace Biz']);
reopened.upsertContact({ id: '15555550203@s.whatsapp.net', name: '100%_done' });
assert.equal(reopened.findContacts('100%_done', 10, 0).contacts.length, 1);
assert.equal(reopened.findContacts('100%Zdone', 10, 0).contacts.length, 0);
reopened.upsertContact({ id: '15555550204@s.whatsapp.net', name: 'José' });
assert.equal(reopened.findContacts('josé', 10, 0).contacts.some((contact) => contact.name === 'José'), true);
assert.throws(() => reopened.findContacts('   ', 10, 0), /query must be 1 to 80 characters/);
const page = reopened.findContacts('a', 1, 0);
assert.equal(page.contacts.length, 1);
assert.equal(page.nextOffset, 1);
assert.equal(reopened.findContacts('a', 1, page.nextOffset).contacts.length, 1);

const wa = {
  getStatus: () => ({ state: 'disconnected', hasCreds: true }),
  getSocket: () => { calls.push('socket'); throw new Error('contact lookup must not open the socket'); },
  getStore: () => reopened,
  resolveJid: async () => { calls.push('resolve'); throw new Error('contact lookup must not resolve a chat'); },
  getAccount: () => ({}),
  start: async () => {},
};
const app = createMcpExpressApp({ host: '127.0.0.1' });
const handler = toNodeHandler(createMcpHandler(() => createMcpServer(wa, { role: 'test', allowSend: false, allowDelete: false })));
app.all('/mcp', (req, res) => { void handler(req, res, req.body); });
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/mcp`;

function rpc(body) {
  const json = body.startsWith('event:')
    ? JSON.parse(body.split('\n').find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(body);
  return json.result;
}

async function call(name, args) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  return rpc(await response.text());
}

try {
  const listed = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(rpc(await listed.text()).tools.some((tool) => tool.name === 'whatsapp_find_contact'), true);

  const chats = JSON.parse((await call('whatsapp_list_chats', { limit: 20 })).content[0].text);
  assert.equal(chats.chats.find((chat) => chat.id === lid)?.name, 'Ada Lovelace');
  assert.equal(chats.chats.find((chat) => chat.id === group)?.name, 'Book club');
  const messages = JSON.parse((await call('whatsapp_read_messages', { chat: thirdLid, limit: 10 })).content[0].text);
  assert.equal(messages.name, 'Grace Hopper');
  assert.equal(messages.messages.find((message) => message.id === 'in1')?.name, 'Grace Hopper');
  const found = JSON.parse((await call('whatsapp_find_contact', { query: 'lovelace' })).content[0].text);
  assert.deepEqual(found.contacts, [{ jid: lid, name: 'Ada Lovelace' }]);
  assert.equal(calls.length, 0);
  console.log('PASS: contact names persist across LID and phone JIDs, show on chats and messages, and search without contacting WhatsApp');
} finally {
  await new Promise((resolve) => server.close(resolve));
  reopened.close();
  await rm(dir, { recursive: true, force: true });
}
