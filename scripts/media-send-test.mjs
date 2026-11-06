import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Small cap so the size checks run fast. Read when media.js is imported.
process.env.MEDIA_MAX_BYTES = '64K';
const { createMcpExpressApp } = await import('@modelcontextprotocol/express');
const { toNodeHandler } = await import('@modelcontextprotocol/node');
const { createMcpHandler } = await import('@modelcontextprotocol/server');
const { createMcpServer } = await import('../dist/mcp-tools.js');
const { MemoryStore } = await import('../dist/store.js');
const { DavidRuntime } = await import('../dist/david/runtime.js');
const { MEDIA_MAX_BYTES, mediaMaxBytesFrom } = await import('../dist/media.js');
const { isPrivateAddress, loadOutboundMedia, detectMime, chooseKind, safeFilename } = await import('../dist/media-send.js');

assert.equal(MEDIA_MAX_BYTES, 64 * 1024);
assert.equal(mediaMaxBytesFrom(undefined), 16 * 1024 * 1024);
assert.equal(mediaMaxBytesFrom('32M'), 32 * 1024 * 1024);
assert.equal(mediaMaxBytesFrom('999M'), 100 * 1024 * 1024);
assert.equal(mediaMaxBytesFrom('nonsense'), 16 * 1024 * 1024);

const dir = await mkdtemp(path.join(tmpdir(), 'whatsapp-media-send-'));
const sendDir = path.join(dir, 'outbox');
await mkdir(sendDir);
const store = new MemoryStore(path.join(dir, 'history.sqlite'));
const group = '120000000000000002@g.us';
const other = '15555550111@s.whatsapp.net';
const dm = '15555550112@s.whatsapp.net';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 3)]);
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 4)]);
const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 5)]);
const unknown = Buffer.from('just some bytes that are not a known format');
await writeFile(path.join(sendDir, 'clip.mp4'), mp4);
await writeFile(path.join(dir, 'secret.txt'), 'outside');
await symlink(path.join(dir, 'secret.txt'), path.join(sendDir, 'escape.txt'));

store.upsertMessage({ key: { remoteJid: group, id: 'question', fromMe: false, participant: other }, messageTimestamp: 10, message: { conversation: 'send the deck' } });

const mediaKey = Buffer.alloc(32, 9);
const calls = [];
let counter = 0;
const socket = {
  user: { id: '15555550100@s.whatsapp.net' },
  sendMessage: async (jid, content, options) => {
    calls.push({ jid, content, options });
    counter += 1;
    const field = content.image ? 'imageMessage' : content.video ? 'videoMessage' : content.audio ? 'audioMessage' : 'documentMessage';
    const bytes = content.image ?? content.video ?? content.audio ?? content.document;
    return {
      key: { remoteJid: jid, id: `media-${counter}`, fromMe: true },
      messageTimestamp: 100 + counter,
      message: { [field]: { mimetype: content.mimetype, caption: content.caption, fileName: content.fileName, fileLength: bytes.length, mediaKey, directPath: `/v/${counter}` } },
    };
  },
};
const fetched = new Map();
const wa = {
  getStatus: () => ({ state: 'open', hasCreds: true }),
  getSocket: () => socket,
  getStore: () => store,
  resolveJid: async (chat) => (chat.includes('@') ? chat : `${chat.replace(/\D/g, '')}@s.whatsapp.net`),
  getAccount: () => ({}),
  fetchMedia: async (message) => fetched.get(message.key.id),
};

const paced = [];
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
      assert.equal(response.status, 200);
      const body = await response.text();
      const result = (body.startsWith('event:') ? JSON.parse(body.split('\n').find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body)).result;
      return { ...result, json: JSON.parse(result.content[0].text) };
    },
  };
}

const personal = await serve({ role: 'personal', allowSend: true, allowDelete: false, mediaSendDir: sendDir });
const noDir = await serve({ role: 'personal', allowSend: true, allowDelete: false });
const readOnly = await serve({ role: 'readonly', allowSend: false, allowDelete: false, mediaSendDir: sendDir });
let davidRefuse = false;
const david = await serve({
  role: 'david', allowSend: true, allowDelete: false,
  pacedSend: async (input) => {
    paced.push(input);
    return davidRefuse ? { ok: false, error: 'cold_contact' } : { ok: true, messageId: 'paced-media' };
  },
});

