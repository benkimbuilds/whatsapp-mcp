import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { bindStoreEvents } from '../dist/whatsapp.js';
import { MemoryStore } from '../dist/store.js';
import { DavidStore } from '../dist/david/store.js';
import { DavidRuntime } from '../dist/david/runtime.js';
import { loadDavidConfig } from '../dist/david/config.js';
import { createWebhook, loadWebhookSettings } from '../dist/webhook.js';
import { mountDavidRead } from '../dist/david-read.js';
import { mountAdmin } from '../dist/admin.js';
import { createDavidPeer } from '../dist/admin-peer.js';
import { createMcpServer } from '../dist/mcp-tools.js';

const dir = await mkdtemp(path.join(tmpdir(), 'webhook-blocklist-'));
const PN = '525550001111';
const LEGACY = '5215550001111';
const SEED = { identifier: '+52 55 5000 1111', approved_by: 'Owner (via assistant)', reason: 'Test seed' };
const LID = '987654321@lid';
const GROUP = '123456@g.us';
const SECRET = 'fake-test-secret-with-at-least-24-chars';
const content = 'PRIVATE-CONTENT-DO-NOT-LOG';
const history = new MemoryStore(path.join(dir, 'personal.sqlite'));
const davidHistory = new MemoryStore(path.join(dir, 'david-history.sqlite'));
// New installs start empty; seed one fictional entry the way an operator would.
assert.equal(history.webhookBlocklist.list().entries.length, 0);
history.webhookBlocklist.add(SEED);
davidHistory.webhookBlocklist.add(SEED);
history.linkJids(LID, `${LEGACY}@s.whatsapp.net`);
davidHistory.linkJids(LID, `${PN}@s.whatsapp.net`);
const lookup = jid => history.phoneForJid(jid);
const servers = [];
let runtime;
async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
function msg(sender, group = false, id = Math.random().toString()) {
  return { key: { id, remoteJid: group ? GROUP : sender, participant: group ? sender : undefined, fromMe: false }, messageTimestamp: 1700000000, message: { conversation: content } };
}
try {
  const seed = history.webhookBlocklist.list().entries[0];
  assert.equal(seed.added_by, SEED.approved_by);
  assert.equal(seed.reason, SEED.reason);
  for (const value of [PN, LEGACY, `+52 55 5000 1111`, `${LEGACY}:4@s.whatsapp.net`, LID]) assert.equal(history.webhookBlocklist.matches(value, lookup), true, value);
  assert.equal(history.webhookBlocklist.matches('15555550123'), false);
  // LID-only entries keep matching when the mapping arrives later, in either direction.
  history.webhookBlocklist.add({ identifier: '222222222@lid', name: 'Fake', note: 'Test note', approved_by: 'Test', reason: 'Test' }, lookup);
  history.linkJids('222222222@lid', '5215512345678@s.whatsapp.net');
  assert.equal(history.webhookBlocklist.matches('525512345678', lookup), true);
  assert.throws(() => history.webhookBlocklist.add({ identifier: '525512345678', approved_by: 'Test', reason: 'Test' }, lookup), /Already/);
  history.webhookBlocklist.remove('525512345678', lookup);
  assert.equal(history.webhookBlocklist.matches('222222222@lid', lookup), false);

  const posts = [], logs = [], timers = [];
  const webhook = createWebhook(loadWebhookSettings({ WEBHOOK_URL: 'https://fake.test/incoming-messages', WEBHOOK_GROUP_JIDS: GROUP }, 'personal', () => ''), {
    blocked: jid => history.webhookBlocklist.skip(jid, lookup),
    fetch: async (_url, init) => { posts.push(JSON.parse(init.body)); return new Response('ok'); },
    delay: (_ms, fn) => { timers.push(fn); return { cancel() {} }; }, log: line => logs.push(line),
  });
  for (const sender of [`${PN}@s.whatsapp.net`, `${LEGACY}@s.whatsapp.net`, LID]) {
    for (const group of [false, true]) {
      const message = msg(sender, group);
      if (history.upsertMessage(message)) webhook.push(message);
      assert.equal(history.listMessages(message.key.remoteJid, 100).messages.some(m => m.text === content), false);
    }
  }
  assert.equal(history.webhookBlocklist.list().skipped, 6);
  assert.equal(posts.length, 0);
  assert.equal(timers.length, 0);
  webhook.push(msg('15555550123@s.whatsapp.net'));
  timers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posts[0].messages.length, 1);
  assert.equal('senderJid' in posts[0].messages[0], false);

  // Adding after enqueue still suppresses the pending event.
  webhook.push(msg('15555550124@s.whatsapp.net'));
  history.webhookBlocklist.add({ identifier: '15555550124', approved_by: 'Test', reason: 'pending' });
  timers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posts.length, 1);

  const davidPosts = [];
  const wa = { getStore: () => davidHistory, getAccount: () => ({}), getSocket: () => null, getStatus: () => ({ state: 'open' }) };
  runtime = new DavidRuntime(loadDavidConfig({ SESSION_ROLE: 'david', OWNER_PHONE: '15555550123', SECRETARY_ESCALATION_WEBHOOK_URL: 'https://fake.test/david-escalations', SECRETARY_ESCALATION_BATCH_SECONDS: '3600', DAVID_GROUP_ALL: 'true' }), wa, path.join(dir, 'david.sqlite'), {
    fetch: async (_url, init) => { davidPosts.push(JSON.parse(init.body)); return new Response('ok'); }, log: line => logs.push(line),
  });
  runtime.store.webhookBlocklist.add(SEED);
  async function davidInbound(sender, group = false, altJid = '') {
    const message = msg(sender, group);
    message.key.remoteJidAlt = group ? undefined : altJid;
    message.key.participantAlt = group ? altJid : undefined;
    if (davidHistory.upsertMessage(message)) await runtime.handleInbound({ id: message.key.id, chatJid: message.key.remoteJid, senderJid: sender, altJid, fromMe: false, stub: false, text: content, mentions: [], pushName: 'Fake', timestampMs: 1700000000000 });
    if ([PN, LEGACY].some(p => sender.includes(p)) || sender === LID || altJid) assert.equal(davidHistory.listMessages(message.key.remoteJid, 100).messages.some(m => m.text === content), false);
  }
  for (const sender of [`${PN}@s.whatsapp.net`, `${LEGACY}@s.whatsapp.net`, LID]) {
    await davidInbound(sender);
    await davidInbound(sender, true);
  }
  await davidInbound('111111111@lid', false, `${LEGACY}@s.whatsapp.net`);
  assert.equal(runtime.store.webhookBlocklist.list().skipped, 7);
  assert.equal(runtime.store.unsentCount(), 0);
  assert.equal(davidPosts.length, 0);
  await davidInbound('15555550124@s.whatsapp.net');
  runtime.store.webhookBlocklist.add({ identifier: '15555550124', approved_by: 'Test', reason: 'pending' });
  await runtime.stop();
  assert.equal(davidPosts.length, 0);
  assert.equal(runtime.store.unsentCount(), 0);
  await davidInbound('15555550125@s.whatsapp.net');
  await runtime.stop();
  assert.equal(davidPosts.length, 1);
  assert.equal(logs.some(line => line.includes(content)), false);

  // Exercise the real registered event processor with a fake Baileys emitter.
  for (const [store, policy] of [[history, history.webhookBlocklist], [davidHistory, runtime.store.webhookBlocklist]]) {
    let processEvents;
    const notified = [];
    bindStoreEvents({ ev: { process(fn) { processEvents = fn; } } }, store, { onNotify: message => notified.push(message) });
    const before = policy.list().skipped;
    const droppedBefore = policy.list().dropped;
    // Reject even a transient INSERT: dropping after a write would fail this test.
    const fixtureDb = new DatabaseSync(path.join(dir, store === history ? 'personal.sqlite' : 'david-history.sqlite'));
    fixtureDb.exec(`CREATE TRIGGER reject_blocked_write BEFORE INSERT ON messages
      WHEN NEW.id IN ('notify-blocked', 'group-blocked', 'alt-blocked', 'history-blocked', 'append-blocked')
      BEGIN SELECT RAISE(ABORT, 'blocked database write attempted'); END;`);
    fixtureDb.close();
    const allowed = '15555550666@s.whatsapp.net';
    const group = '909090@g.us';
    const blockedMessages = [
      msg(`${PN}@s.whatsapp.net`, false, 'notify-blocked'),
      { ...msg(LID, true, 'group-blocked'), key: { remoteJid: group, participant: LID, id: 'group-blocked', fromMe: false } },
      { ...msg('333333@lid', false, 'alt-blocked'), key: { remoteJid: '333333@lid', remoteJidAlt: `${LEGACY}@s.whatsapp.net`, fromMe: false, id: 'alt-blocked' } },
    ];
    blockedMessages[1].message = { imageMessage: { caption: content, contextInfo: { mentionedJid: [allowed] } } };
    await processEvents({ 'messages.upsert': { type: 'notify', messages: [...blockedMessages, msg(allowed, false, 'notify-allowed')] },
      'chats.upsert': [{ id: group, conversationTimestamp: 1700000000, messages: [{ message: blockedMessages[1] }] }] });
    assert.deepEqual(notified.map(message => message.key.id), ['notify-allowed']);
    assert.equal(store.chats.get(group).conversationTimestamp, undefined);
    assert.equal(JSON.stringify(store.chats.get(group)).includes(content), false);
    // Same-batch history mappings must be applied before filtering the messages or previews.
    const historical = { ...msg('444444@lid', true, 'history-blocked'), key: { remoteJid: group, participant: '444444@lid', id: 'history-blocked', fromMe: false } };
    await processEvents({ 'messaging-history.set': { chats: [{ id: group, conversationTimestamp: 1700000000, messages: [{ message: historical }] }], contacts: [],
      lidPnMappings: [{ pn: `${LEGACY}@s.whatsapp.net`, lid: '444444@lid' }], messages: [historical, msg(allowed, false, 'history-allowed')] } });
    await processEvents({ 'messages.upsert': { type: 'append', messages: [msg(`${LEGACY}@s.whatsapp.net`, false, 'append-blocked'), msg(allowed, false, 'append-allowed')] } });
    assert.equal(notified.length, 1); // append/history must never forward
    assert.equal(policy.list().skipped, before + 5);
    assert.equal(policy.list().dropped, droppedBefore + 5);
    for (const message of [...blockedMessages, historical]) {
      assert.equal(store.listMessages(message.key.remoteJid, 100).messages.some(row => row.id === message.key.id), false);
      assert.equal(await store.getMessage(message.key), undefined);
    }
    assert.equal(store.listMessages(group, 100).messages.length, 0);
    assert.equal(store.listMessages(allowed, 100).messages.length, 3);
    await processEvents({ 'messages.update': [{ key: historical.key, update: { messageStubType: 1 } }] });
    assert.equal(store.listMessages(group, 100).messages.length, 0);
    assert.equal(store.groupActivity({ group, since: 1699999999, until: 1700000001 }).groups[0].messages, 0);
    assert.equal(store.listMentions({ id: allowed }, { since: 0, limit: 50, offset: 0, chat: group }).messages.length, 0);
    // Own outbound rows and their chat metadata remain unaffected by the inbound policy.
    const own = { ...msg(`${PN}@s.whatsapp.net`, false, 'outbound-blocklisted'), messageTimestamp: 1700000200 };
    own.key.fromMe = true;
    await processEvents({ 'messages.upsert': { type: 'append', messages: [own] },
      'chats.update': [{ id: own.key.remoteJid, conversationTimestamp: own.messageTimestamp }] });
    assert.equal(store.chats.get(own.key.remoteJid).conversationTimestamp, own.messageTimestamp);
    assert.equal(store.listMessages(own.key.remoteJid, 100).messages.some(row => row.id === own.key.id), true);
    // The runtime also protects alternate entry points before language, code, or event writes.
    if (store === davidHistory) {
      const queued = runtime.store.unsentCount();
      await runtime.handleInbound({ id: 'direct-blocked-code', chatJid: group, senderJid: LID, altJid: '', fromMe: false, stub: false,
        text: 'code example-owner/sample-repo please fix this', mentions: [], pushName: 'Fake', timestampMs: 1700000000000 });
      assert.equal(runtime.store.unsentCount(), queued);
      assert.equal(runtime.store.countCode(['pending']), 0);
      assert.equal(runtime.store.getChatLang(group), null);
    }
  }

  // Simulate pre-deploy history. Adding a policy must never erase old rows.
  const purgeEntry = '525512345678@s.whatsapp.net';
  const purgeLid = '777777@lid';
  const purgeGroup = '808080@g.us';
  for (const store of [history, davidHistory]) {
    store.linkJids(purgeLid, '5215512345678@s.whatsapp.net');
    store.upsertMessage(msg(purgeEntry, false, 'old-dm'));
    store.upsertMessage({ ...msg(purgeLid, true, 'old-group'), key: { remoteJid: purgeGroup, participant: purgeLid, fromMe: false, id: 'old-group' } });
    store.upsertMessage({ ...msg(purgeEntry, false, 'own-kept'), key: { remoteJid: purgeEntry, fromMe: true, id: 'own-kept' } });
    store.upsertMessage({ ...msg('15555550901@s.whatsapp.net', true, 'other-kept'), key: { remoteJid: purgeGroup, participant: '15555550901@s.whatsapp.net', fromMe: false, id: 'other-kept' } });
    store.upsertChat({ id: purgeGroup, conversationTimestamp: 1700000000 });
    store.webhookBlocklist.add({ identifier: purgeEntry, approved_by: 'Test', reason: 'Test' });
    assert.equal(store.webhookBlocklist.list().entries.find(row => row.jid === purgeEntry).stored_count, 2);
    assert.equal(store.listMessages(purgeEntry, 100).messages.length, 2);
    assert.equal(store.upsertMessage(msg(purgeEntry, false, 'old-dm')), false); // replay leaves old history intact
    store.updateMessage({ remoteJid: purgeEntry, id: 'own-kept' }, { message: { conversation: 'own-updated' } });
    assert.equal(store.listMessages(purgeEntry, 100).messages.find(row => row.id === 'own-kept').text, 'own-updated');
    assert.throws(() => store.webhookBlocklist.purge(purgeEntry, undefined), /confirmation/);
  }
  runtime.store.enqueueOutbox({ chatId: purgeGroup, messageId: 'legacy-event', body: { sender_jid: purgeLid, text: content }, enqueuedAt: 1 });
  runtime.store.enqueueOutbox({ chatId: purgeGroup, messageId: 'legacy-sent-event', body: { sender_phone: '5215512345678', text: content }, enqueuedAt: 2 });
  runtime.store.markOutboxSent(runtime.store.blockedEvents(runtime.store.webhookBlocklist.list().entries.find(row => row.jid === purgeEntry), jid => davidHistory.phoneForJid(jid)).slice(-1), 3);
  assert.equal(runtime.store.webhookBlocklist.list().entries.find(row => row.jid === purgeEntry).event_count, 2);

  const app = express();
  mountDavidRead(app, { secret: SECRET, store: davidHistory, davidStore: runtime.store, role: 'david', aibmGroupJid: '' });
  const base = await listen(app);
  for (const endpoint of ['webhook-blocklist', 'webhook-blocklist/remove', 'webhook-blocklist/purge']) {
    for (const method of endpoint !== 'webhook-blocklist' ? ['POST'] : ['GET', 'POST']) {
      assert.equal((await fetch(`${base}/internal/admin/${endpoint}`, { method })).status, 401);
      for (const header of ['cf-ray', 'cf-connecting-ip', 'cf-ipcountry', 'x-forwarded-for']) {
        assert.equal((await fetch(`${base}/internal/admin/${endpoint}`, { method, headers: { Authorization: `Bearer ${SECRET}`, [header]: 'fake' } })).status, 404);
      }
    }
  }
  const peer = createDavidPeer({ secret: SECRET, baseUrl: base });
  assert.equal((await peer.blocklist()).ok, true);
  assert.equal((await peer.addBlocklist({ identifier: '15555550999', reason: 'Test', approved_by: 'Test' })).ok, true);
  assert.equal(history.webhookBlocklist.matches('15555550999'), false);
  assert.equal((await peer.removeBlocklist('15555550999')).ok, true);
  assert.equal((await peer.addBlocklist({ identifier: '15555550999', reason: 'Test' })).ok, false);

  const admin = express();
  mountAdmin(admin, { secret: SECRET, store: history, role: 'personal', peer });
  const adminBase = await listen(admin);
  assert.equal((await fetch(`${adminBase}/admin/david/webhook-blocklist/add`, { method: 'POST' })).status, 401);
  const login = await fetch(`${adminBase}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ secret: SECRET }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const html = await (await fetch(`${adminBase}/admin/david`, { headers: { Cookie: cookie } })).text();
  assert.match(html, /Webhook blocklist/);
  for (const account of ['personal', 'david']) {
    assert.match(html, new RegExp(`value="${account}"`));
    for (const operation of ['add', 'remove']) {
      const response = await fetch(`${adminBase}/admin/david/webhook-blocklist/${operation}`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ account, identifier: '15555550888', approved_by: 'Test', reason: 'Test' }) });
      assert.equal(response.status, 302, await response.text());
      assert.equal((account === 'personal' ? history : runtime.store).webhookBlocklist.matches('15555550888'), operation === 'add');
    }
  }

  for (const account of ['personal', 'david']) {
    const endpoint = `${adminBase}/admin/david/webhook-blocklist?account=${account}`;
    assert.equal((await fetch(endpoint)).status, 401);
    const beforeCount = (await (await fetch(endpoint, { headers: { Cookie: cookie } })).json()).entries.find(row => row.jid === purgeEntry).stored_count;
    const repeated = await (await fetch(endpoint, { headers: { Cookie: cookie } })).json();
    assert.equal(beforeCount, 2);
    assert.equal(repeated.entries.find(row => row.jid === purgeEntry).stored_count, 2);
    assert.ok(repeated.dropped > 0);
  }

  const postPurge = (body, auth = true) => fetch(`${adminBase}/admin/david/webhook-blocklist/purge`, { method: 'POST', redirect: 'manual',
    headers: { ...(auth ? { Cookie: cookie } : {}), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  assert.equal((await postPurge({ account: 'personal', identifier: purgeEntry }, false)).status, 401);
  assert.equal((await postPurge({ account: 'all', identifier: purgeEntry })).status, 400);
  assert.equal((await peer.purgeBlocklist(purgeEntry, '')).ok, false);
  for (const [account, store] of [['personal', history], ['david', davidHistory]]) {
    assert.equal((await postPurge({ account, identifier: purgeEntry, confirmation: 'PURGE' })).status, 400);
    const confirmation = await postPurge({ account, identifier: purgeEntry });
    assert.equal(confirmation.status, 200);
    const form = await confirmation.text();
    assert.match(form, /Confirm stored-message purge/);
    assert.equal(store.webhookBlocklist.list().entries.find(row => row.jid === purgeEntry).stored_count, 2);
    const fields = Object.fromEntries([...form.matchAll(/name="([^" ]+)" value="([^" ]*)"/g)].map(match => [match[1], match[2]]));
    assert.equal((await postPurge({ ...fields, confirmation: 'PURGE', account: account === 'personal' ? 'david' : 'personal' })).status, 400);
    assert.equal((await postPurge({ ...fields, confirmation: 'PURGE', expires: '1' })).status, 400);
    assert.equal((await postPurge({ ...fields, confirmation: 'PURGE', token: 'invalid' })).status, 400);
    assert.equal((await postPurge({ ...fields, confirmation: 'PURGE', identifier: `${PN}@s.whatsapp.net` })).status, 400);
    assert.equal((await postPurge({ ...fields, confirmation: 'PURGE' })).status, 302);
    const entry = store.webhookBlocklist.list().entries.find(row => row.jid === purgeEntry);
    assert.equal(entry.stored_count, 0);
    assert.equal(entry.event_count, 0);
    assert.deepEqual(store.listMessages(purgeEntry, 100).messages.map(row => row.id), ['own-kept']);
    assert.deepEqual(store.listMessages(purgeGroup, 100).messages.map(row => row.id), ['other-kept']);
    assert.equal(await store.getMessage({ remoteJid: purgeEntry, id: 'old-dm' }), undefined);
    assert.equal(await store.getMessage({ remoteJid: purgeGroup, id: 'old-group' }), undefined);
    if (account === 'personal') assert.equal(davidHistory.webhookBlocklist.list().entries.find(row => row.jid === purgeEntry).stored_count, 2);
  }

  const mcp = createMcpExpressApp({ host: '127.0.0.1' });
  for (const [role, store] of [['personal', history], ['david', runtime.store]]) {
    const handler = toNodeHandler(createMcpHandler(() => createMcpServer(wa, { role, allowSend: true, allowDelete: false, webhookBlocklist: store.webhookBlocklist })));
    mcp.all(`/${role}`, (req, res) => { void handler(req, res, req.body); });
  }
  const mcpBase = await listen(mcp);
  async function rpc(role, method, params) {
    const response = await fetch(`${mcpBase}/${role}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const raw = await response.text();
    const data = raw.startsWith('{') ? raw : raw.split('\n').find(line => line.startsWith('data: ')).slice(6);
    return JSON.parse(data).result;
  }
  for (const role of ['personal', 'david']) {
    const listed = await rpc(role, 'tools/list', {});
    for (const op of ['list', 'add', 'remove']) assert.equal(listed.tools.some(t => t.name === `whatsapp_webhook_blocklist_${op}`), true);
    assert.equal(listed.tools.some(t => t.name.includes('purge')), false);
    assert.equal((await rpc(role, 'tools/call', { name: 'whatsapp_action', arguments: { action: 'whatsapp_webhook_blocklist_purge', args: { identifier: purgeEntry, confirmation: 'PURGE' } } })).isError, true);
    const call = (op, args) => rpc(role, 'tools/call', { name: `whatsapp_webhook_blocklist_${op}`, arguments: args });
    for (const missing of ['approved_by', 'reason']) {
      const args = { identifier: '15555550777', approved_by: 'Test', reason: 'Test' };
      delete args[missing];
      assert.equal((await call('add', args)).isError, true);
    }
    assert.equal((await call('add', { identifier: LID, approved_by: 'Test', reason: 'Test' })).isError, true); // seed matches mapped LID
    assert.equal((await call('add', { identifier: '15555550777', approved_by: 'Test', reason: 'Test' })).isError, undefined);
    const result = JSON.parse((await call('list', {})).content[0].text);
    assert.equal(result.entries.some(e => e.phone === '15555550777'), true);
    assert.equal(result.entries.every(e => Number.isInteger(e.stored_count) && Number.isInteger(e.event_count)), true);
    assert.equal((await call('remove', { identifier: '15555550777' })).isError, undefined);
  }

  // Durable per-account migration markers, including an empty list after removal.
  for (const store of [history, runtime.store]) {
    for (const entry of store.webhookBlocklist.list().entries) store.webhookBlocklist.remove(entry.jid);
    assert.equal(store.webhookBlocklist.list().entries.length, 0);
  }
  history.close();
  runtime.store.close();
  const reopened = new MemoryStore(path.join(dir, 'personal.sqlite'));
  const reopenedDavid = new DavidStore(path.join(dir, 'david.sqlite'), '15555550123');
  for (const store of [reopened, reopenedDavid]) {
    assert.equal(store.webhookBlocklist.list().entries.length, 0);
    assert.equal(store.webhookBlocklist.matches(PN), false);
    assert.equal(store.webhookBlocklist.matches(LEGACY), false);
    assert.ok(store.webhookBlocklist.list().skipped > 0);
    assert.ok(store.webhookBlocklist.list().dropped > 0);
    store.close();
  }
  console.log('PASS: blocklist drops in both modes, history/append, groups, variants, previews/cache, counts, confirmed account-scoped purge, auth/404, MCP, and durable counters');
} finally {
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  try { await runtime?.stop(); } catch {}
  try { runtime?.store.close(); } catch {}
  try { history.close(); } catch {}
  davidHistory.close();
  await rm(dir, { recursive: true, force: true });
}
