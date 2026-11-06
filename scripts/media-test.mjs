import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Boom } from '@hapi/boom';
import { createMcpServer } from '../dist/mcp-tools.js';
import {
  EXPIRED_MEDIA_OFFLINE,
  MEDIA_MAX_BYTES,
  MISSING_MEDIA_KEY,
  downloadPreparedMedia,
  mediaTooLargeMessage,
} from '../dist/media.js';
import { MemoryStore } from '../dist/store.js';

const dir = await mkdtemp(path.join(tmpdir(), 'whatsapp-media-'));
const chat = '15555550100@s.whatsapp.net';
const group = '120363300000000099@g.us';
const sender = '111111111111111@lid';
const mediaKey = Buffer.alloc(32, 7);
const pdf = Buffer.from('%PDF-1.4 invoice');

const dbPath = path.join(dir, 'history.sqlite');
const store = new MemoryStore(dbPath);
store.upsertMessage({
  key: { remoteJid: chat, id: 'text-1', fromMe: false },
  messageTimestamp: 10,
  message: { conversation: 'plain text' },
});
store.upsertMessage({
  key: { remoteJid: chat, id: 'doc-1', fromMe: false },
  messageTimestamp: 20,
  message: {
    documentWithCaptionMessage: {
      message: {
        documentMessage: {
          caption: 'see attached',
          fileName: '../../factura-abril.xml',
          mimetype: 'application/xml',
          fileLength: { toNumber: () => pdf.length },
          mediaKey,
          directPath: '/v/old',
          url: 'https://127.0.0.1/secret',
        },
      },
    },
  },
});
store.upsertMessage({
  key: { remoteJid: chat, id: 'img-1', fromMe: true },
  messageTimestamp: 30,
  message: {
    imageMessage: {
      mimetype: 'image/jpeg',
      mediaKey,
      directPath: '/v/image',
      url: 'https://mmg.whatsapp.net/v/image',
    },
  },
});
store.upsertMessage({
  key: { remoteJid: group, id: 'voice-1', fromMe: false, participant: sender },
  messageTimestamp: 40,
  pushName: 'accountant',
  message: {
    audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus', mediaKey, directPath: '/v/voice' },
  },
});
store.upsertMessage({
  key: { remoteJid: chat, id: 'nokey-1', fromMe: false },
  messageTimestamp: 50,
  message: {
    documentMessage: { fileName: 'missing-key.pdf', mimetype: 'application/pdf', url: 'https://mmg.whatsapp.net/v/nokey' },
  },
});
store.upsertMessage({
  key: { remoteJid: chat, id: 'huge-1', fromMe: false },
  messageTimestamp: 60,
  message: {
    documentMessage: {
      fileName: 'huge.pdf',
      mimetype: 'application/pdf',
      fileLength: MEDIA_MAX_BYTES + 1,
      mediaKey,
      directPath: '/v/huge',
    },
  },
});
store.upsertMessage({
  key: { remoteJid: chat, id: 'old-placeholder', fromMe: false },
  messageTimestamp: 5,
  message: { conversation: '[document] legacy.pdf' },
});
store.upsertMessage({
  key: { remoteJid: chat, id: 'doc-1', fromMe: false },
  messageTimestamp: 20,
  message: { conversation: 'status update without media' },
});

const saved = store.getStoredMedia(chat, 'doc-1');
assert.equal(saved.media.filename, 'factura-abril.xml');
assert.equal(saved.media.mimetype, 'application/xml');
assert.equal(saved.media.kind, 'document');
assert.equal(saved.media.size, pdf.length);
assert.equal(saved.media.url, null);
assert.equal(saved.media.directPath, '/v/old');
assert.equal(Buffer.compare(Buffer.from(saved.media.mediaKey), mediaKey), 0);
assert.equal(saved.text, 'status update without media');

const listed = store.listMessages(chat, 20);
const docRow = listed.messages.find((message) => message.id === 'doc-1');
const textRow = listed.messages.find((message) => message.id === 'text-1');
assert.equal(textRow.hasMedia, false);
assert.equal(textRow.filename, undefined);
assert.equal(docRow.hasMedia, true);
assert.equal(docRow.filename, 'factura-abril.xml');
assert.equal(docRow.mimetype, 'application/xml');
assert.equal(JSON.stringify(listed).includes(mediaKey.toString('base64')), false);
const imageRow = listed.messages.find((message) => message.id === 'img-1');
assert.equal(imageRow.text, '[image]');
assert.equal(imageRow.filename, 'image.jpg');
assert.equal(imageRow.mimetype, 'image/jpeg');
const voice = store.listMessages(group, 5).messages.find((message) => message.id === 'voice-1');
assert.equal(voice.text, '[voice]');
assert.equal(voice.filename, 'voice.ogg');
assert.equal(voice.hasMedia, true);

