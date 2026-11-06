import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { mountAdmin } from '../dist/admin.js';
import { createMcpServer } from '../dist/mcp-tools.js';
import { MemoryStore } from '../dist/store.js';

const dir = await mkdtemp(path.join(tmpdir(), 'whatsapp-admin-'));
const secret = 'admin-secret-for-tests-only-0123456789';
const chat = '15555550100@s.whatsapp.net';
const now = Math.floor(Date.now() / 1000);
const store = new MemoryStore(path.join(dir, 'history.sqlite'));
store.upsertChat({ id: chat, name: 'Zebra <Chat>', unreadCount: 3, conversationTimestamp: now });
store.upsertMessage({
  key: { remoteJid: chat, id: 'm1', fromMe: false },
  messageTimestamp: now,
  message: { conversation: 'zebra-message-body' },
});

const calls = [];
const wa = {
  getStatus: () => ({ state: 'disconnected', hasCreds: true }),
  getSocket: () => { calls.push('socket'); throw new Error('admin test must not open the socket'); },
  getStore: () => store,
  resolveJid: async () => { calls.push('resolve'); throw new Error('admin test must not resolve a chat'); },
  getAccount: () => ({}),
  start: async () => {},
};

const app = express();
mountAdmin(app, { secret, store, role: 'personal' });
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const mcpApp = createMcpExpressApp({ host: '127.0.0.1' });
const handler = toNodeHandler(createMcpHandler(() => createMcpServer(wa, { role: 'personal', allowSend: false, allowDelete: false })));
mcpApp.all('/mcp', (req, res) => { void handler(req, res, req.body); });
const mcpServer = mcpApp.listen(0, '127.0.0.1');
await new Promise((resolve) => mcpServer.once('listening', resolve));
const mcpUrl = `http://127.0.0.1:${mcpServer.address().port}/mcp`;

async function callTool(name, args) {
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.text();
  const json = body.startsWith('event:')
    ? JSON.parse(body.split('\n').find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(body);
  return json.result;
}

try {
  const disabled = express();
  mountAdmin(disabled, { secret: 'too-short', store, role: 'personal' });
  const disabledServer = disabled.listen(0, '127.0.0.1');
  await new Promise((resolve) => disabledServer.once('listening', resolve));
  const disabledBase = `http://127.0.0.1:${disabledServer.address().port}`;
  const hidden = await fetch(`${disabledBase}/admin`);
  assert.equal(hidden.status, 404);
  assert.equal((await hidden.text()).includes('zebra-message-body'), false);
  await new Promise((resolve) => disabledServer.close(resolve));

  const loginPage = await fetch(`${base}/admin/login`);
  assert.equal(loginPage.status, 200);
  assert.equal((await loginPage.text()).includes('zebra-message-body'), false);

  const browser = await fetch(`${base}/admin`, { headers: { Accept: 'text/html' }, redirect: 'manual' });
  assert.equal(browser.status, 302);
  assert.equal(browser.headers.get('location'), '/admin/login');

  const denied = await fetch(`${base}/admin/messages?jid=${encodeURIComponent(chat)}`);
  assert.equal(denied.status, 401);
  assert.equal((await denied.text()).includes('zebra-message-body'), false);

  const wrong = await fetch(`${base}/admin/chats`, { headers: { Authorization: 'Bearer not-the-admin-secret-value' } });
  assert.equal(wrong.status, 401);

  const chats = await fetch(`${base}/admin/chats`, { headers: { Authorization: `Bearer ${secret}` } });
  assert.equal(chats.status, 200);
  const chatsHtml = await chats.text();
  assert.match(chatsHtml, /Zebra &lt;Chat&gt;/);
  assert.equal(chatsHtml.includes('Zebra <Chat>'), false);
  assert.match(chatsHtml, /15555550100@s\.whatsapp\.net/);
  assert.match(chatsHtml, />3</);

  const messages = await fetch(`${base}/admin/messages?jid=${encodeURIComponent(chat)}`, { headers: { Authorization: `Bearer ${secret}` } });
  assert.equal(messages.status, 200);
  assert.match(await messages.text(), /zebra-message-body/);

  const found = await fetch(`${base}/admin/messages?jid=${encodeURIComponent(chat)}&q=zebra`, { headers: { Authorization: `Bearer ${secret}` } });
  assert.match(await found.text(), /zebra-message-body/);
  const missed = await fetch(`${base}/admin/messages?jid=${encodeURIComponent(chat)}&q=no-such-word`, { headers: { Authorization: `Bearer ${secret}` } });
  assert.equal((await missed.text()).includes('zebra-message-body'), false);

  const activity = await fetch(`${base}/admin/activity`, { headers: { Authorization: `Bearer ${secret}` } });
  assert.match(await activity.text(), /zebra-message-body/);
  const stats = await fetch(`${base}/admin/stats`, { headers: { Authorization: `Bearer ${secret}` } });
  const statsHtml = await stats.text();
  assert.match(statsHtml, /Zebra &lt;Chat&gt;/);
  assert.match(statsHtml, /15555550100@s\.whatsapp\.net/);

  const login = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret }),
    redirect: 'manual',
  });
  assert.equal(login.status, 302);
  const setCookie = login.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\/admin/i);
  const authedPage = await fetch(`${base}/admin`, { headers: { Cookie: setCookie.split(';')[0], Accept: 'text/html' } });
  assert.equal(authedPage.status, 200);
  assert.match(await authedPage.text(), /1 chats, 1 messages/);

  const listed = await callTool('whatsapp_list_chats', { limit: 1 });
  assert.equal(listed.isError, undefined);
  assert.equal(JSON.parse(listed.content[0].text).chats[0].name, 'Zebra <Chat>');
  const refused = await callTool('whatsapp_send_text', { to: chat, text: 'super-secret-body' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /ALLOW_SEND=false/);
  assert.equal(calls.length, 0);

  const requests = await fetch(`${base}/admin/requests`, { headers: { Authorization: `Bearer ${secret}` } });
  const requestHtml = await requests.text();
  assert.match(requestHtml, /whatsapp_list_chats/);
  assert.match(requestHtml, /limit=1/);
  assert.match(requestHtml, /whatsapp_send_text/);
  assert.match(requestHtml, /error/);
  assert.equal(requestHtml.includes('super-secret-body'), false);
  assert.equal(requestHtml.includes('zebra-message-body'), false);
  assert.equal(requestHtml.includes('@s.whatsapp.net'), false);

  const mutate = await fetch(`${base}/admin/chats`, { method: 'POST', headers: { Authorization: `Bearer ${secret}` } });
  assert.equal(mutate.status, 404);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const failed = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: `wrong-secret-${attempt}-xxxxxxxxxxxx` }),
    });
    assert.equal(failed.status, 401);
    assert.equal((await failed.text()).includes('zebra-message-body'), false);
  }
  const locked = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret }),
  });
  assert.equal(locked.status, 429);

  console.log('PASS: admin UI requires a secret, stays read-only, and redacts MCP request logs');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => mcpServer.close(resolve));
  store.close();
  await rm(dir, { recursive: true, force: true });
}
