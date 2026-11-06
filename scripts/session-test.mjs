import assert from 'node:assert/strict';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createBridgeMcpHandler } from '../dist/mcp-http.js';
import { createMcpServer } from '../dist/mcp-tools.js';

const wa = {
  getStatus: () => ({ state: 'disconnected', hasCreds: false }),
  getSocket: () => null,
  getStore: () => { throw new Error('session test must not read the store'); },
  resolveJid: async () => { throw new Error('session test must not resolve a chat'); },
  getAccount: () => ({}),
  start: async () => {},
};

function rpcMessages(body) {
  if (!body.startsWith('event:')) return [JSON.parse(body)];
  return body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
}

function rpcResponse(body) {
  const response = rpcMessages(body).find((message) => message && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')));
  assert.ok(response, body);
  return response;
}

async function listen(handler) {
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  const node = toNodeHandler(handler);
  app.all('/mcp', (req, res) => { void node(req, res, req.body); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

async function post(url, body, { session, authorization } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-03-26',
      ...authorization ? { Authorization: authorization } : {},
      ...session ? { 'mcp-session-id': session } : {},
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, session: response.headers.get('mcp-session-id'), cache: response.headers.get('cache-control'), text };
}

const initBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'session-test', version: '0' } },
};

function serverFactory() {
  return createMcpServer(wa, { role: 'test', allowSend: false, allowDelete: false });
}

async function initSession(url, authorization) {
  const init = await post(url, initBody, { authorization });
  assert.equal(init.status, 200, init.text);
  assert.match(init.session ?? '', /^[0-9a-f-]{36}$/);
  return init.session;
}

async function withHandler(handler, run) {
  const running = await listen(handler);
  try {
    await run(running.url);
  } finally {
    await handler.close();
    await new Promise((resolve) => running.server.close(resolve));
  }
}

const first = createBridgeMcpHandler(() => createMcpServer(wa, { role: 'test', allowSend: false, allowDelete: false }));
const running = await listen(first);

try {
  const init = await post(running.url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'session-test', version: '0' } },
  });
  assert.equal(init.status, 200);
  assert.match(init.session ?? '', /^[0-9a-f-]{36}$/);
  assert.match(init.cache ?? '', /no-cache/);
  const initialized = rpcResponse(init.text);
  assert.equal(initialized.result.capabilities.tools.listChanged, true);
  assert.equal(rpcMessages(init.text).some((message) => message.method === 'notifications/tools/list_changed'), false);

  await post(running.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, { session: init.session });
  const listed = await post(running.url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { session: init.session });
  assert.equal(listed.status, 200);
  const names = rpcResponse(listed.text).result.tools.map((tool) => tool.name);
  assert.equal(names.length, 23);
  assert.ok(names.includes('whatsapp_status'));
  assert.ok(names.includes('whatsapp_create_draft'));
  assert.ok(names.includes('whatsapp_find_contact'));
  assert.ok(names.includes('whatsapp_action'));

  const controller = new AbortController();
  const stream = await fetch(running.url, {
    headers: {
      Accept: 'text/event-stream',
      'mcp-protocol-version': '2025-03-26',
      'mcp-session-id': init.session,
    },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.match(stream.headers.get('cache-control') ?? '', /no-cache/);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let streamed = '';
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !streamed.includes('notifications/tools/list_changed')) {
    const next = await reader.read();
    if (next.done) break;
    streamed += decoder.decode(next.value);
  }
  controller.abort();
  assert.match(streamed, /notifications\/tools\/list_changed/);

  const stale = await post(running.url, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, { session: '00000000-0000-4000-8000-000000000000' });
  assert.equal(stale.status, 404);
  assert.match(stale.cache ?? '', /no-store/);
  assert.equal(rpcResponse(stale.text).error.message, 'Session not found');
  assert.doesNotMatch(stale.text, /400|Bad Request/);

  const openGet = await fetch(running.url, { headers: { Accept: 'text/event-stream' } });
  assert.equal(openGet.status, 405);
  await openGet.text();

  const bearer = 'Bearer session-test-token';
  const refresh = await post(running.url, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, { authorization: bearer });
  assert.equal(refresh.status, 200);
  assert.equal(rpcMessages(refresh.text).some((message) => message.method === 'notifications/tools/list_changed'), true);
  assert.equal(rpcResponse(refresh.text).result.tools.length, 23);
  const again = await post(running.url, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, { authorization: bearer });
  assert.equal(rpcMessages(again.text).some((message) => message.method === 'notifications/tools/list_changed'), false);

  const other = await post(running.url, { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} }, { authorization: 'Bearer other-session-test-token' });
  assert.equal(rpcMessages(other.text).some((message) => message.method === 'notifications/tools/list_changed'), true);
} finally {
  await first.close();
  await new Promise((resolve) => running.server.close(resolve));
}

