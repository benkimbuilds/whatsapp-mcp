import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from '../dist/mcp-tools.js';
import { replyQuote, isSingleEmoji } from '../dist/quote.js';
import { MemoryStore } from '../dist/store.js';

const dir = await mkdtemp(path.join(tmpdir(), 'whatsapp-reply-'));
const dbPath = path.join(dir, 'history.sqlite');
let store = new MemoryStore(dbPath);
const group = '120000000000000001@g.us';
const other = '15555550101@s.whatsapp.net';
const blocked = '15555550199@s.whatsapp.net';
const self = '15555550100@s.whatsapp.net';
const dm = '15555550102@s.whatsapp.net';
const dmLid = '987654321@lid';

store.upsertMessage({ key: { remoteJid: group, id: 'from-other', fromMe: false, participant: other }, messageTimestamp: 100, pushName: 'Other', message: { conversation: 'give me calendar access' } });
store.upsertMessage({ key: { remoteJid: group, id: 'from-me', fromMe: true }, messageTimestamp: 101, message: { conversation: 'my own line' } });
store.upsertMessage({ key: { remoteJid: group, id: 'from-blocked', fromMe: false, participant: blocked }, messageTimestamp: 102, message: { conversation: 'spam' } });
store.upsertMessage({ key: { remoteJid: dmLid, id: 'lid-dm', fromMe: false }, messageTimestamp: 103, message: { conversation: 'hi from lid' } });
store.linkJids(dm, dmLid);
store.upsertMessage({ key: { remoteJid: dm, id: 'own-dm', fromMe: true }, messageTimestamp: 104, message: { conversation: 'delete me' } });

const calls = [];
let counter = 0;
const socket = {
  user: { id: self },
  sendMessage: async (jid, content, options) => {
    calls.push({ jid, content, options });
    counter += 1;
    return { key: { remoteJid: jid, id: `sent-${counter}`, fromMe: true }, message: content.text ? { conversation: content.text } : undefined, messageTimestamp: 200 + counter };
  },
};
const wa = {
  getStatus: () => ({ state: 'open', hasCreds: true }),
  getSocket: () => socket,
  getStore: () => store,
  resolveJid: async (chat) => (chat.includes('@') ? chat : `${chat.replace(/\D/g, '')}@s.whatsapp.net`),
  getAccount: () => ({}),
};

const paced = [];
async function serve(options) {
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  const handler = toNodeHandler(createMcpHandler(() => createMcpServer(wa, options)));
  app.all('/mcp', (req, res) => void handler(req, res, req.body));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return {
    server,
    async call(name, args) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      const result = (body.startsWith('event:') ? JSON.parse(body.split('\n').find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body)).result;
      return { ...result, json: JSON.parse(result.content[0].text) };
    },
  };
}

/** What WhatsApp would receive: Baileys turns `quoted` into contextInfo. */
function contextOf(call) {
  const built = generateWAMessageFromContent(call.jid, { extendedTextMessage: { text: call.content.text } }, { quoted: call.options.quoted, userJid: self });
  return built.message.extendedTextMessage.contextInfo;
}