const byName = store.searchMessages('factura-abril', { chat, limit: 10, offset: 0 });
assert.deepEqual(byName.messages.map((message) => message.id), ['doc-1']);
assert.equal(byName.messages[0].hasMedia, true);
assert.equal(byName.messages[0].filename, 'factura-abril.xml');
assert.equal(byName.messages[0].mimetype, 'application/xml');
assert.equal(byName.messages[0].snippet.includes('factura-abril.xml'), true);

store.close();
const reopened = new MemoryStore(dbPath);
const kept = reopened.getStoredMedia(chat, 'doc-1');
assert.equal(Buffer.compare(Buffer.from(kept.media.mediaKey), mediaKey), 0);
assert.equal(reopened.listMessages(chat, 20).messages.find((message) => message.id === 'doc-1').filename, 'factura-abril.xml');
reopened.markDeletedForEveryone(chat, 'img-1');
const removed = reopened.getStoredMedia(chat, 'img-1');
assert.equal(removed.deletedForEveryone, true);
assert.equal(removed.media, null);
assert.equal(reopened.listMessages(chat, 20).messages.find((message) => message.id === 'img-1').hasMedia, false);
reopened.close();

const legacyPath = path.join(dir, 'legacy', 'history.sqlite');
await mkdir(path.dirname(legacyPath), { recursive: true });
const legacyDb = new DatabaseSync(legacyPath);
legacyDb.exec(`CREATE TABLE messages (
  jid TEXT NOT NULL, id TEXT NOT NULL, from_me INTEGER, timestamp INTEGER,
  push_name TEXT, text TEXT, PRIMARY KEY (jid, id)
)`);
legacyDb.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(chat, 'legacy-text', 0, 1, null, 'hello');
legacyDb.close();
const migrated = new MemoryStore(legacyPath);
assert.equal(migrated.listMessages(chat, 5).messages[0].hasMedia, false);
migrated.upsertMessage({
  key: { remoteJid: chat, id: 'legacy-doc', fromMe: false },
  messageTimestamp: 2,
  message: { documentMessage: { fileName: 'a.pdf', mimetype: 'application/pdf', mediaKey, directPath: '/v/a' } },
});
assert.equal(migrated.getStoredMedia(chat, 'legacy-doc').media.filename, 'a.pdf');
migrated.close();

let returned = false;
const limited = {
  async *[Symbol.asyncIterator]() {
    try {
      yield Buffer.alloc(5);
      yield Buffer.alloc(5);
    } finally {
      returned = true;
    }
  },
};
await assert.rejects(
  () => downloadPreparedMedia({
    message: {
      key: { remoteJid: chat, id: 'stream', fromMe: false },
      message: { documentMessage: { fileName: 'a.pdf', mimetype: 'application/pdf', mediaKey, directPath: '/v/a' } },
    },
    maxBytes: 8,
    download: async () => limited,
  }),
  (error) => error.code === 'too_large' && error.message === mediaTooLargeMessage(10, 8),
);
assert.equal(returned, true);

const exact = await downloadPreparedMedia({
  message: {
    key: { remoteJid: chat, id: 'exact', fromMe: false },
    message: { imageMessage: { mimetype: 'image/png', mediaKey, directPath: '/v/exact' } },
  },
  maxBytes: 4,
  download: async () => Buffer.from('abcd'),
});
assert.equal(exact.buffer.toString(), 'abcd');
assert.equal(exact.filename, 'image.png');
assert.equal(exact.reuploaded, false);

let attempts = 0;
const refreshed = await downloadPreparedMedia({
  message: {
    key: { remoteJid: group, id: 'retry', fromMe: false, participant: sender },
    message: { documentMessage: { fileName: 'b.pdf', mimetype: 'application/pdf', mediaKey, directPath: '/v/stale', url: 'https://mmg.whatsapp.net/v/stale' } },
  },
  maxBytes: 100,
  download: async (message) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Boom('Failed to fetch stream from https://mmg.whatsapp.net/v/stale', { statusCode: 410 });
      throw error;
    }
    assert.equal(message.message.documentMessage.directPath, '/v/fresh');
    return Buffer.from('ok');
  },
  reupload: async (message) => {
    assert.equal(message.key.participant, sender);
    message.message.documentMessage.directPath = '/v/fresh';
    message.message.documentMessage.url = 'https://mmg.whatsapp.net/v/fresh';
    return message;
  },
});
assert.equal(attempts, 2);
assert.equal(refreshed.reuploaded, true);
assert.equal(refreshed.directPath, '/v/fresh');
assert.equal(JSON.stringify(refreshed).includes('mmg.whatsapp.net/v/stale'), false);

