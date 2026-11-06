import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { isDavidMode, loadDavidConfig } from '../dist/david/config.js';
import { accountJids, addressedToDavid, parseInbound } from '../dist/david/inbound.js';
import { eventHint, isMeetingRequest } from '../dist/david/intent.js';
import { classify } from '../dist/david/intent.js';
import {
  aiTruth,
  claimsNotAiOrIsHuman,
  codeAck,
  codeDenied,
  codeFailed,
  codeFailedNotice,
  codeNeedRepo,
  codeUnavailable,
  decisionReply,
  defaultLanguage,
  fallbackDm,
  genericAssistant,
  ignoredCommand,
  languageSignal,
  meetingAck,
  meetingDeflect,
  noWelcome,
  pullRequestReply,
} from '../dist/david/persona.js';
import { DavidRuntime } from '../dist/david/runtime.js';
import { DavidStore } from '../dist/david/store.js';
import {
  DEFAULT_STYLE_GUIDE,
  readStyle,
  renderCanned,
  stripEnabled,
  stripInvertedPunctuation,
  styleGuideText,
} from '../dist/david/style.js';
import { createMcpServer } from '../dist/mcp-tools.js';
import { MemoryStore } from '../dist/store.js';

const OWNER = '15555550123';
const AIBM = '120363000000000001@g.us';
const STRANGER = '15555550100';
const EXCERPT = 'EXCERPT-TOKEN-XYZ';
const SECRETARY_KEY = 'secretary-key-test';
const SWE_KEY = 'swe-key-test';

function config(overrides = {}) {
  return {
    role: 'david',
    ownerPhone: OWNER,
    aibmGroupJid: AIBM,
    secretaryUrl: 'https://secretary.test/escalations',
    secretaryKey: SECRETARY_KEY,
    sweUrl: 'https://swe.test/code',
    sweKey: SWE_KEY,
    fallbackAfterMinutes: 30,
    callbackPublicBase: 'https://wa-david.example.com',
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

function fakeWa() {
  return {
    getStatus: () => ({ state: 'open' }),
    getSocket: () => null,
    getStore: () => ({ contacts: new Map(), upsertMessage() {} }),
    getAccount: () => ({ id: '5210000000000@s.whatsapp.net' }),
  };
}

function inbound(phone, text, extra = {}) {
  return {
    id: extra.id ?? randomUUID(),
    chatJid: extra.chatJid ?? `${phone}@s.whatsapp.net`,
    senderJid: extra.senderJid ?? `${phone}@s.whatsapp.net`,
    altJid: extra.altJid ?? '',
    fromMe: extra.fromMe ?? false,
    text,
    mentions: extra.mentions ?? [],
    pushName: extra.pushName ?? 'Test',
    stub: extra.stub ?? false,
    replyParticipant: extra.replyParticipant ?? '',
    replyToId: extra.replyToId ?? '',
    quotedText: extra.quotedText ?? '',
    timestampMs: extra.timestampMs ?? 0,
  };
}

async function withDavid(overrides, fn, wa = fakeWa(), extraDeps = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'david-'));
  const sent = [];
  const posts = [];
  const logs = [];
  const delays = [];
  const reads = [];
  const presence = [];
  let nowMs = Date.parse('2026-10-16T18:00:00.000Z');
  let failSecretary = false;
  const runtime = new DavidRuntime(config(overrides), wa, path.join(dir, 'david.sqlite'), {
    now: () => new Date(nowMs),
    log: (line) => logs.push(line),
    fetch: async (url, init) => {
      posts.push({ url: String(url), headers: init.headers, raw: String(init.body), body: JSON.parse(init.body) });
      if (failSecretary && String(url).includes('secretary')) return new Response('no', { status: 500 });
      return new Response('ok', { status: 202 });
    },
    send: async (jid, text, options) => {
      sent.push({ jid, text, replyTo: options?.replyTo ?? null });
      return true;
    },
    delay: async (ms) => { delays.push(ms); },
    random: () => 0,
    markRead: async (jid, id) => { reads.push({ jid, id }); },
    presence: async (jid, state) => { presence.push({ jid, state }); },
    ...extraDeps,
  });
  try {
    await fn({
      runtime,
      sent,
      posts,
      logs,
      delays,
      reads,
      presence,
      dir,
      advance(ms) { nowMs += ms; },
      setFailSecretary(value) { failSecretary = value; },
    });
  } finally {
    await runtime.stop();
    runtime.store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function secretaryPosts(posts) {
  return posts.filter((item) => item.url.startsWith('https://secretary.test/'));
}

function swePosts(posts) {
  return posts.filter((item) => item.url.startsWith('https://swe.test/'));
}

function rpc(body) {
  const json = body.startsWith('event:')
    ? body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6))).find((message) => message && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')))
    : JSON.parse(body);
  if (!json || json.error) throw new Error(json?.error?.message || 'missing MCP result');
  return json.result;
}

const loaded = loadDavidConfig({
  OWNER_PHONE: '',
  FALLBACK_AFTER_MINUTES: 'nope',
  SECRETARY_ESCALATION_WEBHOOK_URL: 'https://user:secret@example.test/hook',
  AIBM_GROUP_JID: 'not-a-group',
});
assert.equal(loaded.ownerPhone, '');
assert.equal(loadDavidConfig({ OWNER_PHONE: 'not-a-phone' }).ownerPhone, '');
assert.equal(loadDavidConfig({ OWNER_PHONE: '+1 555 555 0123' }).ownerPhone, OWNER);
assert.equal(loaded.fallbackAfterMinutes, 30);
assert.equal(loaded.secretaryUrl, '');
assert.equal(loaded.aibmGroupJid, '');
assert.equal(loaded.secretaryUrl.includes('secret'), false);
assert.equal(loaded.escalationBatchMs, 60_000);
assert.equal(loaded.groupAll, false);
assert.equal(loaded.contextMessages, 10);
assert.equal(loaded.typingMinMs, 2000);
assert.equal(loaded.typingMaxMs, 12_000);
assert.equal(loaded.typingMsPerChar, 40);
assert.equal(loaded.chatGapMs, 15_000);
assert.equal(loaded.sendPerMinute, 5);
assert.equal(loaded.sendPerHour, 40);
assert.equal(loaded.sendMaxWaitMs, 60_000);
assert.equal(loadDavidConfig({ SECRETARY_ESCALATION_BATCH_SECONDS: 'nope' }).escalationBatchMs, 60_000);
assert.equal(loadDavidConfig({ DAVID_GROUP_ALL: 'true' }).groupAll, true);
assert.equal(isMeetingRequest('can we meet tomorrow at 4 pm?'), true);
assert.equal(isMeetingRequest('nice to meet you'), false);
assert.equal(isMeetingRequest('me quedo en casa'), false);
assert.equal(eventHint(classify('can we meet tomorrow at 4 pm?', { isOwnerDm: false })), 'meeting');
assert.equal(languageSignal('ok'), null);
assert.equal(defaultLanguage('5215555550100'), 'es');
assert.equal(defaultLanguage(OWNER), 'en');
assert.equal(isDavidMode({ SESSION_ROLE: 'personal' }), false);
assert.equal(isDavidMode({ SESSION_ROLE: 'assistant' }), false);
assert.equal(isDavidMode({ SESSION_ROLE: 'david' }), true);
assert.equal(isDavidMode({ SESSION_ROLE: 'personal', DAVID_MODE: 'true' }), true);
assert.equal(claimsNotAiOrIsHuman("I'm not a bot"), true);
assert.equal(claimsNotAiOrIsHuman("I'm Alex's assistant"), false);

