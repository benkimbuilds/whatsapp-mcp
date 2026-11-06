import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { createDavidPeer } from '../dist/admin-peer.js';
import { mountAdmin } from '../dist/admin.js';
import { mountDavidRead } from '../dist/david-read.js';
import { DavidStore } from '../dist/david/store.js';
import { parseRecipient } from '../dist/david/resolve.js';
import { DEFAULT_STYLE_GUIDE, defaultStylePayload, STYLE_GUIDE_MAX } from '../dist/david/style.js';
import { MemoryStore } from '../dist/store.js';

const dir = await mkdtemp(path.join(tmpdir(), 'whatsapp-admin-peer-'));
const adminSecret = 'admin-secret-for-tests-only-0123456789';
const readSecret = 'david-read-secret-for-tests-0123456789';
const owner = '15555550199';
const personalChat = '15555550100@s.whatsapp.net';
const davidChat = '15555550101@s.whatsapp.net';
const group = '120363000000000001@g.us';
const now = Math.floor(Date.now() / 1000);

const personal = new MemoryStore(path.join(dir, 'personal.sqlite'));
personal.upsertChat({ id: personalChat, name: 'Personal Chat', unreadCount: 2, conversationTimestamp: now });
personal.upsertMessage({
  key: { remoteJid: personalChat, id: 'p1', fromMe: false },
  messageTimestamp: now,
  message: { conversation: 'personal-only-body' },
});
personal.recordMcpCall({ at: now, tool: 'whatsapp_status', action: null, argsSummary: 'none', durationMs: 4, ok: true });

const history = new MemoryStore(path.join(dir, 'david-history.sqlite'));
history.upsertChat({ id: davidChat, name: 'David & <Chat>', unreadCount: 4, conversationTimestamp: now + 50 });
history.upsertMessage({
  key: { remoteJid: davidChat, id: 'd-old', fromMe: false },
  messageTimestamp: now,
  message: { conversation: 'david-older-body' },
});
history.upsertMessage({
  key: { remoteJid: davidChat, id: 'd1', fromMe: true },
  messageTimestamp: now + 50,
  message: { conversation: 'david-only-body <script>alert(1)</script>' },
});
history.recordMcpCall({ at: now + 5, tool: 'whatsapp_list_chats', action: null, argsSummary: 'limit=2', durationMs: 9, ok: true });

const davidStore = new DavidStore(path.join(dir, 'david.sqlite'), owner);
davidStore.setSetting('quiet', '22:00-08:00');
davidStore.grant('15555550198', 'example/repo');
const issued = new Date().toISOString();
const resolved = davidStore.createEscalation({
  type: 'meeting_book',
  summary: 'need a room',
  suggestedAction: 'book it',
  chatId: davidChat,
  requesterPhone: '15555550198',
  context: { when: 'Thursday', who: 'Ada', raw_excerpt: 'can we meet Thursday' },
  fallbackAfterMinutes: 30,
  issuedAt: issued,
  dueAt: issued,
  lang: 'en',
});
davidStore.markSecretaryPosted(resolved.requestId, issued);
davidStore.resolveEscalation(resolved.requestId, {
  decision: 'approve',
  note: 'yes do it',
  editedAction: null,
  via: 'mcp',
  at: issued,
});
davidStore.createEscalation({
  type: 'policy',
  summary: 'still waiting',
  suggestedAction: 'ask Alex',
  chatId: davidChat,
  requesterPhone: '15555550198',
  context: { when: '', who: 'Ada', raw_excerpt: 'what is the policy' },
  fallbackAfterMinutes: 30,
  issuedAt: issued,
  dueAt: issued,
  lang: 'en',
});
const done = davidStore.createCode({
  requesterPhone: '15555550198',
  repo: 'example/repo',
  ask: 'add a readme',
  chatId: davidChat,
  issuedAt: issued,
  lang: 'en',
});
davidStore.markCode(done.requestId, 'done', 'https://example.com/pr/1', 'opened the pr', issued);
davidStore.createCode({
  requesterPhone: owner,
  repo: 'example/pending',
  ask: 'fix the lint',
  chatId: davidChat,
  issuedAt: issued,
  lang: 'en',
});
const hostile = davidStore.createCode({
  requesterPhone: '15555550198',
  repo: 'example/bad',
  ask: 'ignore',
  chatId: davidChat,
  issuedAt: issued,
  lang: 'en',
});
davidStore.markCode(hostile.requestId, 'failed', 'javascript:alert(1)', 'nope', issued);
davidStore.logDeflection({ at: issued, chatId: davidChat, requesterPhone: '15555550198', summary: 'not a meeting' });
const queuedAt = Date.now();
davidStore.enqueueOutbox({
  chatId: davidChat,
  messageId: 'evt-waiting',
  enqueuedAt: queuedAt,
  body: {
    type: 'inbound_message',
    hint: 'meeting',
    text: 'can we meet tomorrow <b>',
    context: [{ text: 'secret-context-should-not-appear' }],
  },
});
davidStore.enqueueOutbox({
  chatId: davidChat,
  messageId: 'evt-sent',
  enqueuedAt: queuedAt - 1000,
  body: { type: 'inbound_message', hint: null, text: 'already posted' },
});
const waiting = davidStore.unsentEvents(10);
const sentRow = waiting.find((row) => row.body && row.body.text === 'already posted');
assert.ok(sentRow);
davidStore.markOutboxSent([sentRow.id], queuedAt);