try {
  // Image with caption and a quoted reply in a group.
  let result = await personal.call('whatsapp_send_media', { to: group, base64: png.toString('base64'), caption: 'here', replyTo: 'question' });
  assert.equal(result.isError, undefined, JSON.stringify(result.json));
  assert.equal(result.json.kind, 'image');
  assert.equal(result.json.mimetype, 'image/png');
  assert.equal(result.json.quoted, true);
  let sent = calls.at(-1);
  assert.ok(Buffer.from(sent.content.image).equals(png));
  assert.equal(sent.content.caption, 'here');
  assert.equal(sent.options.quoted.key.participant, other);

  // Data URI document keeps a filename; the sniffed type wins over a wrong declared one.
  result = await personal.call('whatsapp_send_media', { to: dm, base64: `data:image/png;base64,${pdf.toString('base64')}`, filename: '../../Deck Q3' });
  assert.equal(result.json.kind, 'document');
  assert.equal(result.json.mimetype, 'application/pdf');
  assert.equal(calls.at(-1).content.fileName, 'Deck Q3.pdf');
  assert.equal(calls.at(-1).options, undefined);

  // Video from MEDIA_SEND_DIR, then download it back.
  result = await personal.call('whatsapp_send_media', { to: dm, path: 'clip.mp4', caption: 'clip' });
  assert.equal(result.json.kind, 'video');
  assert.equal(result.json.filename, 'clip.mp4');
  const videoId = result.json.messageId;
  fetched.set(videoId, mp4);
  const read = await personal.call('whatsapp_read_messages', { chat: dm, limit: 10 });
  const savedVideo = read.json.messages.find((m) => m.id === videoId);
  assert.equal(savedVideo.hasMedia, true);
  assert.equal(savedVideo.mimetype, 'video/mp4');
  const download = await personal.call('whatsapp_download_media', { chat: dm, messageId: videoId });
  assert.equal(download.isError, undefined, JSON.stringify(download.json));
  assert.equal(download.json.kind, 'video');
  assert.ok(Buffer.from(download.json.base64, 'base64').equals(mp4));

  // A received image in a group downloads too.
  store.upsertMessage({ key: { remoteJid: group, id: 'their-photo', fromMe: false, participant: other }, messageTimestamp: 50, message: { imageMessage: { mimetype: 'image/jpeg', fileLength: jpeg.length, mediaKey, directPath: '/v/photo' } } });
  fetched.set('their-photo', jpeg);
  const photo = await personal.call('whatsapp_download_media', { chat: group, messageId: 'their-photo' });
  assert.equal(photo.json.kind, 'image');
  assert.ok(Buffer.from(photo.json.base64, 'base64').equals(jpeg));

  // Audio goes as audio; a caption on audio is refused.
  result = await personal.call('whatsapp_send_media', { to: dm, base64: ogg.toString('base64') });
  assert.equal(result.json.kind, 'audio');
  const count = calls.length;
  assert.match((await personal.call('whatsapp_send_media', { to: dm, base64: ogg.toString('base64'), caption: 'no' })).json.error, /caption/);
  // Unknown bytes go as a document; forcing them to an image is refused.
  assert.equal(detectMime(unknown, undefined, 'notes'), 'application/octet-stream');
  assert.equal(chooseKind('application/octet-stream'), 'document');
  assert.match((await personal.call('whatsapp_send_media', { to: dm, base64: unknown.toString('base64'), kind: 'image' })).json.error, /cannot be sent as image/);
  // Size cap, source rules, path containment, URL rules, and gates. None of these send.
  assert.match((await personal.call('whatsapp_send_media', { to: dm, base64: Buffer.alloc(70 * 1024, 1).toString('base64') })).json.error, /MEDIA_MAX_BYTES/);
  assert.match((await personal.call('whatsapp_send_media', { to: dm })).json.error, /exactly one/);
  assert.match((await personal.call('whatsapp_send_media', { to: dm, base64: png.toString('base64'), path: 'clip.mp4' })).json.error, /exactly one/);
  assert.match((await noDir.call('whatsapp_send_media', { to: dm, path: 'clip.mp4' })).json.error, /MEDIA_SEND_DIR/);
  assert.match((await personal.call('whatsapp_send_media', { to: dm, path: '../secret.txt' })).json.error, /MEDIA_SEND_DIR/);
  assert.match((await personal.call('whatsapp_send_media', { to: dm, path: 'escape.txt' })).json.error, /inside MEDIA_SEND_DIR/);
  assert.match((await personal.call('whatsapp_send_media', { to: dm, path: path.join(dir, 'secret.txt') })).json.error, /inside MEDIA_SEND_DIR/);
  assert.match((await personal.call('whatsapp_send_media', { to: dm, url: 'http://example.com/a.png' })).json.error, /https/);
  assert.match((await personal.call('whatsapp_send_media', { to: dm, url: 'https://127.0.0.1/a.png' })).json.error, /private/);
  assert.match((await personal.call('whatsapp_send_media', { to: dm, url: 'https://[::1]/a.png' })).json.error, /private/);
  assert.match((await personal.call('whatsapp_send_media', { to: dm, url: 'https://localhost/a.png' })).json.error, /private|Could not download/);
  assert.match((await readOnly.call('whatsapp_send_media', { to: dm, base64: png.toString('base64') })).json.error, /ALLOW_SEND=false/);
  assert.equal(calls.length, count);
  for (const address of ['10.0.0.1', '172.20.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('2606:4700::1111'), false);
  // URL loading with an injected fetcher: filename from the URL, type from the bytes.
  const fromUrl = await loadOutboundMedia({ url: 'https://files.example.com/report%20final.pdf' }, { maxBytes: 1024, fetchUrl: async () => ({ buffer: pdf, mimetype: 'application/octet-stream' }) });
  assert.equal(fromUrl.filename, 'report final.pdf');
  assert.equal(fromUrl.mimetype, 'application/pdf');
  assert.equal(safeFilename('a\u0000b<c>', 'image/png'), 'abc.png');

  // David: the file goes through the paced queue with its quote; a refusal is reported.
  result = await david.call('whatsapp_send_media', { to: group, base64: jpeg.toString('base64'), caption: 'deck', replyTo: 'question' });
  assert.equal(result.json.messageId, 'paced-media');
  assert.equal(paced.at(-1).media.kind, 'image');
  assert.equal(paced.at(-1).text, 'deck');
  assert.equal(paced.at(-1).replyTo, 'question');
  davidRefuse = true;
  result = await david.call('whatsapp_send_media', { to: dm, base64: jpeg.toString('base64') });
  assert.equal(result.isError, true);
  assert.match(result.json.error, /has not written/);
  assert.equal(calls.length, count);

  // David runtime with a real socket path: the caption is styled, the file and the quote reach Baileys.
  const davidDir = path.join(dir, 'david');
  await mkdir(davidDir);
  const davidCalls = [];
  const davidWa = {
    getStatus: () => ({ state: 'open' }),
    getSocket: () => ({
      sendMessage: async (jid, content, options) => {
        davidCalls.push({ jid, content, options });
        return { key: { remoteJid: jid, id: `david-${davidCalls.length}`, fromMe: true }, message: { imageMessage: { mimetype: content.mimetype, mediaKey, directPath: '/v/d' } } };
      },
    }),
    getStore: () => store,
    getAccount: () => ({ id: '15555550100@s.whatsapp.net' }),
  };
  const runtime = new DavidRuntime({
    role: 'david', ownerPhone: '15555550123', aibmGroupJid: group,
    secretaryUrl: 'https://secretary.test/e', secretaryKey: 'k', sweUrl: 'https://swe.test/c', sweKey: 'k',
    fallbackAfterMinutes: 30, callbackPublicBase: 'https://david.example.com', callbackSecret: 'callback-secret-test',
    timezone: 'UTC', escalationBatchMs: 0, groupAll: false, contextMessages: 10,
    typingMinMs: 0, typingMaxMs: 0, typingMsPerChar: 0, chatGapMs: 0, sendPerMinute: 100, sendPerHour: 1000, sendMaxWaitMs: 0,
  }, davidWa, path.join(davidDir, 'david.sqlite'), {
    delay: async () => {}, random: () => 0, markRead: async () => {}, presence: async () => {}, log: () => {},
  });
  const { loadOutboundMedia: load } = await import('../dist/media-send.js');
  const image = await load({ base64: jpeg.toString('base64') }, { maxBytes: 1024 });
  const outcome = await runtime.sendOutbound({ jid: '15555550123@s.whatsapp.net', text: '¿Listo? aquí está', replyTo: null, media: image });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.ok(Buffer.from(davidCalls.at(-1).content.image).equals(jpeg));
  assert.equal(davidCalls.at(-1).content.caption.includes('¿'), false);
  const quotedOutcome = await runtime.sendOutbound({ jid: group, text: 'see above', replyTo: 'question' });
  assert.equal(quotedOutcome.ok, true, JSON.stringify(quotedOutcome));
  assert.equal(davidCalls.at(-1).options.quoted.key.participant, other);
  assert.equal(davidCalls.at(-1).options.quoted.message.conversation, 'send the deck');
  const unquoted = await runtime.sendOutbound({ jid: group, text: 'no quote', replyTo: 'missing-id' });
  assert.equal(unquoted.ok, true);
  assert.equal(davidCalls.at(-1).options, undefined);
  runtime.store?.close?.();

  console.log('PASS: send_media sends images, video, audio, and documents from base64, MEDIA_SEND_DIR, or https with quotes; enforces the size cap, path and URL rules, and gates; David uses the paced queue; sent and received media download back');
} finally {
  for (const item of [personal, noDir, readOnly, david]) await new Promise((resolve) => item.server.close(resolve));
  store.close();
  await rm(dir, { recursive: true, force: true });
}