const forbidden = ['CURSOR_API_KEY', 'cursor_api_key'];
for (const file of ['.env.david.example', 'docker-compose.yml', 'DAVID.md', 'README.md', 'src/index.ts', 'src/mcp-tools.ts']) {
  const text = await readFile(file, 'utf8');
  for (const token of forbidden) assert.equal(text.includes(token), false, `${file} contains ${token}`);
}
const davidSources = ['src/account.ts', 'src/david/config.ts', 'src/david/persona.ts', 'src/david/intent.ts', 'src/david/payloads.ts', 'src/david/store.ts', 'src/david/runtime.ts', 'src/david/inbound.ts', 'src/david/pacing.ts'];
for (const file of davidSources) {
  const text = await readFile(file, 'utf8');
  for (const token of forbidden) assert.equal(text.includes(token), false, `${file} contains ${token}`);
}
const compose = await readFile('docker-compose.yml', 'utf8');
assert.match(compose, /SESSION_ROLE: personal/);
assert.match(compose, /127\.0\.0\.1:8787:8787/);
assert.doesNotMatch(compose, /ALLOW_SEND:\s*"true"/);
assert.doesNotMatch(compose, /ALLOW_DELETE:\s*"true"/);
assert.match(compose, /SESSION_ROLE: david/);
assert.match(compose, /DAVID_MODE: "true"/);
assert.match(compose, /david_auth:/);
assert.match(compose, /required: false/);
assert.match(compose, /docker compose build david/);
assert.match(compose, /docker compose down -v/);
const example = await readFile('.env.david.example', 'utf8');
assert.match(example, /^ALLOW_SEND=false$/m);
assert.match(example, /^ALLOW_DELETE=false$/m);
assert.match(example, /^OWNER_PHONE=$/m);
assert.match(example, /SECRETARY_ESCALATION_WEBHOOK_URL=/);
assert.match(example, /SWE_CODE_AGENT_WEBHOOK_URL=/);
assert.match(example, /FALLBACK_AFTER_MINUTES=30/);
assert.match(example, /SECRETARY_ESCALATION_BATCH_SECONDS=60/);
assert.match(example, /DAVID_GROUP_ALL=false/);
assert.match(example, /DAVID_EVENT_CONTEXT_MESSAGES=10/);
assert.match(example, /DAVID_TYPING_MIN_MS=2000/);
assert.match(example, /DAVID_TYPING_MAX_MS=12000/);
assert.match(example, /DAVID_TYPING_MS_PER_CHAR=40/);
assert.match(example, /DAVID_CHAT_GAP_MS=15000/);
assert.match(example, /DAVID_SEND_PER_MINUTE=5/);
assert.match(example, /DAVID_SEND_PER_HOUR=40/);
assert.match(example, /DAVID_SEND_MAX_WAIT_MS=60000/);
assert.equal(example.includes('change-me-to-a-long-random-secret'), true);
for (const file of ['.env.personal.example', '.env.assistant.example', '.env.example']) {
  const text = await readFile(file, 'utf8');
  assert.match(text, /^ALLOW_SEND=false$/m, file);
  assert.match(text, /^ALLOW_DELETE=false$/m, file);
}

for (const lang of ['en', 'es']) {
  const samples = [
    aiTruth(lang),
    genericAssistant(lang),
    noWelcome(lang),
    meetingAck(lang),
    meetingDeflect(lang),
    codeAck(lang, 'acme/widgets'),
    codeNeedRepo(lang),
    codeDenied(lang),
    codeFailed(lang),
    codeUnavailable(lang),
    decisionReply(lang, 'approve', null),
    decisionReply(lang, 'deny', null),
    decisionReply(lang, 'edit', 'move it'),
    fallbackDm('11111111-1111-4111-8111-111111111111', 'summary', lang),
    pullRequestReply('https://github.com/acme/widgets/pull/1', 'fix', lang),
    pullRequestReply('https://github.com/acme/widgets/pull/1', null, lang),
    codeFailedNotice(lang),
    ignoredCommand(lang),
  ];
  for (const sample of samples) {
    assert.equal(sample.includes('¡') || sample.includes('¿'), false, sample);
    assert.equal(aiTruth('en') === aiTruth('es'), false);
  }
  assert.notEqual(genericAssistant('en'), genericAssistant('es'));
  assert.notEqual(fallbackDm('id', 'summary', 'en'), fallbackDm('id', 'summary', 'es'));
  assert.notEqual(pullRequestReply('https://example.com', null, 'en'), pullRequestReply('https://example.com', null, 'es'));
}
assert.equal(genericAssistant('en').includes('I can help'), false);
assert.equal(genericAssistant('es').includes('Puedo ayudar'), false);
assert.equal(genericAssistant('en').includes('Happy to'), false);
assert.equal(stripInvertedPunctuation('¡Hola  ¿qué tal!'), 'Hola qué tal!');
assert.equal(stripInvertedPunctuation('  ¿Hola'), 'Hola');
assert.equal(stripInvertedPunctuation('Hola ¡'), 'Hola');
assert.equal(stripInvertedPunctuation('Hola  there'), 'Hola  there');
assert.equal(stripInvertedPunctuation('Hello'), 'Hello');
assert.equal(stripInvertedPunctuation('¡'), '');

