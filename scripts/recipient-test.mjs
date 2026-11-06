// Regression: a bare phone number must only ever send to that person's direct chat.
// Incident class: a message intended for a direct chat was reported in a group.
// Call logs showed to= length 23 (a group JID) rather than an 11-digit phone.
// These checks pin the resolve guard, and classifyRecipient so call logs cannot confuse the two.
// Fixtures below are fictional. 15555550100 is a reserved example number.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { assertPhoneStaysDirect, barePhoneDigits, classifyRecipient, phoneJidFrom, resolveSendJid } from '../dist/recipient.js';
import { parseRecipient } from '../dist/david/resolve.js';
import { DavidRuntime } from '../dist/david/runtime.js';
import { createMcpServer } from '../dist/mcp-tools.js';
import { MemoryStore } from '../dist/store.js';

const BEN = '15555550100';
const BEN_PN = `${BEN}@s.whatsapp.net`;
const BEN_LID = '199999999990001@lid';
const GROUP = '120363000000000099@g.us';

// 1. Pure helpers.
assert.equal(barePhoneDigits(BEN), BEN);
assert.equal(barePhoneDigits(`+${BEN}`), BEN);
assert.equal(barePhoneDigits('+1 (555) 555-0100'), BEN);
assert.equal(barePhoneDigits('12345'), null);
assert.equal(barePhoneDigits(GROUP), null);
assert.equal(phoneJidFrom(`${BEN}:12@s.whatsapp.net`), BEN_PN);
assert.equal(phoneJidFrom(GROUP), null);
assert.equal(phoneJidFrom(BEN_LID), null);
assert.equal(assertPhoneStaysDirect(BEN, BEN_PN), BEN_PN);
assert.equal(assertPhoneStaysDirect(GROUP, GROUP), GROUP, 'explicit group JIDs pass');
assert.throws(() => assertPhoneStaysDirect(BEN, GROUP), /not a direct chat/);
assert.throws(() => assertPhoneStaysDirect(`+${BEN}`, GROUP), /not a direct chat/);
assert.throws(() => assertPhoneStaysDirect(BEN, BEN_LID), /not a direct chat/);
assert.throws(() => assertPhoneStaysDirect(BEN, '123@s.whatsapp.net'), /not a direct chat/);

// Oct 30 incident fingerprint: 11-char phone vs 23-char group JID.
assert.equal(BEN.length, 11);
assert.equal(GROUP.length, 23);
assert.equal(classifyRecipient(BEN).kind, 'bare_phone');
assert.equal(classifyRecipient(`+${BEN}`).kind, 'bare_phone');
assert.equal(classifyRecipient(BEN_PN).kind, 'phone_jid');
assert.equal(classifyRecipient(BEN_LID).kind, 'lid');
assert.equal(classifyRecipient(GROUP).kind, 'group');
assert.equal(classifyRecipient('not-a-recipient').kind, 'other');

const parsed = parseRecipient(BEN);
assert.equal(parsed.kind, 'pn');
assert.equal(parsed.jid, BEN_PN);

// 2. Personal path (no David resolver).
const lookups = [];
const answers = {
  direct: async (jid) => { lookups.push(jid); return [{ exists: true, jid }]; },
  device: async (jid) => { lookups.push(jid); return [{ exists: true, jid: `${BEN}:7@s.whatsapp.net` }]; },
  group: async (jid) => { lookups.push(jid); return [{ exists: true, jid: GROUP }]; },
  lid: async (jid) => { lookups.push(jid); return [{ exists: true, jid: BEN_LID }]; },
  missing: async (jid) => { lookups.push(jid); return [{ exists: false, jid }]; },
};
assert.equal(await resolveSendJid(BEN, answers.direct), BEN_PN);
assert.equal(lookups.at(-1), BEN_PN, 'lookup is for the phone JID of those digits');
assert.equal(await resolveSendJid(`+${BEN}`, answers.device), BEN_PN);
assert.equal(await resolveSendJid(BEN, answers.missing), BEN_PN);
await assert.rejects(resolveSendJid(BEN, answers.group), /not a direct chat/);
await assert.rejects(resolveSendJid(BEN, answers.lid), /not a direct chat/);
await assert.rejects(resolveSendJid('123', answers.direct), /country code/);
await assert.rejects(resolveSendJid(BEN, null), /not connected/);
assert.equal(await resolveSendJid(GROUP, answers.group), GROUP);

