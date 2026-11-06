import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from '../dist/mcp-tools.js';
import { MemoryStore } from '../dist/store.js';

const group = '120363500000000001@g.us';
const marker = 'draft-token';
const dir = await mkdtemp(path.join(tmpdir(), 'whatsapp-draft-'));

{
  const persisted = new MemoryStore(path.join(dir, 'persist.sqlite'));
  const saved = persisted.createDraft({ jid: group, text: marker, sendAt: 1_600_000_000 });
  persisted.close();
  const reopened = new MemoryStore(path.join(dir, 'persist.sqlite'));
  const kept = reopened.listDrafts();
  assert.equal(kept.drafts.length, 1);
  assert.equal(kept.drafts[0].id, saved.id);
  assert.equal(kept.drafts[0].jid, group);
  assert.equal(kept.drafts[0].text, marker);
  assert.equal(kept.drafts[0].sendAt, 1_600_000_000);
  assert.equal(reopened.cancelDraft(saved.id), 'cancelled');
  assert.deepEqual(reopened.listDrafts().drafts, []);
  reopened.close();
}

{
  const capped = new MemoryStore(path.join(dir, 'cap.sqlite'));
  for (let i = 0; i < 100; i += 1) capped.createDraft({ jid: group, text: marker });
  assert.throws(() => capped.createDraft({ jid: group, text: marker }), /Too many drafts/);
  capped.close();
}