await withDavid({}, async ({ runtime, sent, posts, logs }) => {
  await runtime.handleInbound(inbound(STRANGER, `can we meet tomorrow at 4 pm? ${EXCERPT}`));
  assert.equal(sent.length, 0);
  const posted = secretaryPosts(posts);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].headers.Authorization, `Bearer ${SECRETARY_KEY}`);
  const signature = createHmac('sha256', SECRETARY_KEY).update(posted[0].raw).digest('hex');
  assert.equal(posted[0].headers['X-Webhook-Signature'], `sha256=${signature}`);
  const body = posted[0].body;
  assert.deepEqual(Object.keys(body).sort(), ['account', 'account_jid', 'account_phone', 'events', 'style']);
  assert.equal(body.style, DEFAULT_STYLE_GUIDE);
  assert.equal(body.account, 'david');
  assert.equal(body.account_jid, '5210000000000@s.whatsapp.net');
  assert.equal(body.account_phone, '5210000000000');
  assert.equal(body.events.length, 1);
  const event = body.events[0];
  assert.equal(event.type, 'inbound_message');
  assert.equal(event.hint, 'meeting');
  assert.equal(event.text, `can we meet tomorrow at 4 pm? ${EXCERPT}`);
  assert.equal(event.sender_phone, STRANGER);
  assert.equal(event.language, 'en');
  assert.equal(event.is_group, false);
  assert.equal(event.reply, null);
  assert.deepEqual(event.context, []);
  assert.equal(swePosts(posts).length, 0);
  assert.equal(logs.join('\n').includes(SECRETARY_KEY), false);
  assert.equal(logs.join('\n').includes(EXCERPT), false);
  assert.match(logs.join('\n'), /event=queued hint=meeting/);
  assert.match(logs.join('\n'), /SWE_CODE_AGENT_WEBHOOK_URL is deprecated and ignored/);
});

await withDavid({}, async ({ runtime, sent, posts }) => {
  const lid = '199999999990001@lid';
  await runtime.handleInbound(inbound(STRANGER, 'can we meet tomorrow at 4 pm?', {
    id: 'lid-meet',
    chatJid: lid,
    senderJid: lid,
    altJid: '15555550177@s.whatsapp.net',
  }));
  assert.equal(sent.length, 0);
  const event = secretaryPosts(posts)[0].body.events[0];
  assert.equal(event.hint, 'meeting');
  assert.equal(event.sender_phone, '15555550177');
  assert.equal(event.sender_jid, lid);
  assert.equal(event.text, 'can we meet tomorrow at 4 pm?');
});

{
  const dir = await mkdtemp(path.join(tmpdir(), 'david-lid-'));
  const history = new MemoryStore(path.join(dir, 'history.sqlite'));
  history.linkJids('15555550177@s.whatsapp.net', '199999999990001@lid');
  const wa = {
    getStatus: () => ({ state: 'open' }),
    getSocket: () => null,
    getStore: () => history,
    getAccount: () => ({ id: '5210000000000@s.whatsapp.net' }),
  };
  await withDavid({}, async ({ runtime, sent, posts }) => {
    await runtime.handleInbound(inbound(STRANGER, 'can we meet tomorrow at 4 pm?', {
      chatJid: '199999999990001@lid',
      senderJid: '199999999990001@lid',
    }));
    assert.equal(sent.length, 0);
    assert.equal(secretaryPosts(posts)[0].body.events[0].sender_phone, '15555550177');
    assert.equal(secretaryPosts(posts)[0].body.events[0].hint, 'meeting');
  }, wa);
  history.close();
  await rm(dir, { recursive: true, force: true });
}

await withDavid({}, async ({ runtime, sent, posts }) => {
  await runtime.handleInbound(inbound(STRANGER, 'nice to meet you'));
  assert.equal(sent.length, 0);
  assert.equal(secretaryPosts(posts)[0].body.events[0].hint, null);
  await runtime.handleInbound(inbound(STRANGER, 'want to grab coffee sometime, no rush', { id: 'coffee' }));
  assert.equal(sent.length, 0);
  assert.equal(secretaryPosts(posts)[1].body.events[0].hint, 'meeting_unimportant');
});

await withDavid({ escalationBatchMs: 60_000 }, async ({ runtime, sent, posts, advance }) => {
  await runtime.handleInbound(inbound(STRANGER, 'can we meet tomorrow at 4 pm?', { id: 'm1' }));
  await runtime.handleInbound(inbound(STRANGER, 'hello there', { id: 'm2' }));
  assert.equal(secretaryPosts(posts).length, 0);
  assert.equal(sent.length, 0);
  advance(59_999);
  await runtime.tick();
  assert.equal(secretaryPosts(posts).length, 0);
  advance(1);
  await runtime.tick();
  assert.equal(secretaryPosts(posts).length, 1);
  assert.equal(secretaryPosts(posts)[0].body.events.map((event) => event.message_id).join(','), 'm1,m2');
  await runtime.handleInbound(inbound(STRANGER, 'are you free tomorrow at 5?', { id: 'm3' }));
  advance(59_999);
  await runtime.tick();
  assert.equal(secretaryPosts(posts).length, 1);
  advance(1);
  await runtime.tick();
  assert.equal(secretaryPosts(posts).length, 2);
  assert.deepEqual(secretaryPosts(posts)[1].body.events.map((event) => event.message_id), ['m3']);
  assert.equal(sent.length, 0);
});

await withDavid({}, async ({ runtime, posts, setFailSecretary }) => {
  setFailSecretary(true);
  await runtime.handleInbound(inbound(STRANGER, 'can we meet tomorrow at 4 pm?', { id: 'retry-me' }));
  assert.equal(secretaryPosts(posts).length, 1);
  assert.equal(runtime.store.unsentCount(), 1);
  setFailSecretary(false);
  await runtime.tick();
  assert.equal(secretaryPosts(posts).length, 2);
  assert.equal(runtime.store.unsentCount(), 0);
  assert.equal(secretaryPosts(posts)[1].body.events[0].message_id, 'retry-me');
  await runtime.tick();
  assert.equal(secretaryPosts(posts).length, 2);
});

await withDavid({ escalationBatchMs: 60_000 }, async ({ runtime, posts }) => {
  await runtime.handleInbound(inbound(STRANGER, 'can we meet tomorrow at 4 pm?', { id: 'flush-early' }));
  assert.equal(secretaryPosts(posts).length, 0);
  await runtime.stop();
  assert.equal(secretaryPosts(posts).length, 1);
  assert.equal(secretaryPosts(posts)[0].body.events[0].message_id, 'flush-early');
});