// 3. MCP send tools: a resolver that returns a group for a bare phone is refused before any send.
const dir = await mkdtemp(path.join(tmpdir(), 'recipient-'));
const store = new MemoryStore(path.join(dir, 'history.sqlite'));
store.upsertChat({ id: GROUP, name: 'Example group', conversationTimestamp: 100 });
store.upsertChat({ id: BEN_PN, name: 'Example Person', conversationTimestamp: 50 });
const sends = [];
const socket = {
  user: { id: '5210000000000@s.whatsapp.net' },
  sendMessage: async (jid, content) => {
    sends.push(jid);
    return { key: { remoteJid: jid, id: `sent-${sends.length}`, fromMe: true }, message: { conversation: content.text ?? '' }, messageTimestamp: 200 };
  },
};
let personalResolve = async (to) => resolveSendJid(to, answers.direct);
const wa = {
  getStatus: () => ({ state: 'open', hasCreds: true }),
  getSocket: () => socket,
  getStore: () => store,
  resolveJid: (to) => personalResolve(to),
  getAccount: () => ({}),
};
const paced = [];
let davidResolve = async () => GROUP;

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
      const body = await response.text();
      const result = (body.startsWith('event:') ? JSON.parse(body.split('\n').find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body)).result;
      let json = null;
      try { json = JSON.parse(result.content[0].text); } catch { json = null; }
      return { ...result, json, text: result.content[0].text };
    },
  };
}

const personal = await serve({ role: 'personal', allowSend: true, allowDelete: false });
const david = await serve({
  role: 'david', allowSend: true, allowDelete: false,
  pacedSend: async (input) => { paced.push(input.jid); return { ok: true, messageId: `paced-${paced.length}` }; },
  resolveRecipient: (to, purpose) => davidResolve(to, purpose),
});
try {
  // Exact Oct 25 case on David: bare digits, resolver misbehaves and answers with the group.
  let result = await david.call('whatsapp_send_text', { to: BEN, text: 'briefing' });
  assert.equal(result.isError, true);
  assert.match(result.text, /not a direct chat/);
  assert.equal(paced.length, 0, 'nothing was queued');
  result = await david.call('whatsapp_send_text', { to: `+${BEN}`, text: 'briefing' });
  assert.equal(result.isError, true);
  assert.equal(paced.length, 0);

  // Correct resolver: DM goes to Ben's phone JID and the result echoes what was asked.
  davidResolve = async (to) => (to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`);
  result = await david.call('whatsapp_send_text', { to: BEN, text: 'briefing' });
  assert.equal(result.isError, undefined);
  assert.equal(result.json.jid, BEN_PN);
  assert.equal(result.json.requestedTo, BEN);
  assert.deepEqual(paced, [BEN_PN]);

  // An explicit group JID still sends to the group.
  result = await david.call('whatsapp_send_text', { to: GROUP, text: 'team note' });
  assert.equal(result.isError, undefined);
  assert.equal(result.json.jid, GROUP);
  assert.deepEqual(paced, [BEN_PN, GROUP]);

  // Drafts follow the same rule.
  davidResolve = async () => GROUP;
  result = await david.call('whatsapp_create_draft', { chat: BEN, text: 'later' });
  assert.equal(result.isError, true);
  assert.match(result.text, /not a direct chat/);
  assert.equal(store.listDrafts().drafts.length, 0);

  // Personal path: lookup that answers with a group never sends.
  personalResolve = async (to) => resolveSendJid(to, answers.group);
  result = await personal.call('whatsapp_send_text', { to: BEN, text: 'hi' });
  assert.equal(result.isError, true);
  assert.equal(sends.length, 0);
  // A raw resolveJid that returns a group for digits is also caught at the tool layer.
  personalResolve = async () => GROUP;
  result = await personal.call('whatsapp_send_text', { to: BEN, text: 'hi' });
  assert.equal(result.isError, true);
  assert.equal(sends.length, 0);
  personalResolve = async (to) => resolveSendJid(to, answers.direct);
  result = await personal.call('whatsapp_send_text', { to: BEN, text: 'hi' });
  assert.equal(result.isError, undefined);
  assert.equal(result.json.jid, BEN_PN);
  assert.equal(result.json.requestedTo, BEN);
  assert.deepEqual(sends, [BEN_PN]);

  // Dry-run resolve: same guard, no send.
  const beforeSends = sends.length;
  const beforePaced = paced.length;
  davidResolve = async (to) => (to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`);
  result = await david.call('whatsapp_resolve_recipient', { to: BEN });
  assert.equal(result.isError, undefined);
  assert.equal(result.json.kind, 'bare_phone');
  assert.equal(result.json.jid, BEN_PN);
  assert.equal(result.json.requestedTo, BEN);
  davidResolve = async () => GROUP;
  result = await david.call('whatsapp_resolve_recipient', { to: BEN });
  assert.equal(result.isError, true);
  assert.match(result.text, /not a direct chat/);
  result = await david.call('whatsapp_resolve_recipient', { to: GROUP });
  assert.equal(result.isError, undefined);
  assert.equal(result.json.kind, 'group');
  assert.equal(result.json.jid, GROUP);
  assert.equal(sends.length, beforeSends);
  assert.equal(paced.length, beforePaced);

  // MCP call log records toKind so Oct 30 forensics do not rely on length alone.
  const summaries = store.listMcpCalls(30).map((row) => row.argsSummary);
  assert.ok(summaries.some((s) => s.includes('toKind=bare_phone')), `expected bare_phone in ${JSON.stringify(summaries.slice(0, 5))}`);
  assert.ok(summaries.some((s) => s.includes('toKind=group')), `expected group in ${JSON.stringify(summaries.slice(0, 5))}`);
} finally {
  await new Promise((resolve) => personal.server.close(resolve));
  await new Promise((resolve) => david.server.close(resolve));
}