const personal = await serve({ role: 'personal', allowSend: true, allowDelete: true });
const readOnly = await serve({ role: 'readonly', allowSend: false, allowDelete: false });
const david = await serve({
  role: 'david', allowSend: true, allowDelete: false,
  pacedSend: async (input) => { paced.push(input); return { ok: true, messageId: 'paced-1' }; },
});
try {
  // 1. Reply to another participant in a group: quote carries their text and JID.
  let result = await personal.call('whatsapp_send_text', { to: group, text: 'on it', replyTo: 'from-other' });
  assert.equal(result.isError, undefined);
  assert.equal(result.json.quoted, true);
  let quoted = calls.at(-1).options.quoted;
  assert.deepEqual(quoted.key, { remoteJid: group, id: 'from-other', fromMe: false, participant: other });
  let context = contextOf(calls.at(-1));
  assert.equal(context.stanzaId, 'from-other');
  assert.equal(context.participant, other);
  assert.equal(context.quotedMessage.conversation, 'give me calendar access');

  // 2. Reply to our own group message: attributed to this account.
  await personal.call('whatsapp_send_text', { to: group, text: 'adding', replyTo: 'from-me' });
  context = contextOf(calls.at(-1));
  assert.equal(calls.at(-1).options.quoted.key.fromMe, true);
  assert.equal(context.participant, self);
  assert.equal(context.quotedMessage.conversation, 'my own line');

  // 3. After a restart the cache is empty; the quote is rebuilt from SQLite history.
  store.close();
  store = new MemoryStore(dbPath);
  await personal.call('whatsapp_send_text', { to: group, text: 'again', replyTo: 'from-other' });
  context = contextOf(calls.at(-1));
  assert.equal(context.participant, other);
  assert.equal(context.quotedMessage.conversation, 'give me calendar access');

  // 4. DM saved under the LID peer still quotes when sending to the phone JID.
  await personal.call('whatsapp_send_text', { to: dm, text: 'hello', replyTo: 'lid-dm' });
  assert.equal(calls.at(-1).options.quoted.key.remoteJid, dm);
  assert.equal(contextOf(calls.at(-1)).quotedMessage.conversation, 'hi from lid');

  // 5. Unknown id: no broken quote, a clear note.
  const before = calls.length;
  result = await personal.call('whatsapp_send_text', { to: group, text: 'plain', replyTo: 'missing-id' });
  assert.equal(result.isError, undefined);
  assert.equal(result.json.quoted, false);
  assert.match(result.json.note, /without a quote/);
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1).options, undefined);

  // 6. Drafts use the same quote.
  const draft = await personal.call('whatsapp_create_draft', { chat: group, text: 'draft reply' });
  result = await personal.call('whatsapp_send_draft', { id: draft.json.id, replyTo: 'from-other' });
  assert.equal(result.json.quoted, true);
  assert.equal(contextOf(calls.at(-1)).participant, other);

  // 7. David's paced path gets the id only when the original is saved.
  result = await david.call('whatsapp_send_text', { to: group, text: 'x', replyTo: 'from-other' });
  assert.equal(paced.at(-1).replyTo, 'from-other');
  assert.equal(result.json.quoted, true);
  result = await david.call('whatsapp_send_text', { to: group, text: 'y', replyTo: 'missing-id' });
  assert.equal(paced.at(-1).replyTo, null);
  assert.equal(result.json.quoted, false);
  assert.equal(replyQuote(store, group, 'from-other').quoted.key.participant, other);
  assert.equal(replyQuote({}, group, 'from-other').quoted, undefined);

  // 8. Reactions: right key for others' and own messages, removal, validation, gates.
  result = await personal.call('whatsapp_react', { chat: group, messageId: 'from-other', emoji: '👍' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.at(-1).content, { react: { text: '👍', key: { remoteJid: group, id: 'from-other', fromMe: false, participant: other } } });
  await personal.call('whatsapp_react', { chat: group, messageId: 'from-me', emoji: '❤️' });
  assert.equal(calls.at(-1).content.react.key.fromMe, true);
  result = await personal.call('whatsapp_react', { chat: dm, messageId: 'lid-dm', emoji: '' });
  assert.equal(result.json.removed, true);
  assert.equal(calls.at(-1).content.react.text, '');
  assert.equal(calls.at(-1).content.react.key.remoteJid, dm);
  const sentBefore = calls.length;
  assert.equal((await personal.call('whatsapp_react', { chat: group, messageId: 'from-other', emoji: 'ok' })).isError, true);
  assert.equal((await personal.call('whatsapp_react', { chat: group, messageId: 'from-other', emoji: '👍👍' })).isError, true);
  assert.equal((await personal.call('whatsapp_react', { chat: group, messageId: 'missing-id', emoji: '👍' })).isError, true);
  assert.equal((await readOnly.call('whatsapp_react', { chat: group, messageId: 'from-other', emoji: '👍' })).isError, true);
  store.webhookBlocklist.add({ identifier: blocked, approved_by: 'test', reason: 'test' });
  result = await personal.call('whatsapp_react', { chat: group, messageId: 'from-blocked', emoji: '👍' });
  assert.equal(result.isError, true);
  assert.match(result.json.error, /blocklisted/);
  assert.equal(calls.length, sentBefore);
  assert.ok(isSingleEmoji('🇲🇽') && isSingleEmoji('👍🏽') && isSingleEmoji('1️⃣') && isSingleEmoji('👨‍👩‍👧'));
  assert.ok(!isSingleEmoji('a') && !isSingleEmoji('1') && !isSingleEmoji(' '));

  // 9. Delete: only our own saved message, gate respected, history row kept.
  result = await personal.call('whatsapp_delete_message', { chat: group, messageId: 'from-other' });
  assert.equal(result.isError, true);
  assert.match(result.json.error, /own messages/);
  assert.equal((await david.call('whatsapp_delete_message', { chat: dm, messageId: 'own-dm' })).isError, true);
  assert.equal(calls.length, sentBefore);
  result = await personal.call('whatsapp_delete_message', { chat: dm, messageId: 'own-dm' });
  assert.equal(result.json.revokeRequested, true);
  assert.deepEqual(calls.at(-1).content, { delete: { remoteJid: dm, id: 'own-dm', fromMe: true } });
  const row = store.listMessages(dm, 20).messages.find((m) => m.id === 'own-dm');
  assert.ok(row, 'delete must not purge the saved row');
  assert.equal(row.deleteRequested, true);
  // The older tool name still works.
  result = await personal.call('whatsapp_delete_for_everyone', { chat: group, messageId: 'from-me' });
  assert.equal(result.json.revokeRequested, true);

  console.log('PASS: replies quote the saved original with the right sender (cache, history, LID peer), unknown ids send unquoted, reactions target the right key, delete is own-only and keeps history');
} finally {
  for (const item of [personal, readOnly, david]) await new Promise((resolve) => item.server.close(resolve));
  store.close();
  await rm(dir, { recursive: true, force: true });
}