const store = new MemoryStore(path.join(dir, 'history.sqlite'));
const calls = [];
let state = 'disconnected';
let allowSend = false;
let sendImpl = async () => {
  throw new Error('send must not run');
};
const wa = {
  getStatus: () => ({ state, hasCreds: true }),
  getSocket: () => {
    if (state !== 'open') throw new Error('drafts must not open the socket while disconnected');
    return {
      sendMessage: async (jid, content) => {
        calls.push(jid);
        return sendImpl(jid, content);
      },
      onWhatsApp: async () => {
        throw new Error('drafts must not look up a number');
      },
    };
  },
  getStore: () => store,
  resolveJid: async (chat) => {
    if (!String(chat).includes('@')) throw new Error('a group JID must not be rewritten');
    return chat;
  },
  getAccount: () => ({}),
  start: async () => {},
};
const app = createMcpExpressApp({ host: '127.0.0.1' });
const handler = toNodeHandler(createMcpHandler(() => createMcpServer(wa, {
  role: 'test',
  allowSend,
  allowDelete: false,
})));
app.all('/mcp', (req, res) => { void handler(req, res, req.body); });
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/mcp`;

async function call(name, args) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const json = body.startsWith('event:')
    ? JSON.parse(body.split('\n').find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(body);
  return json.result;
}

function payload(result) {
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text);
}

try {
  const blank = await call('whatsapp_create_draft', { chat: group, text: ' ' });
  assert.equal(blank.isError, true);
  assert.match(blank.content[0].text, /1 to 4096/);
  assert.equal(calls.length, 0);

  const created = payload(await call('whatsapp_create_draft', {
    chat: group,
    text: `  ${marker}  `,
    sendAt: 1_600_000_000,
  }));
  assert.equal(created.jid, group);
  assert.equal(created.sendAt, 1_600_000_000);
  assert.match(created.id, /^[a-f0-9]{32}$/);
  assert.equal(Object.hasOwn(created, 'text'), false);
  assert.equal(calls.length, 0);

  const listed = payload(await call('whatsapp_list_drafts', {}));
  assert.equal(listed.drafts.length, 1);
  assert.equal(listed.drafts[0].id, created.id);
  assert.equal(listed.drafts[0].text, marker);
  assert.equal(JSON.stringify(listed).includes('@s.whatsapp.net'), false);

  const blocked = await call('whatsapp_send_draft', { id: created.id });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /ALLOW_SEND=false/);
  assert.equal(calls.length, 0);
  assert.equal(payload(await call('whatsapp_list_drafts', {})).drafts.length, 1);

  const cancelled = payload(await call('whatsapp_cancel_draft', { id: created.id }));
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(payload(await call('whatsapp_list_drafts', {})).drafts, []);
  const missingWhileDisabled = await call('whatsapp_send_draft', { id: 'a'.repeat(32) });
  assert.equal(missingWhileDisabled.isError, true);
  assert.match(missingWhileDisabled.content[0].text, /ALLOW_SEND=false/);
  assert.equal(missingWhileDisabled.content[0].text.includes(marker), false);
  assert.equal(calls.length, 0);

  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    ids.push(payload(await call('whatsapp_create_draft', { chat: group, text: marker })).id);
  }
  const page = payload(await call('whatsapp_list_drafts', { limit: 2 }));
  assert.equal(page.drafts.length, 2);
  assert.equal(page.nextOffset, 2);
  const rest = payload(await call('whatsapp_list_drafts', { limit: 2, offset: 2 }));
  assert.equal(rest.nextOffset, undefined);
  assert.deepEqual([...page.drafts, ...rest.drafts].map((item) => item.id).sort(), ids.slice().sort());
  for (const id of ids) payload(await call('whatsapp_cancel_draft', { id }));

  allowSend = true;
  const waiting = payload(await call('whatsapp_create_draft', { chat: group, text: marker, sendAt: 1_600_000_000 }));
  const offline = await call('whatsapp_send_draft', { id: waiting.id });
  assert.equal(offline.isError, true);
  assert.match(offline.content[0].text, /not connected/);
  assert.equal(calls.length, 0);
  assert.equal(payload(await call('whatsapp_list_drafts', {})).drafts[0].id, waiting.id);

  state = 'open';
  allowSend = false;
  const stillBlocked = await call('whatsapp_send_draft', { id: waiting.id });
  assert.equal(stillBlocked.isError, true);
  assert.match(stillBlocked.content[0].text, /ALLOW_SEND=false/);
  assert.equal(calls.length, 0);

  allowSend = true;
  sendImpl = async () => {
    throw new Error(marker);
  };
  const hidden = await call('whatsapp_send_draft', { id: waiting.id });
  assert.equal(hidden.isError, true);
  assert.match(hidden.content[0].text, /Could not send the draft/);
  assert.equal(hidden.content[0].text.includes(marker), false);
  assert.equal(payload(await call('whatsapp_list_drafts', {})).drafts.length, 1);

  sendImpl = async () => {
    throw new Error('socket down');
  };
  const failed = await call('whatsapp_send_draft', { id: waiting.id });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /socket down/);
  assert.equal(payload(await call('whatsapp_list_drafts', {})).drafts[0].id, waiting.id);

  sendImpl = async () => undefined;
  const rejected = await call('whatsapp_send_draft', { id: waiting.id });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /did not accept/);
  assert.equal(payload(await call('whatsapp_list_drafts', {})).drafts[0].id, waiting.id);

  sendImpl = async (jid, content) => ({
    key: { remoteJid: jid, id: 'sent-1', fromMe: true },
    message: { conversation: content.text },
    messageTimestamp: 1_700_000_111,
  });
  const sent = payload(await call('whatsapp_send_draft', { id: waiting.id }));
  assert.equal(sent.ok, true);
  assert.equal(sent.id, waiting.id);
  assert.equal(sent.jid, group);
  assert.equal(sent.messageId, 'sent-1');
  assert.equal(JSON.stringify(sent).includes(marker), false);
  assert.deepEqual(payload(await call('whatsapp_list_drafts', {})).drafts, []);
  const saved = store.listMessages(group, 10).messages.find((message) => message.id === 'sent-1');
  assert.equal(saved?.fromMe, true);
  assert.equal(saved?.text, marker);
  const again = await call('whatsapp_send_draft', { id: waiting.id });
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /Draft not found/);

  const raced = payload(await call('whatsapp_create_draft', { chat: group, text: marker }));
  let release = () => {};
  sendImpl = (jid, content) => new Promise((resolve) => {
    release = () => resolve({
      key: { remoteJid: jid, id: 'sent-race', fromMe: true },
      message: { conversation: content.text },
      messageTimestamp: 1_700_000_222,
    });
  });
  const callsBefore = calls.length;
  const first = call('whatsapp_send_draft', { id: raced.id });
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (calls.length === callsBefore + 1) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 1000) {
        clearInterval(timer);
        reject(new Error('draft send did not reach WhatsApp'));
      }
    }, 5);
  });
  const second = call('whatsapp_send_draft', { id: raced.id });
  const third = call('whatsapp_cancel_draft', { id: raced.id });
  const held = await Promise.all([second, third]);
  assert.equal(held.every((item) => item.isError === true && /already being sent/.test(item.content[0].text)), true);
  release();
  const [one, two, three] = await Promise.all([first, second, third]);
  const outcomes = [one, two, three];
  assert.equal(outcomes.filter((item) => item.isError !== true && JSON.parse(item.content[0].text).ok === true).length, 1);
  assert.equal(outcomes.filter((item) => item.isError === true && /already being sent/.test(item.content[0].text)).length, 2);
  assert.deepEqual(payload(await call('whatsapp_list_drafts', {})).drafts, []);
  assert.equal(calls.length, callsBefore + 1);

  // Background sender-key maintenance must never send overdue drafts, even
  // with a connected socket and sending enabled. Check behavior across its tick.
  const idleDraft = payload(await call('whatsapp_create_draft', { chat: group, text: marker, sendAt: 1_600_000_000 }));
  const idleCalls = calls.length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(calls.length, idleCalls);
  assert.equal(payload(await call('whatsapp_list_drafts', {})).drafts[0].id, idleDraft.id);
  payload(await call('whatsapp_cancel_draft', { id: idleDraft.id }));
  console.log('PASS: drafts persist, never send on their own, and send only from an explicit allowed call');
} finally {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  await rm(dir, { recursive: true, force: true });
}