const restarted = createBridgeMcpHandler(() => createMcpServer(wa, { role: 'test', allowSend: false, allowDelete: false }));
const next = await listen(restarted);
try {
  const stale = await post(next.url, { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }, { session: '11111111-1111-4111-8111-111111111111' });
  assert.equal(stale.status, 404);
  assert.equal(rpcResponse(stale.text).error.message, 'Session not found');
  const refresh = await post(next.url, { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} }, { authorization: 'Bearer session-test-token' });
  assert.equal(rpcMessages(refresh.text).some((message) => message.method === 'notifications/tools/list_changed'), true);
  assert.equal(rpcResponse(refresh.text).result.tools.length, 23);
  console.log('PASS: sessions advertise listChanged, notify on the event stream and after restart, and answer an unknown session with 404');
} finally {
  await restarted.close();
  await new Promise((resolve) => next.server.close(resolve));
}

const owner = 'Bearer owner-token';
const intruder = 'Bearer intruder-token';
await withHandler(createBridgeMcpHandler(serverFactory), async (url) => {
  const session = await initSession(url, owner);
  const listed = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { session, authorization: intruder });
  assert.equal(listed.status, 404);
  assert.match(listed.cache ?? '', /no-store/);
  assert.equal(rpcResponse(listed.text).error.message, 'Session not found');
  assert.equal(rpcResponse(listed.text).error.code, -32001);
  assert.equal(listed.text.includes(session), false);
  assert.equal(listed.text.includes('owner-token'), false);
  assert.equal(listed.text.includes('intruder-token'), false);

  const listen = await fetch(url, {
    headers: {
      Accept: 'text/event-stream',
      'mcp-protocol-version': '2025-03-26',
      'mcp-session-id': session,
      Authorization: intruder,
    },
  });
  const listenText = await listen.text();
  assert.equal(listen.status, 404);
  assert.match(listen.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(rpcResponse(listenText).error.message, 'Session not found');
  assert.equal(listenText.includes(session), false);

  const removed = await fetch(url, {
    method: 'DELETE',
    headers: {
      'mcp-protocol-version': '2025-03-26',
      'mcp-session-id': session,
      Authorization: intruder,
    },
  });
  const removedText = await removed.text();
  assert.equal(removed.status, 404);
  assert.match(removed.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(rpcResponse(removedText).error.message, 'Session not found');
  assert.equal(removedText.includes(session), false);

  const still = await post(url, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, { session, authorization: owner });
  assert.equal(still.status, 200);
  assert.equal(rpcResponse(still.text).result.tools.length, 23);

  const close = await fetch(url, {
    method: 'DELETE',
    headers: {
      'mcp-protocol-version': '2025-03-26',
      'mcp-session-id': session,
      Authorization: owner,
    },
  });
  await close.text();
  assert.equal(close.status, 200);
  const after = await post(url, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, { session, authorization: owner });
  assert.equal(after.status, 404);
  assert.equal(rpcResponse(after.text).error.message, 'Session not found');
});

const idleMs = 30 * 60 * 1000;
let clock = 1_000_000;
const idleHandler = createBridgeMcpHandler(serverFactory, { now: () => clock });
await withHandler(idleHandler, async (url) => {
  const session = await initSession(url, owner);
  clock += idleMs;
  const boundary = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { session, authorization: owner });
  assert.equal(boundary.status, 200, boundary.text);

  clock += idleMs + 1;
  const expired = await post(url, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, { session, authorization: owner });
  assert.equal(expired.status, 404);
  assert.equal(rpcResponse(expired.text).error.message, 'Session not found');
  const expiredGet = await fetch(url, {
    headers: {
      Accept: 'text/event-stream',
      'mcp-protocol-version': '2025-03-26',
      'mcp-session-id': session,
      Authorization: owner,
    },
  });
  assert.equal(expiredGet.status, 404);
  await expiredGet.text();
  const expiredDelete = await fetch(url, {
    method: 'DELETE',
    headers: {
      'mcp-protocol-version': '2025-03-26',
      'mcp-session-id': session,
      Authorization: owner,
    },
  });
  assert.equal(expiredDelete.status, 404);
  await expiredDelete.text();

  const untouched = await initSession(url, owner);
  clock += idleMs;
  const wrong = await post(url, { jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} }, { session: untouched, authorization: intruder });
  assert.equal(wrong.status, 404);
  clock += 1;
  const dropped = await post(url, { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} }, { session: untouched, authorization: owner });
  assert.equal(dropped.status, 404);

  const held = await initSession(url, owner);
  const stream = await idleHandler.fetch(new Request(url, {
    headers: {
      Accept: 'text/event-stream',
      'mcp-protocol-version': '2025-03-26',
      'mcp-session-id': held,
      Authorization: owner,
    },
  }));
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let streamed = '';
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !streamed.includes('notifications/tools/list_changed')) {
    const nextChunk = await reader.read();
    if (nextChunk.done) break;
    streamed += decoder.decode(nextChunk.value);
  }
  assert.match(streamed, /notifications\/tools\/list_changed/);
  clock += idleMs + 1;
  const whileListening = await post(url, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, { session: held, authorization: owner });
  assert.equal(whileListening.status, 200, whileListening.text);
  await reader.cancel();
  clock += idleMs + 1;
  const afterListen = await post(url, { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} }, { session: held, authorization: owner });
  assert.equal(afterListen.status, 404);

  const bearer = 'Bearer idle-refresh-token';
  const firstRefresh = await post(url, { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }, { authorization: bearer });
  assert.equal(rpcMessages(firstRefresh.text).some((message) => message.method === 'notifications/tools/list_changed'), true);
  clock += idleMs;
  const stillMarked = await post(url, { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} }, { authorization: bearer });
  assert.equal(rpcMessages(stillMarked.text).some((message) => message.method === 'notifications/tools/list_changed'), false);
  clock += idleMs + 1;
  const remarked = await post(url, { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }, { authorization: bearer });
  assert.equal(rpcMessages(remarked.text).some((message) => message.method === 'notifications/tools/list_changed'), true);
});