await withDavid({
  typingMinMs: 2000,
  typingMaxMs: 12000,
  typingMsPerChar: 40,
  chatGapMs: 15_000,
  sendPerMinute: 2,
  sendPerHour: 40,
  sendMaxWaitMs: 60_000,
}, async ({ runtime, sent, delays, reads, presence }) => {
  const first = await runtime.sendOutbound({ jid: `${OWNER}@s.whatsapp.net`, text: 'hi', replyTo: 'quoted-id' });
  assert.equal(first.ok, true);
  assert.equal(sent[0].replyTo, 'quoted-id');
  assert.deepEqual(reads, [{ jid: `${OWNER}@s.whatsapp.net`, id: 'quoted-id' }]);
  assert.deepEqual(presence.map((item) => item.state), ['composing', 'paused']);
  assert.ok(delays.some((ms) => ms >= 2000 && ms <= 12_000));
  const second = await runtime.sendOutbound({ jid: `${OWNER}@s.whatsapp.net`, text: 'again' });
  assert.equal(second.ok, true);
  assert.ok(delays.some((ms) => ms >= 15_000));
  assert.equal(sent.length, 2);
});

await withDavid({
  typingMinMs: 0,
  typingMaxMs: 0,
  typingMsPerChar: 0,
  chatGapMs: 0,
  sendPerMinute: 1,
  sendPerHour: 40,
  sendMaxWaitMs: 0,
}, async ({ runtime, sent }) => {
  const first = await runtime.sendOutbound({ jid: `${OWNER}@s.whatsapp.net`, text: 'one' });
  assert.equal(first.ok, true);
  const second = await runtime.sendOutbound({ jid: `${OWNER}@s.whatsapp.net`, text: 'two' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'rate_limited');
  assert.equal(sent.length, 1);
});

await withDavid({}, async ({ runtime, sent, logs }) => {
  const refused = await runtime.sendOutbound({ jid: `${OWNER}@s.whatsapp.net`, text: 'should not leave' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'send_failed');
  assert.equal(sent.length, 0);
  await runtime.handleInbound(inbound(OWNER, '/status', { id: 'owner-status-disabled' }));
  assert.equal(sent.length, 0, 'owner commands do not send while ALLOW_SEND is false');
  assert.match(logs.join('\n'), /ALLOW_SEND=false/);
}, fakeWa(), { allowSend: false });

await withDavid({}, async ({ runtime, sent }) => {
  const cold = await runtime.sendOutbound({ jid: `${STRANGER}@s.whatsapp.net`, text: 'hello' });
  assert.equal(cold.ok, false);
  assert.equal(cold.error, 'cold_contact');
  assert.equal(sent.length, 0);
  const unknownGroup = await runtime.sendOutbound({ jid: '120363000000000099@g.us', text: 'hello' });
  assert.equal(unknownGroup.error, 'cold_contact');
  await runtime.handleInbound(inbound(STRANGER, 'hi there', { id: 'heard' }));
  const warm = await runtime.sendOutbound({ jid: `${STRANGER}@s.whatsapp.net`, text: 'reply', replyTo: 'heard' });
  assert.equal(warm.ok, true);
  assert.equal(sent.at(-1).replyTo, 'heard');
  runtime.store.grant('15555550999', 'acme/widgets');
  const listed = await runtime.sendOutbound({ jid: '15555550999@s.whatsapp.net', text: 'allowed' });
  assert.equal(listed.ok, true);
});

await withDavid({}, async ({ runtime, sent, posts }) => {
  const commandId = 'owner-status';
  await runtime.handleInbound(inbound(OWNER, '/status', { id: commandId }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, `${OWNER}@s.whatsapp.net`);
  assert.equal(sent[0].replyTo, commandId);
  assert.match(sent[0].text, /Open escalations/);
  const event = secretaryPosts(posts)[0].body.events[0];
  assert.equal(event.hint, 'owner_command');
  await runtime.handleInbound(inbound(STRANGER, '/status', { id: 'stranger-status' }));
  assert.equal(sent.length, 1);
  assert.equal(secretaryPosts(posts).at(-1).body.events[0].hint, 'command');
  await runtime.handleInbound(inbound(OWNER, '/approve', { id: 'approve-none' }));
  assert.equal(sent.at(-1).jid, `${OWNER}@s.whatsapp.net`);
  assert.match(sent.at(-1).text, /No open escalation/);
  assert.equal(sent.some((item) => item.jid === `${STRANGER}@s.whatsapp.net`), false);
});

await withDavid({}, async ({ runtime, sent, posts }) => {
  await runtime.handleInbound(inbound('5215555550100', 'ok', { id: 'mx-ok' }));
  assert.equal(secretaryPosts(posts)[0].body.events[0].language, 'es');
  await runtime.handleInbound(inbound(STRANGER, 'hola gracias', { id: 'es-1' }));
  await runtime.handleInbound(inbound(STRANGER, 'ok', { id: 'es-2' }));
  const sticky = secretaryPosts(posts).map((item) => item.body.events[0]);
  assert.equal(sticky.find((event) => event.message_id === 'es-1').language, 'es');
  assert.equal(sticky.find((event) => event.message_id === 'es-2').language, 'es');
  await runtime.handleInbound(inbound(STRANGER, 'hello thanks', { id: 'en-switch' }));
  assert.equal(secretaryPosts(posts).at(-1).body.events[0].language, 'en');
  assert.equal(sent.length, 0);
});

{
  const dir = await mkdtemp(path.join(tmpdir(), 'david-lang-'));
  const history = new MemoryStore(path.join(dir, 'history.sqlite'));
  const group = AIBM;
  history.upsertMessage({
    key: { remoteJid: group, id: 'ben-en', fromMe: false, participant: `${OWNER}@s.whatsapp.net` },
    messageTimestamp: 1_700_000_000,
    message: { conversation: 'hello thanks' },
  });
  const wa = {
    getStatus: () => ({ state: 'open' }),
    getSocket: () => null,
    getStore: () => history,
    getAccount: () => ({ id: '5210000000000@s.whatsapp.net' }),
  };
  await withDavid({}, async ({ runtime, posts }) => {
    await runtime.handleInbound(inbound('5215555550100', 'david ok', {
      id: 'group-ok',
      chatJid: group,
      senderJid: '5215555550100@s.whatsapp.net',
    }));
    assert.equal(secretaryPosts(posts)[0].body.events[0].language, 'es');
    assert.equal(secretaryPosts(posts)[0].body.events[0].context.some((item) => item.message_id === 'ben-en'), true);
  }, wa);
  history.close();
  await rm(dir, { recursive: true, force: true });
}

await withDavid({}, async ({ runtime, posts, sent }) => {
  await runtime.handleInbound(inbound(OWNER, 'please fix the login bug in example-owner/sample-repo', { id: 'code-1' }));
  assert.equal(swePosts(posts).length, 0);
  assert.equal(sent.length, 0);
  const event = secretaryPosts(posts)[0].body.events[0];
  assert.equal(event.hint, 'code');
  assert.equal(event.code.repo, 'example-owner/sample-repo');
  assert.equal(event.code.callback_url, 'https://wa-david.example.com/david/cursor-callback');
  assert.match(event.code.ask, /login bug/);
  const status = await runtime.actions().codeStatus({ request_id: event.code.request_id });
  assert.equal(status.status, 'pending');
  const pr = 'https://github.com/example-owner/sample-repo/pull/7';
  const done = await runtime.handleCallback('Bearer callback-secret-test', {
    request_id: event.code.request_id,
    status: 'done',
    pr_url: pr,
    summary: 'login fix',
  });
  assert.equal(done.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, `${OWNER}@s.whatsapp.net`);
  assert.equal(sent[0].replyTo, 'code-1');
  assert.match(sent[0].text, new RegExp(pr));
  const again = await runtime.handleCallback('Bearer callback-secret-test', {
    request_id: event.code.request_id,
    status: 'done',
    pr_url: pr,
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(sent.filter((item) => item.text.includes(pr)).length, 1);
});

await withDavid({}, async ({ runtime, posts, sent }) => {
  await runtime.handleInbound(inbound(STRANGER, 'please fix the login bug in example-owner/sample-repo'));
  assert.equal(swePosts(posts).length, 0);
  assert.equal(sent.length, 0);
  assert.equal(secretaryPosts(posts)[0].body.events[0].hint, 'code_denied');
  assert.equal(secretaryPosts(posts)[0].body.events[0].code, null);
  await runtime.handleInbound(inbound(OWNER, 'please fix the login bug', { id: 'need-repo' }));
  assert.equal(secretaryPosts(posts).at(-1).body.events[0].hint, 'code');
  assert.equal(secretaryPosts(posts).at(-1).body.events[0].code, null);
  assert.equal(sent.length, 0);
});

await withDavid({}, async ({ runtime, posts, sent }) => {
  await runtime.handleInbound(inbound(STRANGER, '/allowlist grant 15555550999 acme/widgets'));
  assert.equal(sent.length, 0);
  assert.match(runtime.store.listAllowlist().map((entry) => entry.phone).join(','), new RegExp(`^${OWNER}$`));
  await runtime.handleInbound(inbound(OWNER, '/allowlist grant 15555550999 acme/widgets'));
  assert.equal(sent.at(-1).jid, `${OWNER}@s.whatsapp.net`);
  assert.match(sent.at(-1).text, /Granted/);
  assert.equal(runtime.store.canCode('15555550999', 'acme/widgets'), true);
  await runtime.handleInbound(inbound('15555550999', 'please implement the login fix in acme/widgets'));
  assert.equal(secretaryPosts(posts).at(-1).body.events[0].hint, 'code');
  assert.equal(secretaryPosts(posts).at(-1).body.events[0].code.repo, 'acme/widgets');
  assert.equal(swePosts(posts).length, 0);
});

await withDavid({}, async ({ runtime, sent, posts }) => {
  await runtime.handleInbound(inbound(STRANGER, '¿Eres un bot?'));
  await runtime.handleInbound(inbound(STRANGER, 'are you human?', { id: 'human' }));
  await runtime.handleInbound(inbound(STRANGER, 'hello there', { id: 'hello' }));
  assert.equal(sent.length, 0);
  const hints = secretaryPosts(posts).map((item) => item.body.events[0].hint);
  assert.deepEqual(hints, ['ai', 'ai', null]);
  await runtime.handleInbound(inbound(STRANGER, 'david hello', { chatJid: '120363000000000099@g.us', senderJid: `${STRANGER}@s.whatsapp.net`, id: 'other-group' }));
  await runtime.handleInbound(inbound(STRANGER, 'what time is lunch', { chatJid: AIBM, senderJid: `${STRANGER}@s.whatsapp.net`, id: 'unaddressed' }));
  await runtime.handleInbound(inbound(STRANGER, '', { stub: true, chatJid: AIBM }));
  await runtime.handleInbound(inbound(STRANGER, 'hello', { fromMe: true, id: 'mine' }));
  const addressed = secretaryPosts(posts).filter((item) => item.body.events[0].message_id === 'other-group');
  assert.equal(addressed.length, 1);
  assert.equal(secretaryPosts(posts).some((item) => item.body.events[0].message_id === 'unaddressed'), false);
  assert.equal(sent.length, 0);
});


{
  const DAVID_PN = '5210000000000';
  const DAVID_LID = '199999999990004';
  const jids = accountJids({
    id: `${DAVID_PN}:51@s.whatsapp.net`,
    lid: `${DAVID_LID}:51@lid`,
    phoneNumber: `${DAVID_PN}@s.whatsapp.net`,
  });
  assert.equal(jids.includes(`${DAVID_LID}@lid`), true);
  assert.equal(jids.includes(`${DAVID_PN}@s.whatsapp.net`), true);
  assert.equal(jids.some((jid) => jid === `${DAVID_LID}@s.whatsapp.net`), false);
  assert.equal(addressedToDavid(`@${DAVID_LID} create a calendar invite`, [`${DAVID_LID}@lid`], jids, ''), true);
  assert.equal(addressedToDavid('please help', [`${DAVID_PN}@s.whatsapp.net`], jids, ''), true);
  assert.equal(addressedToDavid('following up', [], jids, `${DAVID_LID}@lid`), true);
  assert.equal(addressedToDavid(`@${DAVID_LID} ping`, [], jids, ''), true);
  assert.equal(addressedToDavid('what time is lunch', [], jids, ''), false);
  const parsed = parseInbound({
    key: { remoteJid: AIBM, id: 'parse-lid', fromMe: false, participant: `${OWNER}@s.whatsapp.net` },
    message: {
      extendedTextMessage: {
        text: `@${DAVID_LID} create a calendar invite`,
        contextInfo: { mentionedJid: [`${DAVID_LID}@lid`] },
      },
    },
  });
  assert.equal(parsed?.mentions.includes(`${DAVID_LID}@lid`), true);
}

{
  const DAVID_PN = '5210000000000';
  const DAVID_LID = '199999999990004';
  const wa = {
    getStatus: () => ({ state: 'open', pairedJid: `${DAVID_PN}@s.whatsapp.net`, pairedNumber: DAVID_PN }),
    getSocket: () => null,
    getStore: () => ({ contacts: new Map(), upsertMessage() {}, phoneForJid() { return ''; } }),
    getAccount: () => ({
      id: `${DAVID_PN}:51@s.whatsapp.net`,
      lid: `${DAVID_LID}:51@lid`,
      phoneNumber: `${DAVID_PN}@s.whatsapp.net`,
    }),
  };
  await withDavid({}, async ({ runtime, posts }) => {
    await runtime.handleInbound(inbound(OWNER, `@${DAVID_LID} create a calendar invite`, {
      id: 'ben-lid-mention',
      chatJid: AIBM,
      senderJid: `${OWNER}@s.whatsapp.net`,
      mentions: [`${DAVID_LID}@lid`],
    }));
    await runtime.handleInbound(inbound(OWNER, 'please help with the invite', {
      id: 'ben-phone-mention',
      chatJid: AIBM,
      senderJid: `${OWNER}@s.whatsapp.net`,
      mentions: [`${DAVID_PN}@s.whatsapp.net`],
    }));
    await runtime.handleInbound(inbound(OWNER, 'yes do that', {
      id: 'ben-reply-david',
      chatJid: AIBM,
      senderJid: `${OWNER}@s.whatsapp.net`,
      replyParticipant: `${DAVID_LID}@lid`,
      replyToId: 'david-prior',
    }));
    await runtime.handleInbound(inbound(OWNER, 'what time is lunch', {
      id: 'ben-unrelated',
      chatJid: AIBM,
      senderJid: `${OWNER}@s.whatsapp.net`,
    }));
    await runtime.handleInbound(inbound(STRANGER, 'need a hand here', {
      id: 'third-lid-mention',
      chatJid: AIBM,
      senderJid: `${STRANGER}@s.whatsapp.net`,
      mentions: [`${DAVID_LID}@lid`],
    }));
    const ids = secretaryPosts(posts).map((item) => item.body.events[0].message_id);
    assert.equal(ids.includes('ben-lid-mention'), true, `missing lid mention; got ${ids.join(',')}`);
    assert.equal(ids.includes('ben-phone-mention'), true, `missing phone mention; got ${ids.join(',')}`);
    assert.equal(ids.includes('ben-reply-david'), true, `missing reply; got ${ids.join(',')}`);
    assert.equal(ids.includes('ben-unrelated'), false, `unrelated should not forward; got ${ids.join(',')}`);
    assert.equal(ids.includes('third-lid-mention'), true, `missing third-party; got ${ids.join(',')}`);
  }, wa);
}

await withDavid({ groupAll: true }, async ({ runtime, posts, sent }) => {

  await runtime.handleInbound(inbound(STRANGER, 'what time is lunch', { chatJid: AIBM, senderJid: `${STRANGER}@s.whatsapp.net`, id: 'all-groups' }));
  assert.equal(sent.length, 0);
  assert.equal(secretaryPosts(posts)[0].body.events[0].message_id, 'all-groups');
  assert.equal(secretaryPosts(posts)[0].body.events[0].is_group, true);
});

await withDavid({}, async ({ runtime, sent, posts }) => {
  await runtime.handleInbound(inbound(OWNER, '/quiet 00:00-23:59'));
  const before = sent.length;
  await runtime.handleInbound(inbound(STRANGER, 'hello there', { id: 'during-quiet' }));
  assert.equal(sent.length, before);
  assert.equal(secretaryPosts(posts).some((item) => item.body.events[0].message_id === 'during-quiet'), true);
});

await withDavid({}, async ({ runtime, sent }) => {
  const row = runtime.store.createEscalation({
    type: 'meeting_book',
    summary: 'Meeting request.',
    suggestedAction: 'Approve or decline this booking.',
    chatId: `${STRANGER}@s.whatsapp.net`,
    requesterPhone: STRANGER,
    context: { when: 'tomorrow', who: STRANGER, raw_excerpt: 'tomorrow' },
    fallbackAfterMinutes: 30,
    issuedAt: '2026-10-16T18:00:00.000Z',
    dueAt: '2026-10-16T18:30:00.000Z',
    lang: 'en',
  });
  assert.equal(sent.length, 0);
  const personal = createMcpServer({
    getStatus: () => ({ state: 'disconnected' }),
    getSocket: () => null,
    getStore: () => { throw new Error('personal test must not read the store'); },
    resolveJid: async () => { throw new Error('no'); },
    getAccount: () => ({}),
    getWebhookStatus: () => ({ enabled: false }),
    start: async () => {},
  }, { role: 'personal', allowSend: false, allowDelete: false });
  const davidServer = createMcpServer({
    getStatus: () => ({ state: 'disconnected' }),
    getSocket: () => null,
    getStore: () => { throw new Error('action logging must not fail the call'); },
    resolveJid: async () => { throw new Error('no'); },
    getAccount: () => ({}),
    getWebhookStatus: () => ({ enabled: false }),
    start: async () => {},
  }, { role: 'david', allowSend: true, allowDelete: false, david: runtime.actions() });
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  const personalHandler = toNodeHandler(createMcpHandler(() => personal));
  const davidHandler = toNodeHandler(createMcpHandler(() => davidServer));
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
    const listed = await fetch(`${base}/david`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const tools = rpc(await listed.text()).tools.map((tool) => tool.name);
    assert.equal(tools.length, 26);
    assert.equal(tools.includes('david_resolve_escalation'), false);
    assert.equal(tools.includes('whatsapp_approved_contacts_list'), true);
    assert.equal(tools.includes('whatsapp_approved_contacts_add'), true);
    assert.equal(tools.includes('whatsapp_approved_contacts_remove'), true);
    assert.equal(tools.includes('whatsapp_action'), true);
    const personalCatalog = JSON.parse((await call('/personal', 'whatsapp_action', { action: 'list_actions' })).content[0].text);
    assert.equal(personalCatalog.actions.some((item) => item.action === 'david_resolve_escalation'), false);
    const davidCatalog = JSON.parse((await call('/david', 'whatsapp_action', { action: 'list_actions' })).content[0].text);
    for (const name of ['david_resolve_escalation', 'david_allowlist_list', 'david_allowlist_grant', 'david_allowlist_revoke', 'david_code_status']) {
      assert.equal(davidCatalog.actions.some((item) => item.action === name), true, name);
    }
    const resolved = JSON.parse((await call('/david', 'whatsapp_action', {
      action: 'david_resolve_escalation',
      args: { request_id: row.requestId, decision: 'deny' },
    })).content[0].text);
    assert.equal(resolved.status, 200);
    assert.equal(resolved.decision, 'deny');
    const again = await call('/david', 'whatsapp_action', {
      action: 'david_resolve_escalation',
      args: { request_id: row.requestId, decision: 'approve' },
    });
    assert.notEqual(again.isError, true);
    const againBody = JSON.parse(again.content[0].text);
    assert.equal(againBody.status, 409);
    assert.equal(againBody.error, 'already_resolved');
    assert.equal(againBody.decision, 'deny');
    assert.equal(runtime.store.getEscalation(row.requestId).decision, 'deny');
    assert.equal(sent.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

assert.equal(styleGuideText(null), DEFAULT_STYLE_GUIDE);
assert.equal(styleGuideText('  '), DEFAULT_STYLE_GUIDE);
assert.equal(stripEnabled(null), true);
assert.equal(stripEnabled('off'), false);
assert.equal(stripEnabled('false'), false);
assert.equal(stripEnabled('on'), true);
assert.equal(renderCanned('generic', 'en', null, {}), genericAssistant('en'));
assert.equal(renderCanned('generic', 'en', '   ', {}), genericAssistant('en'));
assert.equal(renderCanned('code_ack', 'es', 'Repo {repo}.', { repo: 'acme/widgets' }), 'Repo acme/widgets.');
const defaults = readStyle(() => null);
assert.equal(defaults.strip, true);
assert.equal(defaults.guide, DEFAULT_STYLE_GUIDE);
assert.equal(defaults.lines.length > 0, true);
for (const line of defaults.lines) {
  assert.equal(line.en.includes('¡') || line.en.includes('¿'), false, line.id);
  assert.equal(line.es.includes('¡') || line.es.includes('¿'), false, line.id);
}

{
  const persistDir = await mkdtemp(path.join(tmpdir(), 'david-style-'));
  const dbPath = path.join(persistDir, 'david.sqlite');
  const first = new DavidStore(dbPath, OWNER);
  assert.equal(first.getSetting('style.guide'), null);
  assert.equal(first.getSetting('style.strip'), null);
  first.setSetting('style.guide', 'Persisted guide.');
  first.setSetting('style.strip', 'off');
  first.setSetting('quiet', '01:00-02:00');
  first.close();
  const second = new DavidStore(dbPath, OWNER);
  assert.equal(second.getSetting('style.guide'), 'Persisted guide.');
  assert.equal(second.getSetting('style.strip'), 'off');
  assert.equal(second.getSetting('quiet'), '01:00-02:00');
  second.saveStyleKeys([{ key: 'style.guide', value: 'Replaced.' }]);
  assert.equal(second.getSetting('style.guide'), 'Replaced.');
  assert.equal(second.getSetting('style.strip'), null);
  assert.equal(second.getSetting('quiet'), '01:00-02:00');
  second.close();
  await rm(persistDir, { recursive: true, force: true });
}

await withDavid({}, async ({ runtime, sent, posts, dir }) => {
  runtime.store.setSetting('style.guide', 'Keep it short.');
  runtime.store.setSetting('quiet', '22:00-08:00');
  await runtime.handleInbound(inbound(STRANGER, 'hello there', { id: 'styled' }));
  assert.equal(secretaryPosts(posts).at(-1).body.style, 'Keep it short.');
  assert.equal(runtime.store.getSetting('quiet'), '22:00-08:00');

  await runtime.handleInbound(inbound(OWNER, 'hola', { id: 'heard-style' }));
  const jid = `${OWNER}@s.whatsapp.net`;
  const marked = '¡Hola  ¿qué tal!';
  await runtime.sendOutbound({ jid, text: marked });
  assert.equal(sent.at(-1).text, 'Hola qué tal!');
  await runtime.sendOutbound({ jid, text: 'Hola  there' });
  assert.equal(sent.at(-1).text, 'Hola  there');
  runtime.store.saveStyleKeys([{ key: 'style.strip', value: 'off' }]);
  await runtime.sendOutbound({ jid, text: marked });
  assert.equal(sent.at(-1).text, marked);

  runtime.store.saveStyleKeys([
    { key: 'style.strip', value: 'on' },
    { key: 'style.line.pull_request_plain.es', value: 'Listo {url}' },
    { key: 'style.line.code_failed_notice.en', value: 'No pull request.' },
  ]);
  assert.equal(runtime.store.getSetting('quiet'), '22:00-08:00');
  await runtime.handleInbound(inbound(OWNER, 'por favor arregla el código en example-owner/sample-repo', { id: 'es-code' }));
  const codeEvent = secretaryPosts(posts).at(-1).body.events[0];
  assert.equal(codeEvent.language, 'es');
  assert.equal(codeEvent.hint, 'code');
  const pr = 'https://github.com/example-owner/sample-repo/pull/9';
  const done = await runtime.handleCallback('Bearer callback-secret-test', {
    request_id: codeEvent.code.request_id,
    status: 'done',
    pr_url: pr,
  });
  assert.equal(done.status, 200);
  assert.equal(sent.at(-1).text, `Listo ${pr}`);
  await runtime.handleInbound(inbound(OWNER, 'please fix the login bug in example-owner/sample-repo', { id: 'en-code' }));
  const enEvent = secretaryPosts(posts).at(-1).body.events[0];
  assert.equal(enEvent.language, 'en');
  const failed = await runtime.handleCallback('Bearer callback-secret-test', {
    request_id: enEvent.code.request_id,
    status: 'failed',
  });
  assert.equal(failed.status, 200);
  assert.equal(sent.at(-1).text, 'No pull request.');

  const drafts = new MemoryStore(path.join(dir, 'drafts.sqlite'));
  const socketCalls = [];
  const mcpWa = {
    getStatus: () => ({ state: 'open' }),
    getSocket: () => ({
      sendMessage: async () => {
        socketCalls.push('send');
        throw new Error('david mcp must use the paced sender');
      },
    }),
    getStore: () => drafts,
    resolveJid: async (to) => (String(to).includes('@') ? String(to) : `${String(to).replace(/\D/g, '')}@s.whatsapp.net`),
    getAccount: () => ({}),
    getWebhookStatus: () => ({ enabled: false }),
    start: async () => {},
  };
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  const handler = toNodeHandler(createMcpHandler(() => createMcpServer(mcpWa, {
    role: 'david',
    allowSend: true,
    allowDelete: false,
    pacedSend: (input) => runtime.sendOutbound(input),
  })));
  app.all('/mcp', (req, res) => { void handler(req, res, req.body); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  async function callTool(name, args) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    assert.equal(response.status, 200);
    return rpc(await response.text());
  }
  try {
    const sentText = await callTool('whatsapp_send_text', { to: jid, text: '¡Listo  ¿ya?' });
    assert.equal(sentText.isError, undefined);
    assert.equal(sent.at(-1).text, 'Listo ya?');
    const draft = drafts.createDraft({ jid, text: '¿Borrador  listo!' });
    const sentDraft = await callTool('whatsapp_send_draft', { id: draft.id });
    assert.equal(sentDraft.isError, undefined);
    assert.equal(sent.at(-1).text, 'Borrador listo!');
    assert.equal(socketCalls.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    drafts.close();
  }
});

{
  const personalDir = await mkdtemp(path.join(tmpdir(), 'personal-style-'));
  const store = new MemoryStore(path.join(personalDir, 'history.sqlite'));
  const sentTexts = [];
  const wa = {
    getStatus: () => ({ state: 'open' }),
    getSocket: () => ({
      sendMessage: async (_jid, content) => {
        sentTexts.push(content.text);
        return { key: { remoteJid: _jid, id: `p${sentTexts.length}`, fromMe: true }, messageTimestamp: 1, message: { conversation: content.text } };
      },
    }),
    getStore: () => store,
    resolveJid: async (to) => (String(to).includes('@') ? String(to) : `${String(to).replace(/\D/g, '')}@s.whatsapp.net`),
    getAccount: () => ({}),
    getWebhookStatus: () => ({ enabled: false }),
    start: async () => {},
  };
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  const handler = toNodeHandler(createMcpHandler(() => createMcpServer(wa, {
    role: 'personal',
    allowSend: true,
    allowDelete: false,
  })));
  app.all('/mcp', (req, res) => { void handler(req, res, req.body); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  async function callTool(name, args) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    assert.equal(response.status, 200);
    return rpc(await response.text());
  }
  try {
    const marked = '¡Hola  ¿qué tal!';
    const sentText = await callTool('whatsapp_send_text', { to: '15555550123', text: marked });
    assert.equal(sentText.isError, undefined);
    assert.equal(sentTexts.at(-1), marked);
    const draft = store.createDraft({ jid: '15555550123@s.whatsapp.net', text: marked });
    const sentDraft = await callTool('whatsapp_send_draft', { id: draft.id });
    assert.equal(sentDraft.isError, undefined);
    assert.equal(sentTexts.at(-1), marked);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(personalDir, { recursive: true, force: true });
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

{
  const dir = await mkdtemp(path.join(tmpdir(), 'david-nophone-'));
  const env = { ...process.env };
  delete env.DOTENV_CONFIG_PATH;
  const child = spawn(process.execPath, ['--import', './scripts/fixtures/mock-whatsapp.mjs', 'dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...env,
      MCP_BEARER_TOKEN: randomBytes(32).toString('hex'),
      PORT: '0',
      HOST: '127.0.0.1',
      AUTH_DIR: dir,
      SESSION_ROLE: 'david',
      DAVID_MODE: 'true',
      OWNER_PHONE: '',
      WEBHOOK_URL: '',
      OAUTH_PUBLIC_URL: '',
      BAILEYS_LOG_LEVEL: 'silent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  await rm(dir, { recursive: true, force: true });
  assert.equal(code, 1);
  assert.match(stderr, /OWNER_PHONE is required/);
}

{
  const dir = await mkdtemp(path.join(tmpdir(), 'david-proc-'));
  const port = await freePort();
  const token = randomBytes(32).toString('hex');
  const env = { ...process.env };
  delete env.DOTENV_CONFIG_PATH;
  const child = spawn(process.execPath, ['--import', './scripts/fixtures/mock-whatsapp.mjs', 'dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...env,
      ADMIN_SECRET: '',
      MCP_BEARER_TOKEN: token,
      PORT: String(port),
      HOST: '127.0.0.1',
      AUTH_DIR: dir,
      SESSION_ROLE: 'david',
      DAVID_MODE: 'true',
      ALLOW_SEND: 'true',
      ALLOW_DELETE: 'false',
      OWNER_PHONE: OWNER,
      AIBM_GROUP_JID: '',
      SECRETARY_ESCALATION_WEBHOOK_URL: '',
      SWE_CODE_AGENT_WEBHOOK_URL: '',
      DAVID_CALLBACK_SECRET: 'callback-secret-value-123',
      WEBHOOK_URL: '',
      OAUTH_PUBLIC_URL: '',
      BAILEYS_LOG_LEVEL: 'silent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    let health;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch {
        // The listener starts after the WhatsApp socket setup begins.
      }
      await delay(250);
    }
    assert.ok(health, 'david process did not become healthy');
    assert.equal(health.session, 'david');
    assert.equal(health.allowSend, true);
    assert.equal(health.allowDelete, false);
    assert.equal(Object.hasOwn(health, 'davidMode'), false);
    const listed = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const names = rpc(await listed.text()).tools.map((tool) => tool.name);
    assert.equal(names.length, 26);
    assert.equal(names.includes('david_resolve_escalation'), false);
    assert.equal(names.includes('whatsapp_approved_contacts_list'), true);
    assert.equal(names.includes('whatsapp_approved_contacts_add'), true);
    assert.equal(names.includes('whatsapp_approved_contacts_remove'), true);
    const actions = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'whatsapp_action', arguments: { action: 'list_actions' } },
      }),
    });
    const catalog = JSON.parse(rpc(await actions.text()).content[0].text);
    assert.equal(catalog.actions.some((item) => item.action === 'david_resolve_escalation'), true);
    const unauth = await fetch(`http://127.0.0.1:${port}/david/cursor-callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(unauth.status, 401);
    const unknown = await fetch(`http://127.0.0.1:${port}/david/cursor-callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer callback-secret-value-123' },
      body: JSON.stringify({ request_id: '00000000-0000-4000-8000-000000000001', status: 'ack' }),
    });
    assert.equal(unknown.status, 404);
    const internal = await fetch(`http://127.0.0.1:${port}/internal/admin/overview`);
    assert.equal(internal.status, 404);
    assert.equal((await internal.text()).includes(OWNER), false);
  } catch (error) {
    const safe = output.split('\n').filter((line) => !line.includes('█')).slice(-15).join('\n');
    throw new Error(`${error instanceof Error ? error.message : error}\n${safe}`);
  } finally {
    child.kill('SIGTERM');
    await delay(200);
    await rm(dir, { recursive: true, force: true });
  }
}

console.log('PASS: david allowlist, escalation resolve, webhook payloads, persona, and community rules');
