import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { localDay, readColdPerDay } from '../dist/david/approved.js';
import { DavidRuntime } from '../dist/david/runtime.js';
import { DavidStore, WHATSAPP_LOOKUP_TTL_MS } from '../dist/david/store.js';
import { parseRecipient } from '../dist/david/resolve.js';
import { rejectProxiedInternal } from '../dist/internal-guard.js';
import { internalHostname, lookupLidOnSession, mountLidPn } from '../dist/lid-pn.js';
import { createMcpServer } from '../dist/mcp-tools.js';
import { MemoryStore } from '../dist/store.js';

const OWNER = '15555550123';
const PHONE = '5215550102030';
const PN = `${PHONE}@s.whatsapp.net`;
const LID = '199999999990002@lid';
const OTHER_LID = '199999999990003@lid';
const SECRET = 'david-read-secret-for-tests-0123456789';

assert.equal(parseRecipient('+52 155 5010 2030').jid, PN);
assert.equal(parseRecipient(`${PHONE}@c.us`).jid, PN);
assert.equal(parseRecipient(LID).lid, LID);
assert.equal(parseRecipient('120363000000000099@g.us').kind, 'group');
assert.equal(parseRecipient('nope').ok, false);
assert.equal(readColdPerDay(null), 5);
assert.equal(readColdPerDay('0'), 0);
assert.equal(readColdPerDay('nope'), 5);
assert.equal(localDay(new Date('2026-10-16T18:00:00.000Z'), 'America/Mexico_City'), '2026-10-16');
assert.equal(localDay(new Date('2026-10-17T06:00:00.000Z'), 'America/Mexico_City'), '2026-10-17');
assert.equal(internalHostname('personal'), true);
assert.equal(internalHostname('localhost'), true);
assert.equal(internalHostname('127.0.0.1'), true);
assert.equal(internalHostname('::1'), true);
assert.equal(internalHostname('david'), false);
assert.equal(internalHostname('wa.example.com'), false);

function config(overrides = {}) {
  return {
    role: 'david',
    ownerPhone: OWNER,
    aibmGroupJid: '',
    secretaryUrl: '',
    secretaryKey: '',
    sweUrl: '',
    sweKey: '',
    fallbackAfterMinutes: 30,
    callbackPublicBase: '',
    callbackSecret: 'callback-secret-test',
    timezone: 'America/Mexico_City',
    escalationBatchMs: 0,
    groupAll: false,
    contextMessages: 10,
    typingMinMs: 0,
    typingMaxMs: 0,
    typingMsPerChar: 0,
    chatGapMs: 0,
    sendPerMinute: 100,
    sendPerHour: 1000,
    sendMaxWaitMs: 0,
    ...overrides,
  };
}

