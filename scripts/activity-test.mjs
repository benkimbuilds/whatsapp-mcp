import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from '../dist/mcp-tools.js';
import { MemoryStore } from '../dist/store.js';

const dir = await mkdtemp(path.join(tmpdir(), 'whatsapp-activity-'));
const groupA = '120363400000000001@g.us';
const groupB = '120363400000000002@g.us';
const emptyGroup = '120363400000000077@g.us';
const direct = '111111111111112@lid';
const senderA = '111111111111201@lid';
const senderB = '111111111111202@lid';
const senderC = '111111111111203@lid';
const marker = 'activity-marker';
const unix = (iso) => Math.floor(Date.parse(iso) / 1000);
const since = unix('2026-10-01T00:00:00Z');
const until = unix('2026-10-03T12:00:00Z');
const store = new MemoryStore(path.join(dir, 'history.sqlite'));

function row(jid, id, timestamp, fromMe, participant) {
  store.upsertMessage({
    key: { remoteJid: jid, id, fromMe, ...(participant ? { participant } : {}) },
    messageTimestamp: timestamp,
    message: { conversation: marker },
  });
}

row(groupA, 'a-me-1', unix('2026-10-01T01:00:00Z'), true, senderA);
row(groupA, 'a-me-2', unix('2026-10-01T02:00:00Z'), true, senderA);
row(groupA, 'a-other', unix('2026-10-01T03:00:00Z'), false, senderB);
row(groupA, 'a-later', unix('2026-10-03T01:00:00Z'), false, senderB);
row(groupA, 'a-revoked', unix('2026-10-01T04:00:00Z'), false, senderC);
store.markDeletedForEveryone(groupA, 'a-revoked');
row(groupB, 'b-one', unix('2026-10-01T05:00:00Z'), false, senderC);
row(direct, 'direct', unix('2026-10-01T06:00:00Z'), false, senderC);

const wa = {
  getStatus: () => ({ state: 'disconnected', hasCreds: true }),
  getSocket: () => { throw new Error('activity must not open the socket'); },
  getStore: () => store,
  resolveJid: async () => { throw new Error('activity must not resolve a chat'); },
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
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whatsapp_group_activity', arguments: args } }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const json = body.startsWith('event:')
    ? JSON.parse(body.split('\n').find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(body);
  return json.result;
}

try {
  const result = await call({ since, until });
  assert.equal(result.isError, undefined);
  const body = result.content[0].text;
  for (const secret of [senderA, senderB, senderC, marker, direct]) assert.equal(body.includes(secret), false, secret);
  const report = JSON.parse(body);
  assert.equal(report.truncated, false);
  assert.deepEqual(report.groups.map((group) => group.jid), [groupA, groupB]);
  const [first, second] = report.groups;
  assert.equal(first.messages, 4);
  assert.equal(first.activeSenders, 2);
  assert.deepEqual(first.days, [
    { date: '2026-10-01', messages: 3, activeSenders: 2 },
    { date: '2026-10-02', messages: 0, activeSenders: 0 },
    { date: '2026-10-03', messages: 1, activeSenders: 1 },
  ]);
  assert.equal(second.messages, 1);
  assert.equal(second.activeSenders, 1);
  assert.equal(second.days[1].messages, 0);

  const empty = JSON.parse((await call({ group: emptyGroup, since, until })).content[0].text);
  assert.equal(empty.groups.length, 1);
  assert.equal(empty.groups[0].messages, 0);
  assert.equal(empty.groups[0].activeSenders, 0);
  assert.equal(empty.groups[0].days.length, 3);

  const rejected = await call({ group: 'not-a-group', since, until });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /@g\.us/);
  const wide = await call({ since: 0, until: 92 * 24 * 60 * 60 + 1 });
  assert.equal(wide.isError, true);
  assert.match(wide.content[0].text, /92 days/);
  console.log('PASS: group activity returns daily counts and distinct senders without text or sender ids');
} finally {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  await rm(dir, { recursive: true, force: true });
}