await assert.rejects(
  () => downloadPreparedMedia({
    message: {
      key: { remoteJid: chat, id: 'offline', fromMe: false },
      message: { documentMessage: { fileName: 'c.pdf', mimetype: 'application/pdf', mediaKey, directPath: '/v/c' } },
    },
    maxBytes: 100,
    download: async () => {
      throw Object.assign(new Error('gone'), { status: 404 });
    },
  }),
  (error) => error.code === 'expired' && error.message === EXPIRED_MEDIA_OFFLINE,
);

await assert.rejects(
  () => downloadPreparedMedia({
    message: {
      key: { remoteJid: chat, id: 'bad-reupload', fromMe: false },
      message: { documentMessage: { fileName: 'c.pdf', mimetype: 'application/pdf', mediaKey, directPath: '/v/c' } },
    },
    maxBytes: 100,
    download: async () => {
      throw Object.assign(new Error('gone'), { output: { statusCode: 410 } });
    },
    reupload: async () => {
      throw new Error('Media re-upload failed by device (NOT_FOUND) https://evil.example/secret');
    },
  }),
  (error) => error.code === 'reupload_failed' && !error.message.includes('http') && error.message.includes('could not re-upload'),
);

await assert.rejects(
  () => downloadPreparedMedia({
    message: {
      key: { remoteJid: chat, id: 'empty-key', fromMe: false },
      message: { documentMessage: { fileName: 'c.pdf', mimetype: 'application/pdf' } },
    },
    maxBytes: 100,
    download: async () => {
      throw new Error('download should not run');
    },
  }),
  (error) => error.code === 'missing_key' && error.message === MISSING_MEDIA_KEY,
);

const calls = [];
let state = 'disconnected';
const live = new MemoryStore(path.join(dir, 'live.sqlite'));
live.upsertMessage({
  key: { remoteJid: group, id: 'live-doc', fromMe: false, participant: sender },
  messageTimestamp: 70,
  message: {
    documentMessage: {
      fileName: 'live.pdf',
      mimetype: 'application/pdf',
      mediaKey,
      directPath: '/v/old',
      url: 'https://mmg.whatsapp.net/v/old',
    },
  },
});
live.upsertMessage({
  key: { remoteJid: chat, id: 'live-text', fromMe: false },
  messageTimestamp: 71,
  message: { conversation: 'no file here' },
});
live.upsertMessage({
  key: { remoteJid: chat, id: 'live-nokey', fromMe: false },
  messageTimestamp: 72,
  message: { documentMessage: { fileName: 'nokey.pdf', mimetype: 'application/pdf' } },
});
live.upsertMessage({
  key: { remoteJid: chat, id: 'live-huge', fromMe: false },
  messageTimestamp: 73,
  message: {
    documentMessage: { fileName: 'huge.pdf', mimetype: 'application/pdf', fileLength: MEDIA_MAX_BYTES + 5, mediaKey, directPath: '/v/huge' },
  },
});
live.upsertMessage({
  key: { remoteJid: chat, id: 'live-old', fromMe: false },
  messageTimestamp: 74,
  message: { conversation: '[document] already-gone.pdf' },
});
live.markDeletedForEveryone(group, 'live-doc');
live.upsertMessage({
  key: { remoteJid: group, id: 'live-doc', fromMe: false, participant: sender },
  messageTimestamp: 70,
  message: {
    documentMessage: {
      fileName: 'live.pdf',
      mimetype: 'application/pdf',
      mediaKey,
      directPath: '/v/old',
    },
  },
});
assert.equal(live.getStoredMedia(group, 'live-doc').media, null);

live.upsertMessage({
  key: { remoteJid: chat, id: 'live-ok', fromMe: false },
  messageTimestamp: 80,
  message: {
    ephemeralMessage: {
      message: {
        documentMessage: {
          fileName: 'ok.pdf',
          mimetype: 'application/pdf',
          mediaKey,
          directPath: '/v/ok',
          fileLength: pdf.length,
        },
      },
    },
  },
});

const socket = {
  sendMessage: async () => {
    calls.push('send');
    throw new Error('download must not send');
  },
  updateMediaMessage: async (message) => {
    calls.push(['reupload', message.key.participant ?? null, message.key.id]);
    message.message.documentMessage.directPath = '/v/new-path';
    message.message.documentMessage.url = 'https://mmg.whatsapp.net/v/new-path';
    return message;
  },
};
const wa = {
  getStatus: () => ({ state, hasCreds: true }),
  getSocket: () => {
    calls.push('socket');
    if (state !== 'open') throw new Error('socket while disconnected');
    return socket;
  },
  getStore: () => live,
  resolveJid: async (value) => {
    calls.push('resolve');
    return value;
  },
  getAccount: () => ({}),
  fetchMedia: async (message) => {
    calls.push(['fetch', message.key.id, message.message?.documentMessage?.directPath ?? null]);
    if (message.message?.documentMessage?.directPath === '/v/old') {
      throw Object.assign(new Error('Failed to fetch stream from https://mmg.whatsapp.net/v/old'), { output: { statusCode: 410 } });
    }
    return pdf;
  },
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
  assert.equal(response.status, 200);
  return rpc(await response.text());
}