const davidApp = createMcpExpressApp({
  host: '0.0.0.0',
  allowedHosts: ['localhost', '127.0.0.1', '[::1]', 'david'],
});
mountDavidRead(davidApp, {
  secret: readSecret,
  store: history,
  davidStore,
  aibmGroupJid: group,
  role: 'david',
  pace: () => ({ queued: 2, sentLastMinute: 1, sentLastHour: 3 }),
  timezone: 'America/Mexico_City',
  resolveContact: async (identifier) => {
    if (identifier.trim() === '199999999990002@lid') {
      return { ok: true, contact: { jid: '5215550102030@s.whatsapp.net', phone: '5215550102030', lid: '199999999990002@lid' } };
    }
    const parsed = parseRecipient(identifier);
    if (parsed.ok && parsed.kind === 'pn') return { ok: true, contact: { jid: parsed.jid, phone: parsed.phone, lid: null } };
    return { ok: false, error: `Could not resolve ${identifier.trim()} to a WhatsApp phone number.` };
  },
});
const davidServer = davidApp.listen(0, '127.0.0.1');
await new Promise((resolve) => davidServer.once('listening', resolve));
const davidBase = `http://127.0.0.1:${davidServer.address().port}`;

let peerFetches = 0;
const peer = createDavidPeer({
  secret: readSecret,
  baseUrl: davidBase,
  fetchImpl: (url, init) => {
    peerFetches += 1;
    return fetch(url, init);
  },
});
const app = express();
mountAdmin(app, { secret: adminSecret, store: personal, role: 'personal', peer });
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const bare = express();
mountAdmin(bare, { secret: adminSecret, store: personal, role: 'personal' });
const bareServer = bare.listen(0, '127.0.0.1');
await new Promise((resolve) => bareServer.once('listening', resolve));
const bareBase = `http://127.0.0.1:${bareServer.address().port}`;

const downPeer = createDavidPeer({ secret: readSecret, baseUrl: 'http://127.0.0.1:1' });
const down = express();
mountAdmin(down, { secret: adminSecret, store: personal, role: 'personal', peer: downPeer });
const downServer = down.listen(0, '127.0.0.1');
await new Promise((resolve) => downServer.once('listening', resolve));
const downBase = `http://127.0.0.1:${downServer.address().port}`;

const disabled = express();
mountDavidRead(disabled, { secret: 'change-me-to-a-long-random-secret', store: history, davidStore, aibmGroupJid: group, role: 'david' });
const disabledServer = disabled.listen(0, '127.0.0.1');
await new Promise((resolve) => disabledServer.once('listening', resolve));
const disabledBase = `http://127.0.0.1:${disabledServer.address().port}`;