// 4. David runtime: a bare phone resolves to that direct chat even when a group is the most recent chat
// and the lookup cache is poisoned with a group JID.
{
  const rdir = await mkdtemp(path.join(tmpdir(), 'recipient-david-'));
  const history = new MemoryStore(path.join(rdir, 'history.sqlite'));
  history.upsertChat({ id: GROUP, name: 'Example group', conversationTimestamp: 999 });
  history.upsertMessage({ key: { remoteJid: GROUP, id: 'g1', fromMe: false, participant: BEN_LID }, messageTimestamp: 999, message: { conversation: 'hi' } });
  history.linkJids(BEN_PN, BEN_LID);
  const sock = {
    onWhatsApp: async (jid) => [{ exists: true, jid: String(jid) }],
    signalRepository: { lidMapping: { getPNForLID: async (lid) => (lid === BEN_LID ? BEN_PN : null) } },
  };
  const rwa = {
    getStatus: () => ({ state: 'open' }),
    getSocket: () => sock,
    getStore: () => history,
    getAccount: () => ({ id: '5210000000000@s.whatsapp.net' }),
  };
  const runtime = new DavidRuntime({
    role: 'david', ownerPhone: BEN, aibmGroupJid: '', secretaryUrl: '', secretaryKey: '', sweUrl: '', sweKey: '',
    fallbackAfterMinutes: 30, callbackPublicBase: '', callbackSecret: 'callback-secret-test', timezone: 'America/Mexico_City',
    escalationBatchMs: 0, groupAll: false, contextMessages: 10, typingMinMs: 0, typingMaxMs: 0, typingMsPerChar: 0,
    chatGapMs: 0, sendPerMinute: 100, sendPerHour: 1000, sendMaxWaitMs: 0,
  }, rwa, path.join(rdir, 'david.sqlite'), {
    now: () => new Date('2026-10-25T14:20:00.000Z'),
    log: () => {},
    send: async () => ({ ok: true, messageId: 'x' }),
    delay: async () => {},
    random: () => 0,
    markRead: async () => {},
    presence: async () => {},
  });
  try {
    for (const purpose of ['send', 'draft']) {
      assert.equal(await runtime.resolveOutboundJid(BEN, purpose), BEN_PN);
      assert.equal(await runtime.resolveOutboundJid(`+${BEN}`, purpose), BEN_PN);
      assert.equal(await runtime.resolveOutboundJid(BEN_LID, purpose), BEN_PN);
      assert.equal(await runtime.resolveOutboundJid(GROUP, purpose), GROUP);
    }
    // Poisoned cache row: approved number whose cached lookup claims a group.
    const cold = '5215550109999';
    runtime.store.addApproved({
      jid: `${cold}@s.whatsapp.net`, phone: cold, displayName: '', note: 't', addedBy: 'owner',
      addedAt: '2026-10-25T14:00:00.000Z', lid: null, day: '2026-10-25',
    });
    runtime.store.saveWhatsAppLookup(cold, GROUP, true, '2026-10-25T14:19:00.000Z');
    assert.equal(await runtime.resolveOutboundJid(cold, 'send'), `${cold}@s.whatsapp.net`);
  } finally {
    await runtime.stop();
    runtime.store.close();
    history.close();
    await rm(rdir, { recursive: true, force: true });
  }
}

store.close();
await rm(dir, { recursive: true, force: true });
console.log('recipient-test ok');
