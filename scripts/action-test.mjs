import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from '../dist/mcp-tools.js';
import { MemoryStore } from '../dist/store.js';

const dir = await mkdtemp(path.join(tmpdir(), 'whatsapp-action-'));
const chat = '15555550100@s.whatsapp.net';
const store = new MemoryStore(path.join(dir, 'history.sqlite'));
store.upsertChat({ id: chat, name: 'Example', conversationTimestamp: 10 });
store.upsertMessage({
  key: { remoteJid: chat, id: 'm1', fromMe: false },
  messageTimestamp: 10,
  message: { conversation: 'saved row' },
});

const calls = [];
const wa = {
  getStatus: () => ({ state: 'disconnected', hasCreds: true }),
  getSocket: () => { calls.push('socket'); throw new Error('action test must not open the socket'); },
  getStore: () => store,
  resolveJid: async () => { calls.push('resolve'); throw new Error('action test must not resolve a chat'); },
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
  assert.equal(response.status, 200, await response.clone().text());
  return rpc(await response.text());
}

try {
  const listed = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const tools = rpc(await listed.text()).tools.map((tool) => tool.name);
  assert.equal(tools.length, 23);
  assert.ok(tools.includes("whatsapp_resolve_recipient"));
  assert.equal(tools.includes('ping'), false);
  assert.ok(tools.includes('whatsapp_action'));
  assert.ok(tools.includes('whatsapp_list_chats'));
  assert.ok(tools.includes('whatsapp_send_text'));
  assert.ok(tools.includes('whatsapp_delete_for_everyone'));
  const actionTool = rpc(await (await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })).text()).tools.find((tool) => tool.name === 'whatsapp_action');
  const actionProperties = Object.keys(actionTool.inputSchema?.properties ?? actionTool.inputSchema?.schema?.properties ?? {});
  assert.deepEqual(actionProperties.sort(), ['action', 'args']);

  const catalog = JSON.parse((await call('whatsapp_action', { action: 'list_actions' })).content[0].text);
  const names = catalog.actions.map((item) => item.action);
  assert.equal(names[0], 'list_actions');
  for (const tool of tools.filter((name) => name !== 'whatsapp_action')) assert.ok(names.includes(tool), tool);
  const listedChats = catalog.actions.find((item) => item.action === 'whatsapp_list_chats');
  assert.match(listedChats.description, /contact name/);
  assert.equal(listedChats.inputSchema.type, 'object');
  assert.equal(listedChats.inputSchema.properties.limit.default, 50);
  assert.equal(catalog.actions.find((item) => item.action === 'list_actions').inputSchema.type, 'object');
  const pingSpec = catalog.actions.find((item) => item.action === 'ping');
  assert.equal(pingSpec.inputSchema.type, 'object');
  const ping = JSON.parse((await call('whatsapp_action', { action: 'ping' })).content[0].text);
  assert.deepEqual(Object.keys(ping).sort(), ['buildTime', 'ok', 'version']);
  assert.equal(ping.ok, true);
  assert.equal(ping.version, '1.0.0');
  assert.match(ping.buildTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.equal(calls.length, 0);

  const direct = JSON.parse((await call('whatsapp_list_chats', { limit: 1 })).content[0].text);
  const viaAction = JSON.parse((await call('whatsapp_action', { action: 'whatsapp_list_chats', args: { limit: 1 } })).content[0].text);
  assert.deepEqual(viaAction, direct);
  assert.equal(viaAction.chats[0].name, 'Example');
  const defaults = JSON.parse((await call('whatsapp_action', { action: 'whatsapp_list_chats' })).content[0].text);
  assert.equal(defaults.chats[0].id, chat);

  const read = JSON.parse((await call('whatsapp_action', {
    action: 'whatsapp_read_messages',
    args: { chat, limit: 5 },
  })).content[0].text);
  assert.deepEqual(read.messages.map((message) => message.text), ['saved row']);
  assert.equal(read.account, 'test');
  assert.equal(read.messages[0].fromMe, false);
  assert.equal(Object.hasOwn(read.messages[0], 'sentByAccount'), false);

  const unknown = await call('whatsapp_action', { action: 'nope' });
  assert.equal(unknown.isError, true);
  const unknownText = JSON.parse(unknown.content[0].text).error;
  assert.match(unknownText, /Unknown action "nope"/);
  assert.match(unknownText, /Valid actions: list_actions, .*whatsapp_status/);
  assert.match(unknownText, /whatsapp_send_draft/);
  assert.equal(unknownText.includes('Example'), false);

  const invalid = await call('whatsapp_action', { action: 'whatsapp_list_chats', args: { limit: 0 } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /Invalid args for whatsapp_list_chats/);
  assert.match(invalid.content[0].text, /limit/);

  const missing = await call('whatsapp_action', { action: 'whatsapp_find_contact', args: {} });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Invalid args for whatsapp_find_contact/);
  assert.match(missing.content[0].text, /query/);

  const refusedSend = await call('whatsapp_action', { action: 'whatsapp_send_text', args: { to: chat, text: 'hello' } });
  assert.equal(refusedSend.isError, true);
  assert.match(refusedSend.content[0].text, /ALLOW_SEND=false/);
  const refusedDelete = await call('whatsapp_action', {
    action: 'whatsapp_delete_for_everyone',
    args: { chat, messageId: 'm1' },
  });
  assert.equal(refusedDelete.isError, true);
  assert.match(refusedDelete.content[0].text, /ALLOW_DELETE=false/);
  assert.equal(calls.length, 0);
  console.log('PASS: whatsapp_action lists actions, validates args, and runs existing tools with the same gates');
} finally {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  await rm(dir, { recursive: true, force: true });
}