await withHandler(createBridgeMcpHandler(serverFactory), async (url) => {
  const other = await initSession(url, 'Bearer cap-other');
  const mineAuth = 'Bearer cap-mine';
  const mine = [];
  for (let n = 0; n < 8; n += 1) mine.push(await initSession(url, mineAuth));
  for (const id of mine) {
    const listed = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { session: id, authorization: mineAuth });
    assert.equal(listed.status, 200);
  }
  const ninth = await initSession(url, mineAuth);
  const evicted = await post(url, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, { session: mine[0], authorization: mineAuth });
  assert.equal(evicted.status, 404);
  assert.equal(rpcResponse(evicted.text).error.message, 'Session not found');
  const kept = await post(url, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, { session: mine[7], authorization: mineAuth });
  assert.equal(kept.status, 200);
  const newest = await post(url, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, { session: ninth, authorization: mineAuth });
  assert.equal(newest.status, 200);
  const outsider = await post(url, { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} }, { session: other, authorization: 'Bearer cap-other' });
  assert.equal(outsider.status, 200);
});

let built = 0;
await withHandler(createBridgeMcpHandler(() => {
  built += 1;
  return serverFactory();
}), async (url) => {
  const callers = Array.from({ length: 8 }, (_, index) => `Bearer cap-caller-${index}`);
  const ids = [];
  for (const authorization of callers) {
    const mine = [];
    for (let n = 0; n < 8; n += 1) mine.push(await initSession(url, authorization));
    ids.push(mine);
  }
  assert.equal(built, 64);
  const extra = await post(url, initBody, { authorization: 'Bearer cap-caller-extra' });
  assert.equal(extra.status, 503);
  assert.equal(extra.session, null);
  assert.match(extra.cache ?? '', /no-store/);
  assert.equal(rpcResponse(extra.text).error.message, 'Too many sessions.');
  assert.equal(extra.text.includes('cap-caller'), false);
  assert.equal(built, 64);
  const still = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { session: ids[3][0], authorization: callers[3] });
  assert.equal(still.status, 200);
  const ninth = await initSession(url, callers[0]);
  assert.equal(built, 65);
  const evicted = await post(url, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, { session: ids[0][0], authorization: callers[0] });
  assert.equal(evicted.status, 404);
  const neighbor = await post(url, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, { session: ids[1][0], authorization: callers[1] });
  assert.equal(neighbor.status, 200);
  const replaced = await post(url, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, { session: ninth, authorization: callers[0] });
  assert.equal(replaced.status, 200);
});

let marked = 0;
await withHandler(createBridgeMcpHandler(() => {
  marked += 1;
  return serverFactory();
}, { now: () => clock }), async (url) => {
  const bearers = Array.from({ length: 64 }, (_, index) => `Bearer refresh-caller-${index}`);
  for (const authorization of bearers) {
    const listed = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { authorization });
    assert.equal(rpcMessages(listed.text).some((message) => message.method === 'notifications/tools/list_changed'), true);
  }
  const extra = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { authorization: 'Bearer refresh-caller-extra' });
  assert.equal(rpcMessages(extra.text).some((message) => message.method === 'notifications/tools/list_changed'), true);
  const oldest = await post(url, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, { authorization: bearers[0] });
  assert.equal(rpcMessages(oldest.text).some((message) => message.method === 'notifications/tools/list_changed'), true);
  const kept = await post(url, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, { authorization: bearers[2] });
  assert.equal(rpcMessages(kept.text).some((message) => message.method === 'notifications/tools/list_changed'), false);
  assert.equal(marked, 67);
});

await withHandler(createBridgeMcpHandler(serverFactory, { now: () => clock }), async (url) => {
  const callers = Array.from({ length: 8 }, (_, index) => `Bearer idle-cap-${index}`);
  const ids = [];
  for (const authorization of callers) {
    for (let n = 0; n < 8; n += 1) ids.push(await initSession(url, authorization));
  }
  clock += idleMs + 1;
  const fresh = await initSession(url, 'Bearer idle-cap-fresh');
  const gone = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { session: ids[0], authorization: callers[0] });
  assert.equal(gone.status, 404);
  const listed = await post(url, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, { session: fresh, authorization: 'Bearer idle-cap-fresh' });
  assert.equal(listed.status, 200);
});

console.log('PASS: a session stays bound to its token, idle sessions expire, and caller caps leave other sessions in place');