async function withRuntime(overrides, setup, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'approved-'));
  const history = new MemoryStore(path.join(dir, 'history.sqlite'));
  const sent = [];
  const logs = [];
  const delays = [];
  const reads = [];
  const presence = [];
  const onWhatsApp = [];
  const personal = [];
  let nowMs = Date.parse('2026-10-16T18:00:00.000Z');
  let open = true;
  const mapping = setup.mapping ?? {};
  const sock = {
    onWhatsApp: async (jid) => {
      onWhatsApp.push(String(jid));
      if (setup.missing?.has(String(jid).split('@')[0])) return [{ jid: String(jid), exists: false }];
      const canonical = String(jid).includes('@') ? String(jid).split(':')[0] : `${jid}@s.whatsapp.net`;
      return [{ jid: canonical.endsWith('@s.whatsapp.net') ? canonical : `${canonical.split('@')[0]}@s.whatsapp.net`, exists: true }];
    },
    signalRepository: {
      lidMapping: {
        getPNForLID: async (lid) => mapping[lid] ?? null,
      },
    },
  };
  const wa = {
    getStatus: () => ({ state: open ? 'open' : 'disconnected' }),
    getSocket: () => (open ? sock : null),
    getStore: () => history,
    getAccount: () => ({ id: '5210000000000@s.whatsapp.net' }),
  };
  const runtime = new DavidRuntime(config(overrides), wa, path.join(dir, 'david.sqlite'), {
    now: () => new Date(nowMs),
    log: (line) => logs.push(line),
    send: async (jid, text, options) => {
      sent.push({ jid, text, replyTo: options?.replyTo ?? null });
      return { ok: true, messageId: `m${sent.length}` };
    },
    delay: async (ms) => { delays.push(ms); },
    random: () => 0,
    markRead: async (jid, id) => { reads.push({ jid, id }); },
    presence: async (jid, state) => { presence.push({ jid, state }); },
    personalLid: {
      url: 'http://personal:8787',
      secret: SECRET,
      fetch: async (url, init) => {
        personal.push({ url: String(url), authorization: init?.headers?.Authorization ?? '' });
        const lid = new URL(String(url)).searchParams.get('lid');
        const pn = setup.personal?.[lid];
        if (!pn) return new Response(JSON.stringify({ error: 'Unknown LID' }), { status: 404 });
        return new Response(JSON.stringify({ pn }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    },
  });
  try {
    await fn({
      runtime, history, sent, logs, delays, reads, presence, onWhatsApp, personal, dir,
      setOpen(value) { open = value; },
      advance(ms) { nowMs += ms; },
    });
  } finally {
    await runtime.stop();
    runtime.store.close();
    history.close();
    await rm(dir, { recursive: true, force: true });
  }
}

await withRuntime({
  typingMinMs: 2000,
  typingMaxMs: 12000,
  typingMsPerChar: 40,
  chatGapMs: 0,
  sendPerMinute: 100,
  sendMaxWaitMs: 60_000,
}, { mapping: { [LID]: PN } }, async ({ runtime, sent, logs, delays, reads, presence }) => {
  runtime.store.setSetting('approved.cold_per_day', '1');
  runtime.store.addApproved({
    jid: PN, phone: PHONE, displayName: 'Ada', note: 'intro', addedBy: 'ben',
    addedAt: '2026-10-16T18:00:00.000Z', lid: LID, day: '2026-10-16',
  });
  const cold = await runtime.sendOutbound({ jid: PN, text: '¡Hola!', replyTo: 'quoted-1' });
  assert.equal(cold.ok, true);
  assert.equal(sent[0].text, 'Hola!');
  assert.equal(sent[0].jid, PN);
  assert.deepEqual(reads, [{ jid: PN, id: 'quoted-1' }]);
  assert.deepEqual(presence.map((item) => item.state), ['composing', 'paused']);
  assert.ok(delays.some((ms) => ms >= 2000 && ms <= 12_000));
  assert.ok(logs.some((line) => line.includes(`approved=cold_send jid=${PN} phone=${PHONE}`)));
  assert.equal(runtime.store.countColdSends('2026-10-16'), 1);
  const capped = await runtime.sendOutbound({ jid: LID, text: 'again' });
  assert.equal(capped.ok, false);
  assert.equal(capped.error, 'cold_cap');
  assert.equal(sent.length, 1);
  assert.equal(runtime.store.countColdSends('2026-10-16'), 1);
  const stranger = await runtime.sendOutbound({ jid: '15555550999@s.whatsapp.net', text: 'no' });
  assert.equal(stranger.error, 'cold_contact');
  const group = await runtime.sendOutbound({ jid: '120363000000000099@g.us', text: 'no' });
  assert.equal(group.error, 'cold_contact');
});

await withRuntime({ sendPerMinute: 1, sendMaxWaitMs: 0 }, {}, async ({ runtime, sent }) => {
  runtime.store.setSetting('approved.cold_per_day', '5');
  runtime.store.addApproved({
    jid: PN, phone: PHONE, displayName: '', note: 'cap', addedBy: 'ben',
    addedAt: '2026-10-16T18:00:00.000Z', lid: null, day: '2026-10-16',
  });
  assert.equal((await runtime.sendOutbound({ jid: PN, text: 'one' })).ok, true);
  const limited = await runtime.sendOutbound({ jid: PN, text: 'two' });
  assert.equal(limited.error, 'rate_limited');
  assert.equal(sent.length, 1);
  assert.equal(runtime.store.countColdSends('2026-10-16'), 1);
});

await withRuntime({}, {}, async ({ runtime, history, sent, advance }) => {
  history.upsertMessage({
    key: { remoteJid: PN, id: 'heard-1', fromMe: false },
    messageTimestamp: 1_700_000_000,
    message: { conversation: 'hi' },
  });
  runtime.store.setSetting('approved.cold_per_day', '0');
  runtime.store.addApproved({
    jid: PN, phone: PHONE, displayName: 'Ada', note: 'known', addedBy: 'ben',
    addedAt: '2026-10-16T18:00:00.000Z', lid: LID, day: '2026-10-16',
  });
  history.linkJids(PN, LID);
  const warm = await runtime.sendOutbound({ jid: LID, text: 'reply' });
  assert.equal(warm.ok, true);
  assert.equal(runtime.store.countColdSends('2026-10-16'), 0);
  assert.equal(sent.at(-1).jid, LID);
  advance(12 * 60 * 60 * 1000);
  assert.equal(runtime.store.countColdSends('2026-10-17'), 0);
});

await withRuntime({}, {
  mapping: { [LID]: PN },
  personal: { [OTHER_LID]: '5215550102031@s.whatsapp.net' },
}, async ({ runtime, history, onWhatsApp, personal, logs, setOpen }) => {
  const added = await runtime.actions().approvedAdd({
    identifier: LID,
    display_name: 'Ada',
    approved_by: 'ben',
    reason: 'intro from the lid',
  });
  assert.equal(added.ok, true);
  assert.equal(added.contact.jid, PN);
  assert.equal(added.contact.lid, LID);
  assert.equal(onWhatsApp.length, 0);
  assert.equal(personal.length, 0);
  assert.equal(history.phoneForJid(LID), PHONE);
  assert.ok(logs.some((line) => line.includes(`approved=add jid=${PN}`)));
  const again = await runtime.actions().approvedAdd({
    identifier: `+${PHONE}`,
    approved_by: 'ben',
    reason: 'again',
  });
  assert.equal(again.ok, false);
  assert.match(again.error, /already approved/);

  const remote = await runtime.actions().approvedAdd({
    identifier: OTHER_LID,
    approved_by: 'ben',
    reason: 'personal mapping',
  });
  assert.equal(remote.ok, true);
  assert.equal(remote.contact.jid, '5215550102031@s.whatsapp.net');
  assert.equal(personal.length, 1);
  assert.equal(personal[0].authorization, `Bearer ${SECRET}`);
  assert.match(personal[0].url, /199999999990003(?:@|%40)lid/);
  assert.equal(personal[0].url.startsWith('http://personal:8787/internal/lid-pn'), true);

  const missing = await runtime.actions().approvedAdd({
    identifier: '199999999999999@lid',
    approved_by: 'ben',
    reason: 'unknown',
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Could not resolve 199999999999999@lid/);
  assert.equal(runtime.store.findApproved('199999999999999@lid'), null);
});

await withRuntime({}, { missing: new Set(['19999999999']) }, async ({ runtime, onWhatsApp }) => {
  const notOnWhatsApp = await runtime.actions().approvedAdd({
    identifier: '19999999999',
    approved_by: 'ben',
    reason: 'absent',
  });
  assert.equal(notOnWhatsApp.error, 'That number is not on WhatsApp.');
  assert.equal(onWhatsApp.length, 1);
  const again = await runtime.actions().approvedAdd({
    identifier: '+19999999999',
    approved_by: 'ben',
    reason: 'again',
  });
  assert.equal(again.error, 'That number is not on WhatsApp.');
  assert.equal(onWhatsApp.length, 1);
});

await withRuntime({}, { mapping: { [LID]: PN } }, async ({ runtime, history, sent, onWhatsApp, setOpen }) => {
  history.linkJids(PN, LID);
  setOpen(false);
  const draftJid = await runtime.resolveOutboundJid(LID, 'draft');
  assert.equal(draftJid, PN);
  assert.equal(onWhatsApp.length, 0);
  const offline = await runtime.actions().approvedAdd({
    identifier: LID, approved_by: 'ben', reason: 'mapped while disconnected',
  });
  assert.equal(offline.ok, true);
  assert.equal(onWhatsApp.length, 0);
  const unseenOffline = await runtime.actions().approvedAdd({
    identifier: '19995550109', approved_by: 'ben', reason: 'new while disconnected',
  });
  assert.equal(unseenOffline.error, 'WhatsApp is not connected, so this number cannot be checked.');
  setOpen(true);
  const phoneDraft = await runtime.resolveOutboundJid('+5215550102030', 'draft');
  assert.equal(phoneDraft, PN);
  assert.equal(onWhatsApp.length, 0);

  const toLid = await runtime.sendOutbound({ jid: LID, text: 'via lid' });
  const toPn = await runtime.sendOutbound({ jid: PN, text: 'via pn' });
  assert.equal(toLid.ok, true);
  assert.equal(toPn.ok, true);
  assert.equal(sent.filter((item) => item.jid === LID || item.jid === PN).length, 2);
  assert.equal(onWhatsApp.length, 0);
  runtime.store.setSetting('approved.cold_per_day', '2');
  const third = await runtime.sendOutbound({ jid: PN, text: 'over' });
  assert.equal(third.error, 'cold_cap');
});

const BEN_LID = '199999999990001@lid';
const BEN_PN = '15555550177@s.whatsapp.net';
await withRuntime({}, { mapping: { [BEN_LID]: BEN_PN } }, async ({ runtime, history, onWhatsApp }) => {
  const fromLid = await runtime.resolveOutboundJid(BEN_LID, 'send');
  assert.equal(fromLid, BEN_PN);
  assert.equal(onWhatsApp.length, 0);
  history.upsertChat({ id: BEN_PN, conversationTimestamp: 1 });
  const fromPhone = await runtime.resolveOutboundJid(BEN_PN, 'send');
  assert.equal(fromPhone, BEN_PN);
  const draft = await runtime.resolveOutboundJid('+19995550100', 'draft');
  assert.equal(draft, '19995550100@s.whatsapp.net');
  const stranger = await runtime.resolveOutboundJid('19995550100', 'send');
  assert.equal(stranger, '19995550100@s.whatsapp.net');
  assert.equal(onWhatsApp.length, 0);
});

await withRuntime({}, {}, async ({ runtime, onWhatsApp, advance }) => {
  const fresh = '19995550101';
  runtime.store.addApproved({
    jid: `${fresh}@s.whatsapp.net`, phone: fresh, displayName: '', note: 'cold', addedBy: 'ben',
    addedAt: '2026-10-16T18:00:00.000Z', lid: null, day: '2026-10-16',
  });
  const cold = await runtime.resolveOutboundJid(fresh, 'send');
  assert.equal(cold, `${fresh}@s.whatsapp.net`);
  assert.equal(onWhatsApp.length, 1);
  const cached = await runtime.resolveOutboundJid(`+${fresh}`, 'send');
  assert.equal(cached, `${fresh}@s.whatsapp.net`);
  assert.equal(onWhatsApp.length, 1);
  advance(WHATSAPP_LOOKUP_TTL_MS);
  const expired = await runtime.resolveOutboundJid(fresh, 'send');
  assert.equal(expired, `${fresh}@s.whatsapp.net`);
  assert.equal(onWhatsApp.length, 2);

  const added = await runtime.actions().approvedAdd({
    identifier: '+19995550102', approved_by: 'ben', reason: 'first add',
  });
  assert.equal(added.ok, true);
  assert.equal(onWhatsApp.length, 3);
  await runtime.resolveOutboundJid('19995550102', 'send');
  assert.equal(onWhatsApp.length, 3);
});

await withRuntime({ sendPerMinute: 100 }, { mapping: { [LID]: PN } }, async ({ runtime, sent, dir }) => {
  const drafts = new MemoryStore(path.join(dir, 'drafts.sqlite'));
  const wa = {
    getStatus: () => ({ state: 'open' }),
    getSocket: () => ({ sendMessage: async () => { throw new Error('must use paced send'); } }),
    getStore: () => drafts,
    resolveJid: async () => { throw new Error('david must use resolveRecipient'); },
    getAccount: () => ({}),
    getWebhookStatus: () => ({ enabled: false }),
    start: async () => {},
  };
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  const personal = createMcpServer(wa, { role: 'personal', allowSend: true, allowDelete: false });
  const david = createMcpServer(wa, {
    role: 'david',
    allowSend: true,
    allowDelete: false,
    david: runtime.actions(),
    pacedSend: (input) => runtime.sendOutbound(input),
    resolveRecipient: (to, purpose) => runtime.resolveOutboundJid(to, purpose),
  });
  const personalHandler = toNodeHandler(createMcpHandler(() => personal));
  const davidHandler = toNodeHandler(createMcpHandler(() => david));
  app.all('/personal', (req, res) => { void personalHandler(req, res, req.body); });
  app.all('/david', (req, res) => { void davidHandler(req, res, req.body); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(pathname, name, args) {
    const response = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    assert.equal(response.status, 200);
    return rpc(await response.text());
  }
  try {
    const personalList = rpc(await (await fetch(`${base}/personal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })).text()).tools.map((tool) => tool.name);
    assert.equal(personalList.length, 23);
    assert.equal(personalList.includes('whatsapp_approved_contacts_add'), false);
    const davidList = rpc(await (await fetch(`${base}/david`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })).text()).tools.map((tool) => tool.name);
    assert.equal(davidList.includes('whatsapp_approved_contacts_list'), true);
    assert.equal(davidList.includes('whatsapp_approved_contacts_add'), true);
    assert.equal(davidList.includes('whatsapp_approved_contacts_remove'), true);

    const missingBy = await call('/david', 'whatsapp_approved_contacts_add', { identifier: LID, reason: 'x' });
    assert.equal(missingBy.isError, true);
    assert.match(missingBy.content[0].text, /approved_by/);
    const missingReason = await call('/david', 'whatsapp_approved_contacts_add', { identifier: LID, approved_by: 'ben' });
    assert.equal(missingReason.isError, true);
    assert.match(missingReason.content[0].text, /reason/);

    const added = JSON.parse((await call('/david', 'whatsapp_approved_contacts_add', {
      identifier: LID, display_name: 'Ada', approved_by: 'ben', reason: 'first message',
    })).content[0].text);
    assert.equal(added.contact.jid, PN);
    const listed = JSON.parse((await call('/david', 'whatsapp_approved_contacts_list', {})).content[0].text);
    assert.equal(listed.cold_per_day, 5);
    assert.equal(listed.contacts[0].jid, PN);
    assert.equal(listed.contacts[0].added_by, 'ben');

    const sentText = await call('/david', 'whatsapp_send_text', { to: LID, text: '¡Listo!' });
    assert.equal(sentText.isError, undefined);
    assert.equal(JSON.parse(sentText.content[0].text).jid, PN);
    assert.equal(sent.at(-1).jid, PN);
    assert.equal(sent.at(-1).text, 'Listo!');
    const created = await call('/david', 'whatsapp_create_draft', { chat: OTHER_LID, text: '¿Borrador!' });
    assert.equal(created.isError, true);
    const draft = JSON.parse((await call('/david', 'whatsapp_create_draft', { chat: `+${PHONE}`, text: '¿Borrador!' })).content[0].text);
    assert.equal(draft.jid, PN);
    const sentDraft = await call('/david', 'whatsapp_send_draft', { id: draft.id });
    assert.equal(sentDraft.isError, undefined);
    assert.equal(JSON.parse(sentDraft.content[0].text).jid, PN);
    assert.equal(sent.at(-1).text, 'Borrador!');

    const removed = JSON.parse((await call('/david', 'whatsapp_approved_contacts_remove', { identifier: LID })).content[0].text);
    assert.equal(removed.ok, true);
    assert.equal(runtime.store.findApproved(PN), null);
    const gone = await call('/david', 'whatsapp_send_text', { to: PN, text: 'later' });
    assert.equal(gone.isError, true);
    assert.match(gone.content[0].text, /has not written/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    drafts.close();
  }
});

{
  const dir = await mkdtemp(path.join(tmpdir(), 'lid-pn-'));
  const store = new MemoryStore(path.join(dir, 'history.sqlite'));
  store.linkJids(PN, LID);
  assert.equal(await lookupLidOnSession(store, null, LID), PN);
  const app = express();
  mountLidPn(app, {
    secret: SECRET,
    role: 'personal',
    lookup: (lid) => lookupLidOnSession(store, null, lid),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const missing = await fetch(`http://127.0.0.1:${port}/internal/lid-pn?lid=${encodeURIComponent(LID)}`);
    assert.equal(missing.status, 401);
    const wrong = await fetch(`http://127.0.0.1:${port}/internal/lid-pn?lid=${encodeURIComponent(LID)}`, {
      headers: { Authorization: 'Bearer not-the-secret-value-0123456789' },
    });
    assert.equal(wrong.status, 401);
    const found = await fetch(`http://127.0.0.1:${port}/internal/lid-pn?lid=${encodeURIComponent(LID)}`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    assert.equal(found.status, 200);
    assert.deepEqual(await found.json(), { pn: PN, phone: PHONE });
    const unknown = await fetch(`http://127.0.0.1:${port}/internal/lid-pn?lid=${encodeURIComponent(OTHER_LID)}`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    assert.equal(unknown.status, 404);
    const publicHost = await rawGet(port, 'wa.example.com', { Authorization: `Bearer ${SECRET}` });
    assert.equal(publicHost.status, 404);
    assert.equal(publicHost.body.includes(PHONE), false);
    const otherContainer = await rawGet(port, 'david', { Authorization: `Bearer ${SECRET}` });
    assert.equal(otherContainer.status, 404);
    assert.equal(otherContainer.body.includes(PHONE), false);
    const personalHost = await rawGet(port, 'personal', { Authorization: `Bearer ${SECRET}` });
    assert.equal(personalHost.status, 200);
    assert.deepEqual(JSON.parse(personalHost.body), { pn: PN, phone: PHONE });
    for (const name of ['cf-ray', 'cf-connecting-ip', 'cf-ipcountry', 'x-forwarded-for']) {
      const proxied = await rawGet(port, 'localhost', {
        Authorization: `Bearer ${SECRET}`,
        [name]: '203.0.113.8',
      });
      assert.equal(proxied.status, 404, name);
      assert.equal(proxied.body.includes(PHONE), false, name);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const dir = await mkdtemp(path.join(tmpdir(), 'approved-persist-'));
  const db = path.join(dir, 'david.sqlite');
  const first = new DavidStore(db, OWNER);
  assert.equal(first.addApproved({
    jid: PN, phone: PHONE, displayName: 'Ada', note: 'keep', addedBy: 'ben',
    addedAt: '2026-10-16T18:00:00.000Z', lid: LID, day: '2026-10-16',
  }), 'created');
  first.setSetting('approved.cold_per_day', '4');
  first.recordColdSend({ jid: PN, phone: PHONE, at: '2026-10-16T18:00:00.000Z', day: '2026-10-16' });
  first.close();
  const second = new DavidStore(db, OWNER);
  assert.equal(second.findApproved(LID).displayName, 'Ada');
  assert.equal(second.getSetting('approved.cold_per_day'), '4');
  assert.equal(second.countColdSends('2026-10-16'), 1);
  assert.equal(second.listApprovedLog(5).some((row) => row.action === 'add'), true);
  assert.equal(second.listApprovedLog(5).some((row) => row.action === 'cold_send'), true);
  second.close();
  await rm(dir, { recursive: true, force: true });
}

function rpc(body) {
  const json = body.startsWith('event:')
    ? body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6))).find((message) => message && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')))
    : JSON.parse(body);
  if (!json || json.error) throw new Error(json?.error?.message || 'missing MCP result');
  return json.result;
}

function rawGet(port, hostHeader, headers = {}, path = `/internal/lid-pn?lid=${encodeURIComponent(LID)}`) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: { Host: hostHeader, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

{
  const app = express();
  app.use('/internal', rejectProxiedInternal);
  app.get('/internal/admin/style', (_req, res) => {
    res.status(401).json({ error: 'Unauthorized', guide: 'secret-style' });
  });
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const open = await rawGet(port, 'localhost', {}, '/internal/admin/style');
    assert.equal(open.status, 401);
    const health = await rawGet(port, 'localhost', { 'cf-ray': 'tunnel' }, '/healthz');
    assert.equal(health.status, 200);
    for (const name of ['cf-ray', 'cf-connecting-ip', 'cf-ipcountry', 'x-forwarded-for']) {
      const hidden = await rawGet(port, 'localhost', { [name]: '203.0.113.9' }, '/internal/nowhere');
      assert.equal(hidden.status, 404, name);
      assert.equal(hidden.body.includes('secret-style'), false);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

console.log('PASS: approved contacts, cold-send cap, LID resolution, and admin auth');