try {
  const listedTools = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const tools = rpc(await listedTools.text()).tools.map((tool) => tool.name);
  assert.equal(tools.length, 23);
  assert.equal(tools.includes('whatsapp_download_media'), true);
  assert.equal(tools.includes('whatsapp_send_media'), true);

  const catalog = JSON.parse((await call('whatsapp_action', { action: 'list_actions' })).content[0].text);
  const spec = catalog.actions.find((item) => item.action === 'whatsapp_download_media');
  assert.equal(spec.inputSchema.properties.chat.type, 'string');
  assert.equal(spec.inputSchema.properties.messageId.type, 'string');
  assert.match(spec.description, /base64/);
  assert.match(spec.description, new RegExp(String(MEDIA_MAX_BYTES)));

  const read = JSON.parse((await call('whatsapp_action', {
    action: 'whatsapp_read_messages',
    args: { chat, limit: 20 },
  })).content[0].text);
  assert.equal(read.messages.find((message) => message.id === 'live-text').hasMedia, false);
  assert.equal(read.messages.find((message) => message.id === 'live-ok').filename, 'ok.pdf');
  assert.equal(read.messages.find((message) => message.id === 'live-ok').mimetype, 'application/pdf');
  const found = JSON.parse((await call('whatsapp_search_messages', {
    query: 'ok.pdf',
    chat,
  })).content[0].text);
  assert.equal(found.messages[0].id, 'live-ok');
  assert.equal(found.messages[0].hasMedia, true);

  const downloaded = JSON.parse((await call('whatsapp_action', {
    action: 'whatsapp_download_media',
    args: { chat, messageId: 'live-ok' },
  })).content[0].text);
  assert.equal(downloaded.filename, 'ok.pdf');
  assert.equal(downloaded.mimetype, 'application/pdf');
  assert.equal(downloaded.size, pdf.length);
  assert.equal(downloaded.kind, 'document');
  assert.equal(Buffer.from(downloaded.base64, 'base64').equals(pdf), true);
  assert.equal(JSON.stringify(downloaded).includes(mediaKey.toString('base64')), false);
  assert.equal(JSON.stringify(downloaded).includes('/v/ok'), false);
  assert.equal(calls.includes('send'), false);
  assert.equal(calls.includes('socket'), false);

  const missing = await call('whatsapp_action', { action: 'whatsapp_download_media', args: { chat, messageId: 'missing' } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Message not found/);
  const plain = await call('whatsapp_action', { action: 'whatsapp_download_media', args: { chat, messageId: 'live-text' } });
  assert.match(plain.content[0].text, /no attached/);
  const old = await call('whatsapp_action', { action: 'whatsapp_download_media', args: { chat, messageId: 'live-old' } });
  assert.match(old.content[0].text, /before the media key was stored/);
  const noKey = await call('whatsapp_action', { action: 'whatsapp_download_media', args: { chat, messageId: 'live-nokey' } });
  assert.match(noKey.content[0].text, /media key for this message was not saved/);
  const huge = await call('whatsapp_action', { action: 'whatsapp_download_media', args: { chat, messageId: 'live-huge' } });
  assert.match(huge.content[0].text, new RegExp(String(MEDIA_MAX_BYTES)));
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'fetch' && call[1] !== 'live-ok'), false);

  live.upsertMessage({
    key: { remoteJid: group, id: 'live-retry', fromMe: false, participant: sender },
    messageTimestamp: 90,
    message: {
      documentMessage: { fileName: 'retry.pdf', mimetype: 'application/pdf', mediaKey, directPath: '/v/old' },
    },
  });
  state = 'open';
  const retried = JSON.parse((await call('whatsapp_action', {
    action: 'whatsapp_download_media',
    args: { chat: group, messageId: 'live-retry' },
  })).content[0].text);
  assert.equal(Buffer.from(retried.base64, 'base64').equals(pdf), true);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === 'reupload'), [['reupload', sender, 'live-retry']]);
  assert.equal(live.getStoredMedia(group, 'live-retry').media.directPath, '/v/new-path');
  assert.equal(calls.includes('send'), false);

  live.markDeletedForEveryone(chat, 'live-ok');
  const gone = await call('whatsapp_action', { action: 'whatsapp_download_media', args: { chat, messageId: 'live-ok' } });
  assert.match(gone.content[0].text, /deleted/);
  console.log('PASS: media keys persist, reads show filename and mimetype, and download stays read-only');
} finally {
  await new Promise((resolve) => server.close(resolve));
  live.close();
  await rm(dir, { recursive: true, force: true });
}
