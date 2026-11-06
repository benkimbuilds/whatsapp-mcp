import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from '../dist/mcp-tools.js';
import { MemoryStore } from '../dist/store.js';

const dir = await mkdtemp(path.join(tmpdir(), 'whatsapp-mentions-'));
const dbPath = path.join(dir, 'history.sqlite');
const group = '120363500000000001@g.us';
const ours = '111111111111301@lid';
const other = '111111111111302@lid';
const mentioned = '111111111111301:14@lid';

function seed(store) {
  store.upsertMessage({
    key: { remoteJid: group, id: 'ours', fromMe: true },
    messageTimestamp: 90,
    message: { conversation: 'ours-token' },
  });
  store.upsertMessage({
    key: { remoteJid: group, id: 'old-mention', fromMe: false, participant: other },
    messageTimestamp: 50,
    pushName: 'other-name',
    message: { extendedTextMessage: { text: 'old-mention-token', contextInfo: { mentionedJid: [mentioned] } } },
  });
  store.upsertMessage({
    key: { remoteJid: group, id: 'mention', fromMe: false, participant: other },
    messageTimestamp: 100,
    pushName: 'other-name',
    message: { extendedTextMessage: { text: 'mention-token', contextInfo: { mentionedJid: [mentioned] } } },
  });
  store.upsertMessage({
    key: { remoteJid: group, id: 'reply', fromMe: false, participant: other },
    messageTimestamp: 110,
    message: { extendedTextMessage: { text: 'reply-token', contextInfo: { stanzaId: 'ours', participant: mentioned } } },
  });
  store.upsertMessage({
    key: { remoteJid: group, id: 'both', fromMe: false, participant: other },
    messageTimestamp: 120,
    message: { extendedTextMessage: { text: 'both-token', contextInfo: { mentionedJid: [ours], stanzaId: 'ours', participant: ours } } },
  });
  store.upsertMessage({
    key: { remoteJid: group, id: 'unrelated', fromMe: false, participant: other },
    messageTimestamp: 130,
    message: { extendedTextMessage: { text: 'unrelated-token', contextInfo: { mentionedJid: [other] } } },
  });
  store.upsertMessage({
    key: { remoteJid: group, id: 'reply-only', fromMe: false, participant: other },
    messageTimestamp: 140,
    message: { extendedTextMessage: { text: 'reply-only-token', contextInfo: { stanzaId: 'missing-row', participant: mentioned } } },
  });
  store.upsertMessage({
    key: { remoteJid: group, id: 'revoked-mention', fromMe: false, participant: other },
    messageTimestamp: 150,
    message: { extendedTextMessage: { text: 'revoked-mention-token', contextInfo: { mentionedJid: [ours] } } },
  });
  store.markDeletedForEveryone(group, 'revoked-mention');
}

const first = new MemoryStore(dbPath);
seed(first);
first.close();
const store = new MemoryStore(dbPath);
let account = { lid: ours };
const wa = {
  getStatus: () => ({ state: 'disconnected', hasCreds: true }),
  getSocket: () => { throw new Error('mentions must not open the socket'); },
  getStore: () => store,
  getAccount: () => ({ ...account }),
  resolveJid: async () => { throw new Error('mentions must not resolve a chat'); },
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
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whatsapp_mentions', arguments: args } }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const json = body.startsWith('event:')
    ? JSON.parse(body.split('\n').find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(body);
  return json.result;
}

try {
  const page = await call({ since: 90, chat: group, limit: 10 });
  assert.equal(page.isError, undefined);
  const body = page.content[0].text;
  const parsed = JSON.parse(body);
  assert.equal(parsed.account, 'test');
  assert.equal(parsed.accountJid, ours);
  const withoutAccount = { ...parsed };
  delete withoutAccount.account;
  delete withoutAccount.accountJid;
  delete withoutAccount.accountPhone;
  const hidden = JSON.stringify(withoutAccount);
  for (const secret of [ours, other, mentioned, 'other-name', 'ours-token', 'unrelated-token', 'revoked-mention-token', 'old-mention-token']) {
    assert.equal(hidden.includes(secret), false, secret);
  }
  const digest = parsed;
  assert.deepEqual(digest.messages.map((message) => [message.id, message.reason, message.snippet]), [
    ['reply-only', 'reply', 'reply-only-token'],
    ['both', 'both', 'both-token'],
    ['reply', 'reply', 'reply-token'],
    ['mention', 'mention', 'mention-token'],
  ]);
  assert.equal(digest.messages.every((message) => message.jid === group && message.timestamp >= 90), true);

  const older = JSON.parse((await call({ since: 0, chat: group, limit: 1, offset: 4 })).content[0].text);
  assert.deepEqual(older.messages.map((message) => message.id), ['old-mention']);

  account = {};
  const unknown = await call({ since: 90 });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /not known/);
  console.log('PASS: mentions digest keeps mention and reply rows, drops sender ids, and requires a known account');
} finally {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  await rm(dir, { recursive: true, force: true });
}