const trapHits = [];
const trap = express();
trap.get('/stolen', (req, res) => {
  trapHits.push(req.header('authorization') ?? '');
  res.json({ chats: 0, messages: 0, activity: [] });
});
const trapServer = trap.listen(0, '127.0.0.1');
await new Promise((resolve) => trapServer.once('listening', resolve));
const redirector = express();
redirector.get('/internal/admin/overview', (_req, res) => {
  res.redirect(302, `http://127.0.0.1:${trapServer.address().port}/stolen`);
});
const redirectServer = redirector.listen(0, '127.0.0.1');
await new Promise((resolve) => redirectServer.once('listening', resolve));

function authHeaders() {
  return { Authorization: `Bearer ${adminSecret}` };
}

function rawGet(port, hostHeader, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/internal/admin/overview',
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

try {
  const calls = [];
  const rejectingFetch = () => {
    calls.push('fetch');
    throw new Error('fetch should not run');
  };
  for (const baseUrl of [
    'https://david:8788',
    'http://evil.example:8788',
    'http://david:8788/internal',
    'http://user:pass@david:8788',
    'http://david',
    'http://127.0.0.1:8788/extra',
  ]) {
    const rejected = createDavidPeer({ secret: readSecret, baseUrl, fetchImpl: rejectingFetch });
    assert.equal(rejected.configured, false, baseUrl);
    const result = await rejected.overview();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unconfigured');
  }
  const placeholder = createDavidPeer({
    secret: 'change-me-to-a-long-random-secret',
    baseUrl: 'http://david:8788',
    fetchImpl: rejectingFetch,
  });
  assert.equal(placeholder.configured, false);
  assert.equal(calls.length, 0);
  const accepted = createDavidPeer({ secret: readSecret, baseUrl: 'http://david:8788', fetchImpl: rejectingFetch });
  assert.equal(accepted.configured, true);
  assert.equal(accepted.baseUrl, 'http://david:8788');

  const hidden = await fetch(`${disabledBase}/internal/admin/overview`, { headers: { Authorization: `Bearer ${readSecret}` } });
  assert.equal(hidden.status, 404);
  assert.equal((await hidden.text()).includes('david-only-body'), false);

  const missing = await fetch(`${davidBase}/internal/admin/overview`);
  assert.equal(missing.status, 401);
  assert.equal((await missing.text()).includes('david-only-body'), false);
  const wrong = await fetch(`${davidBase}/internal/admin/chats`, { headers: { Authorization: 'Bearer not-the-read-secret-value' } });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.text()).includes('david-only-body'), false);

  const davidPort = davidServer.address().port;
  const allowedHost = await rawGet(davidPort, 'david:8788', { Authorization: `Bearer ${readSecret}` });
  assert.equal(allowedHost.status, 200);
  assert.match(allowedHost.body, /david-only-body/);
  const rejectedHost = await rawGet(davidPort, 'evil.example', { Authorization: `Bearer ${readSecret}` });
  assert.equal(rejectedHost.status, 403);
  assert.equal(rejectedHost.body.includes('david-only-body'), false);
  for (const name of ['cf-ray', 'cf-connecting-ip', 'cf-ipcountry', 'x-forwarded-for']) {
    const tunneled = await rawGet(davidPort, 'localhost', {
      Authorization: `Bearer ${readSecret}`,
      [name]: '203.0.113.4',
    });
    assert.equal(tunneled.status, 404, name);
    assert.equal(tunneled.body.includes('david-only-body'), false, name);
  }

  const badJid = await fetch(`${davidBase}/internal/admin/messages?jid=not-a-jid`, { headers: { Authorization: `Bearer ${readSecret}` } });
  assert.equal(badJid.status, 400);
  const before = davidStore.countEscalations(['open', 'awaiting_owner', 'resolved']);
  const posted = await fetch(`${davidBase}/internal/admin/context`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${readSecret}`, 'Content-Type': 'application/json' },
    body: '{"summary":"injected"}',
  });
  assert.equal(posted.status, 404);
  assert.equal(davidStore.countEscalations(['open', 'awaiting_owner', 'resolved']), before);

  const redirectPeer = createDavidPeer({
    secret: readSecret,
    baseUrl: `http://127.0.0.1:${redirectServer.address().port}`,
  });
  const redirected = await redirectPeer.overview();
  assert.equal(redirected.ok, false);
  assert.equal(redirected.reason, 'unavailable');
  assert.equal(trapHits.length, 0);

  peerFetches = 0;
  const personalPage = await fetch(`${base}/admin`, { headers: authHeaders() });
  assert.equal(personalPage.status, 200);
  const personalHtml = await personalPage.text();
  assert.match(personalHtml, /1 chats, 1 messages/);
  assert.match(personalHtml, /personal-only-body/);
  assert.equal(personalHtml.includes('david-only-body'), false);
  assert.match(personalHtml, /href="\/admin\?account=david"/);
  assert.match(personalHtml, /href="\/admin\?account=all"/);
  assert.match(personalHtml, /href="\/admin\/david"/);
  assert.equal(peerFetches, 0);

  const davidPage = await fetch(`${base}/admin?account=david`, { headers: authHeaders() });
  assert.equal(davidPage.status, 200);
  const davidHtml = await davidPage.text();
  assert.match(davidHtml, /David &amp; &lt;Chat&gt;/);
  assert.equal(davidHtml.includes('David & <Chat>'), false);
  assert.match(davidHtml, /david-only-body &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(davidHtml.includes('<script>alert(1)</script>'), false);
  assert.equal(davidHtml.includes('personal-only-body'), false);
  assert.match(davidHtml, /open escalations/);
  assert.match(davidHtml, />David</);

  const merged = await fetch(`${base}/admin?account=all`, { headers: authHeaders() });
  const mergedHtml = await merged.text();
  assert.match(mergedHtml, /personal-only-body/);
  assert.match(mergedHtml, /david-only-body/);
  assert.match(mergedHtml, />Personal</);
  assert.match(mergedHtml, />David</);
  assert.ok(mergedHtml.indexOf('david-only-body') < mergedHtml.indexOf('personal-only-body'));

  const chats = await fetch(`${base}/admin/chats?account=david`, { headers: authHeaders() });
  const chatsHtml = await chats.text();
  assert.match(chatsHtml, /David &amp; &lt;Chat&gt;/);
  assert.match(chatsHtml, new RegExp(`/admin/messages\\?jid=${encodeURIComponent(davidChat)}&amp;account=david`));
  assert.equal(chatsHtml.includes('personal-only-body'), false);

  const messages = await fetch(`${base}/admin/messages?account=david&jid=${encodeURIComponent(davidChat)}`, { headers: authHeaders() });
  const messagesHtml = await messages.text();
  assert.match(messagesHtml, /david-only-body/);
  assert.match(messagesHtml, />out</);
  assert.ok(messagesHtml.indexOf('david-only-body') < messagesHtml.indexOf('david-older-body'));
  const found = await fetch(`${base}/admin/messages?account=david&jid=${encodeURIComponent(davidChat)}&q=older`, { headers: authHeaders() });
  const foundHtml = await found.text();
  assert.match(foundHtml, /david-older-body/);
  assert.equal(foundHtml.includes('david-only-body'), false);

  const activity = await fetch(`${base}/admin/activity?account=all`, { headers: authHeaders() });
  const activityHtml = await activity.text();
  assert.match(activityHtml, /personal-only-body/);
  assert.match(activityHtml, /david-only-body/);
  const stats = await fetch(`${base}/admin/stats?account=all`, { headers: authHeaders() });
  const statsHtml = await stats.text();
  assert.match(statsHtml, /Personal Chat/);
  assert.match(statsHtml, /David &amp; &lt;Chat&gt;/);

  const personalRequests = await fetch(`${base}/admin/requests`, { headers: authHeaders() });
  const personalRequestsHtml = await personalRequests.text();
  assert.match(personalRequestsHtml, /whatsapp_status/);
  assert.equal(personalRequestsHtml.includes('whatsapp_list_chats'), false);
  assert.equal(personalRequestsHtml.includes('david-only-body'), false);
  const davidRequests = await fetch(`${base}/admin/requests?account=david`, { headers: authHeaders() });
  const davidRequestsHtml = await davidRequests.text();
  assert.match(davidRequestsHtml, /whatsapp_list_chats/);
  assert.match(davidRequestsHtml, /limit=2/);
  assert.equal(davidRequestsHtml.includes('whatsapp_status'), false);
  assert.equal(davidRequestsHtml.includes('david-only-body'), false);

  const assistant = await fetch(`${base}/admin/david`, { headers: authHeaders() });
  assert.equal(assistant.status, 200);
  const assistantHtml = await assistant.text();
  assert.equal(assistantHtml.includes('David unavailable.'), false);
  assert.match(assistantHtml, /David assistant/);
  assert.match(assistantHtml, /href="\/admin\/david" class="on"/);
  assert.match(assistantHtml, /need a room/);
  assert.match(assistantHtml, /can we meet Thursday/);
  assert.match(assistantHtml, /approve/);
  assert.match(assistantHtml, /yes do it/);
  assert.match(assistantHtml, /still waiting/);
  assert.match(assistantHtml, /add a readme/);
  assert.match(assistantHtml, /fix the lint/);
  assert.match(assistantHtml, /https:\/\/example\.com\/pr\/1/);
  assert.match(assistantHtml, /example\/repo/);
  assert.match(assistantHtml, /not a meeting/);
  assert.match(assistantHtml, /Secretary outbox/);
  assert.match(assistantHtml, /1 unsent/);
  assert.match(assistantHtml, /can we meet tomorrow &lt;b&gt;/);
  assert.match(assistantHtml, /inbound_message/);
  assert.match(assistantHtml, />meeting</);
  assert.match(assistantHtml, /already posted/);
  assert.match(assistantHtml, />waiting</);
  assert.equal(assistantHtml.includes('secret-context-should-not-appear'), false);
  assert.match(assistantHtml, /Send queue/);
  assert.match(assistantHtml, /Waiting: 2/);
  assert.match(assistantHtml, /Sent in the last minute: 1/);
  assert.match(assistantHtml, /Sent in the last hour: 3/);
  assert.match(assistantHtml, /22:00-08:00/);
  assert.match(assistantHtml, new RegExp(group));
  assert.match(assistantHtml, new RegExp(owner));
  assert.match(assistantHtml, /\*/);
  assert.equal(assistantHtml.includes('href="javascript:'), false);
  assert.match(assistantHtml, /javascript:alert\(1\)/);
  assert.equal(assistant.headers.get('content-security-policy')?.includes("default-src 'none'"), true);
  assert.match(assistantHtml, /<h2>Approved contacts<\/h2>/);
  assert.match(assistantHtml, /No approved contacts/);
  assert.match(assistantHtml, /0 of 5/);
  assert.match(assistantHtml, /action="\/admin\/david\/approved-cap"/);
  assert.match(assistantHtml, /action="\/admin\/david\/approved-contacts"/);
  assert.match(assistantHtml, /<h2>Style<\/h2>/);
  assert.match(assistantHtml, /flattering or subservient/);
  assert.match(assistantHtml, /Strip ¡ and ¿/);
  assert.match(assistantHtml, /action="\/admin\/david\/style"/);
  assert.equal(assistantHtml.includes('I can help'), false);

  const readHeaders = { Authorization: `Bearer ${readSecret}`, 'Content-Type': 'application/json' };
  const styleMissing = await fetch(`${davidBase}/internal/admin/style`);
  assert.equal(styleMissing.status, 401);
  const stylePutMissing = await fetch(`${davidBase}/internal/admin/style`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(defaultStylePayload()),
  });
  assert.equal(stylePutMissing.status, 401);
  assert.equal(davidStore.getSetting('style.guide'), null);
  const styleGet = await fetch(`${davidBase}/internal/admin/style`, { headers: readHeaders });
  assert.equal(styleGet.status, 200);
  const styleBody = await styleGet.json();
  assert.equal(styleBody.guide, DEFAULT_STYLE_GUIDE);
  assert.equal(styleBody.strip, true);
  assert.equal(styleBody.lines.some((line) => line.id === 'generic' && line.en.includes("I'm {owner}'s assistant.")), true);

  const tooLong = defaultStylePayload();
  tooLong.guide = 'x'.repeat(STYLE_GUIDE_MAX + 1);
  const rejected = await fetch(`${davidBase}/internal/admin/style`, {
    method: 'PUT',
    headers: readHeaders,
    body: JSON.stringify(tooLong),
  });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, 'guide_too_long');
  assert.equal(davidStore.getSetting('style.guide'), null);
  assert.equal(davidStore.getSetting('quiet'), '22:00-08:00');

  const custom = defaultStylePayload();
  custom.guide = 'Two short sentences.';
  custom.strip = false;
  custom.lines.generic.en = 'David here.';
  const saved = await fetch(`${davidBase}/internal/admin/style`, {
    method: 'PUT',
    headers: readHeaders,
    body: JSON.stringify(custom),
  });
  assert.equal(saved.status, 200);
  assert.equal(davidStore.getSetting('style.guide'), 'Two short sentences.');
  assert.equal(davidStore.getSetting('style.strip'), 'off');
  assert.equal(davidStore.getSetting('style.line.generic.en'), 'David here.');
  assert.equal(davidStore.getSetting('quiet'), '22:00-08:00');

  const dashboardRefused = await fetch(`${base}/admin/david/style`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ guide: 'nope' }),
  });
  assert.equal(dashboardRefused.status, 401);
  assert.equal(davidStore.getSetting('style.guide'), 'Two short sentences.');

  const form = new URLSearchParams();
  form.set('guide', 'From the dashboard.');
  form.set('strip', '1');
  for (const [id, line] of Object.entries(defaultStylePayload().lines)) {
    form.set(`en_${id}`, line.en);
    form.set(`es_${id}`, line.es);
  }
  form.set('en_generic', 'Noted.');
  const dashboardSaved = await fetch(`${base}/admin/david/style`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  });
  assert.equal(dashboardSaved.status, 302);
  assert.match(dashboardSaved.headers.get('location') ?? '', /\/admin\/david\?saved=1/);
  assert.equal(davidStore.getSetting('style.guide'), 'From the dashboard.');
  assert.equal(davidStore.getSetting('style.strip'), 'on');
  assert.equal(davidStore.getSetting('style.line.generic.en'), 'Noted.');
  assert.equal(davidStore.getSetting('quiet'), '22:00-08:00');
  const savedPage = await fetch(`${base}/admin/david?saved=1`, { headers: authHeaders() });
  const savedHtml = await savedPage.text();
  assert.match(savedHtml, /Style saved on David/);
  assert.match(savedHtml, /From the dashboard/);
  assert.match(savedHtml, />Noted\.</);

  const approvedHeaders = { Authorization: `Bearer ${readSecret}`, 'Content-Type': 'application/json' };
  for (const path of ['/internal/admin/approved-contacts', '/internal/admin/approved-contacts/remove', '/internal/admin/approved-contacts/cap']) {
    const missing = await fetch(`${davidBase}${path}`, path.endsWith('/cap') ? { method: 'PUT' } : path.endsWith('/remove') ? { method: 'POST' } : {});
    assert.equal(missing.status, 401, path);
    assert.equal((await missing.text()).includes(owner), false);
  }
  const capMissing = await fetch(`${davidBase}/internal/admin/approved-contacts/cap`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coldPerDay: 1 }),
  });
  assert.equal(capMissing.status, 401);
  assert.equal(davidStore.getSetting('approved.cold_per_day'), null);
  const listedApproved = await fetch(`${davidBase}/internal/admin/approved-contacts`, { headers: approvedHeaders });
  assert.equal(listedApproved.status, 200);
  const listedBody = await listedApproved.json();
  assert.equal(listedBody.coldPerDay, 5);
  assert.equal(listedBody.coldSentToday, 0);
  assert.deepEqual(listedBody.contacts, []);
  const badAdd = await fetch(`${davidBase}/internal/admin/approved-contacts`, {
    method: 'POST',
    headers: approvedHeaders,
    body: JSON.stringify({ identifier: 'not-a-number', note: 'because', addedBy: 'ben' }),
  });
  assert.equal(badAdd.status, 400);
  assert.match((await badAdd.json()).error, /Could not resolve/);
  const addedContact = await fetch(`${davidBase}/internal/admin/approved-contacts`, {
    method: 'POST',
    headers: approvedHeaders,
    body: JSON.stringify({
      identifier: '199999999990002@lid',
      displayName: 'Ada <b>',
      note: 'Alex approved the intro',
      addedBy: 'ben',
    }),
  });
  assert.equal(addedContact.status, 200);
  const addedBody = await addedContact.json();
  assert.equal(addedBody.contact.jid, '5215550102030@s.whatsapp.net');
  assert.equal(addedBody.contact.phone, '5215550102030');
  assert.equal(addedBody.contact.lid, '199999999990002@lid');
  assert.equal(addedBody.contact.addedBy, 'ben');
  assert.equal(davidStore.findApproved('5215550102030').addedBy, 'ben');
  assert.equal(davidStore.findApproved('199999999990002@lid').jid, '5215550102030@s.whatsapp.net');
  assert.equal(davidStore.listApprovedLog(5).some((row) => row.action === 'add' && row.jid === '5215550102030@s.whatsapp.net'), true);
  const badCap = await fetch(`${davidBase}/internal/admin/approved-contacts/cap`, {
    method: 'PUT',
    headers: approvedHeaders,
    body: JSON.stringify({ coldPerDay: 500 }),
  });
  assert.equal(badCap.status, 400);
  const savedCap = await fetch(`${davidBase}/internal/admin/approved-contacts/cap`, {
    method: 'PUT',
    headers: approvedHeaders,
    body: JSON.stringify({ coldPerDay: 3 }),
  });
  assert.equal(savedCap.status, 200);
  assert.equal((await savedCap.json()).coldPerDay, 3);
  assert.equal(davidStore.getSetting('approved.cold_per_day'), '3');

  const dashboardAddRefused = await fetch(`${base}/admin/david/approved-contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ identifier: '15555550111', note: 'nope' }),
  });
  assert.equal(dashboardAddRefused.status, 401);
  const dashboardAdded = await fetch(`${base}/admin/david/approved-contacts`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ identifier: '+1 555 555 0111', display_name: 'Sam', note: 'from the dashboard' }),
    redirect: 'manual',
  });
  assert.equal(dashboardAdded.status, 302);
  assert.match(dashboardAdded.headers.get('location') ?? '', /\/admin\/david\?approved=1/);
  assert.equal(davidStore.findApproved('15555550111').displayName, 'Sam');
  assert.equal(davidStore.findApproved('15555550111').addedBy, 'dashboard');
  const approvedPage = await fetch(`${base}/admin/david?approved=1`, { headers: authHeaders() });
  const approvedHtml = await approvedPage.text();
  assert.match(approvedHtml, /Approved contact saved on David/);
  assert.match(approvedHtml, /5215550102030@s\.whatsapp\.net/);
  assert.match(approvedHtml, /199999999990002@lid/);
  assert.match(approvedHtml, /Alex approved the intro/);
  assert.match(approvedHtml, /Ada &lt;b&gt;/);
  assert.match(approvedHtml, /15555550111/);
  assert.match(approvedHtml, /value="3"/);
  assert.equal(approvedHtml.includes('Ada <b>'), false);
  const dashboardCapRefused = await fetch(`${base}/admin/david/approved-cap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ cold_per_day: '1' }),
  });
  assert.equal(dashboardCapRefused.status, 401);
  assert.equal(davidStore.getSetting('approved.cold_per_day'), '3');
  const dashboardCap = await fetch(`${base}/admin/david/approved-cap`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ cold_per_day: '4' }),
    redirect: 'manual',
  });
  assert.equal(dashboardCap.status, 302);
  assert.equal(davidStore.getSetting('approved.cold_per_day'), '4');
  const dashboardRemoveRefused = await fetch(`${base}/admin/david/approved-contacts/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ identifier: '15555550111@s.whatsapp.net' }),
  });
  assert.equal(dashboardRemoveRefused.status, 401);
  const dashboardRemoved = await fetch(`${base}/admin/david/approved-contacts/remove`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ identifier: '15555550111@s.whatsapp.net' }),
    redirect: 'manual',
  });
  assert.equal(dashboardRemoved.status, 302);
  assert.equal(davidStore.findApproved('15555550111'), null);
  assert.equal(davidStore.findApproved('5215550102030').jid, '5215550102030@s.whatsapp.net');
  const removedPage = await fetch(`${base}/admin/david?removed=1`, { headers: authHeaders() });
  const removedHtml = await removedPage.text();
  assert.match(removedHtml, /Approved contact removed/);
  assert.equal(removedHtml.includes('15555550111'), false);

  const login = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: adminSecret }),
    redirect: 'manual',
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const authedDavid = await fetch(`${base}/admin/chats?account=david`, { headers: { Cookie: cookie, Accept: 'text/html' } });
  assert.equal(authedDavid.status, 200);
  assert.match(await authedDavid.text(), /David &amp; &lt;Chat&gt;/);

  const bareDavid = await fetch(`${bareBase}/admin?account=david`, { headers: authHeaders() });
  assert.equal(bareDavid.status, 200);
  const bareHtml = await bareDavid.text();
  assert.match(bareHtml, /David unavailable/);
  assert.match(bareHtml, /DAVID_READ_SECRET is not set/);
  assert.equal(bareHtml.includes('personal-only-body'), false);
  const bareAll = await fetch(`${bareBase}/admin?account=all`, { headers: authHeaders() });
  const bareAllHtml = await bareAll.text();
  assert.match(bareAllHtml, /David unavailable/);
  assert.match(bareAllHtml, /personal-only-body/);

  const downPage = await fetch(`${downBase}/admin?account=david`, { headers: authHeaders() });
  assert.equal(downPage.status, 200);
  const downHtml = await downPage.text();
  assert.match(downHtml, /David unavailable/);
  assert.match(downHtml, /did not respond/);
  assert.equal(downHtml.includes('personal-only-body'), false);
  const downAssistant = await fetch(`${downBase}/admin/david`, { headers: authHeaders() });
  assert.equal(downAssistant.status, 200);
  const downAssistantHtml = await downAssistant.text();
  assert.match(downAssistantHtml, /David assistant/);
  assert.match(downAssistantHtml, /David unavailable/);
  assert.match(downAssistantHtml, /href="\/admin\/david" class="on"/);
  const downAll = await fetch(`${downBase}/admin/activity?account=all`, { headers: authHeaders() });
  assert.equal(downAll.status, 200);
  const downAllHtml = await downAll.text();
  assert.match(downAllHtml, /David unavailable/);
  assert.match(downAllHtml, /personal-only-body/);

  const refused = createDavidPeer({ secret: 'wrong-read-secret-value-0123456789', baseUrl: davidBase });
  const refusedApp = express();
  mountAdmin(refusedApp, { secret: adminSecret, store: personal, role: 'personal', peer: refused });
  const refusedServer = refusedApp.listen(0, '127.0.0.1');
  await new Promise((resolve) => refusedServer.once('listening', resolve));
  try {
    const refusedPage = await fetch(`http://127.0.0.1:${refusedServer.address().port}/admin?account=david`, { headers: authHeaders() });
    assert.equal(refusedPage.status, 200);
    const refusedHtml = await refusedPage.text();
    assert.match(refusedHtml, /David unavailable/);
    assert.match(refusedHtml, /rejected the read secret/);
    assert.equal(refusedHtml.includes('david-only-body'), false);
  } finally {
    await new Promise((resolve) => refusedServer.close(resolve));
  }

  const internalOnPersonal = await fetch(`${base}/internal/admin/overview`, { headers: { Authorization: `Bearer ${readSecret}` } });
  assert.equal(internalOnPersonal.status, 404);

  console.log('PASS: personal admin reads David with a secret and stays up when David is down');
} finally {
  await Promise.all([server, davidServer, bareServer, downServer, disabledServer, trapServer, redirectServer].map((item) => new Promise((resolve) => item.close(resolve))));
  personal.close();
  history.close();
  davidStore.close();
  await rm(dir, { recursive: true, force: true });
}
