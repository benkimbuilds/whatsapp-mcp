import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryStore } from '../dist/store.js';

const root = await mkdtemp(path.join(tmpdir(), 'whatsapp-bridge-smoke-'));
const children = [];

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function health(port) {
  const url = `http://127.0.0.1:${port}/healthz`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // The HTTP listener may still be starting.
    }
    await delay(250);
  }
  throw new Error(`No health response on port ${port}`);
}

async function mcp(port, token, method, params) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.text();
  if (response.status === 401) return { status: 401 };
  assert.equal(response.status, 200, body);
  const json = rpcResponse(body);
  return { status: response.status, json };
}

function rpcResponse(body) {
  if (!body.startsWith('event:')) return JSON.parse(body);
  const messages = body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  const response = messages.find((message) => message && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')));
  assert.ok(response, body);
  return response;
}

try {
  const personal = { role: 'personal', port: await freePort(), token: randomBytes(32).toString('hex') };
  const assistant = { role: 'assistant', port: await freePort(), token: randomBytes(32).toString('hex') };
  const oauthSalt = randomBytes(16);
  const oauthPasswordHash = `scrypt:${oauthSalt.toString('hex')}:${scryptSync('test-only long password', oauthSalt, 32).toString('hex')}`;
  for (const session of [personal, assistant]) {
    const authDir = path.join(root, session.role);
    const history = new MemoryStore(path.join(authDir, 'history.sqlite'));
    history.upsertMessage({
      key: { remoteJid: '15555550100@s.whatsapp.net', id: `${session.role}-saved`, fromMe: false },
      messageTimestamp: 1,
      message: { conversation: `${session.role} saved history` },
    });
    history.close();
    children.push(spawn(process.execPath, ['--import', './scripts/fixtures/mock-whatsapp.mjs', 'dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ADMIN_SECRET: '',
        MCP_BEARER_TOKEN: session.token,
        PORT: String(session.port),
        HOST: '127.0.0.1',
        AUTH_DIR: authDir,
        SESSION_ROLE: session.role,
        DAVID_MODE: '',
        ALLOW_SEND: 'true',
        ALLOW_DELETE: session.role === 'personal' ? 'true' : 'false',
        BAILEYS_LOG_LEVEL: 'silent',
        ...(session.role === 'personal' ? {
          OAUTH_PUBLIC_URL: 'https://wa-personal.example.com/mcp',
          OAUTH_EMAIL: 'owner@example.com',
          OAUTH_PASSWORD_HASH: oauthPasswordHash,
        } : {}),
      },
      stdio: 'ignore', // QR material must not enter test logs.
    }));
  }

  const [personalHealth, assistantHealth] = await Promise.all([health(personal.port), health(assistant.port)]);
  assert.equal(personalHealth.session, 'personal');
  assert.equal(personalHealth.allowSend, true);
  assert.equal(personalHealth.allowDelete, true);
  assert.equal(assistantHealth.session, 'assistant');
  assert.equal(assistantHealth.allowSend, true);
  assert.equal(assistantHealth.allowDelete, false);
  assert.equal(personalHealth.whatsappConnected, false);
  assert.equal(assistantHealth.whatsappConnected, false);
  const personalMetadata = await fetch(`http://127.0.0.1:${personal.port}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(personalMetadata.status, 200);
  assert.equal((await personalMetadata.json()).resource, 'https://wa-personal.example.com/mcp');
  const assistantMetadata = await fetch(`http://127.0.0.1:${assistant.port}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(assistantMetadata.status, 404);
  const admin = await fetch(`http://127.0.0.1:${personal.port}/admin`);
  assert.equal(admin.status, 404);
  assert.equal((await admin.text()).includes('saved history'), false);

  const expectedTools = ['whatsapp_webhook_blocklist_list', 'whatsapp_webhook_blocklist_add', 'whatsapp_webhook_blocklist_remove', 'whatsapp_action', 'whatsapp_status', 'whatsapp_resolve_recipient', 'whatsapp_send_text', 'whatsapp_delete_for_everyone', 'whatsapp_list_chats', 'whatsapp_read_messages', 'whatsapp_find_contact', 'whatsapp_search_messages', 'whatsapp_group_activity', 'whatsapp_mentions', 'whatsapp_group_info', 'whatsapp_create_draft', 'whatsapp_list_drafts', 'whatsapp_cancel_draft', 'whatsapp_send_draft', 'whatsapp_send_media', 'whatsapp_download_media', 'whatsapp_react', 'whatsapp_delete_message'];
  for (const session of [personal, assistant]) {
    const listed = await mcp(session.port, session.token, 'tools/list', {});
    assert.deepEqual(listed.json.result.tools.map((tool) => tool.name).sort(), expectedTools.slice().sort());
    assert.equal((await mcp(session.port, session === personal ? assistant.token : personal.token, 'tools/list', {})).status, 401);
  }

  for (const session of [personal, assistant]) {
    const unpaired = await mcp(session.port, session.token, 'tools/call', {
      name: 'whatsapp_send_text', arguments: { to: '15555550100', text: 'smoke test' },
    });
    assert.equal(unpaired.json.result.isError, true);
    for (const [name, args] of [
      ['whatsapp_send_media', { to: '15555550100', base64: 'iVBORw0KGgo=' }],
      ['whatsapp_react', { chat: '15555550100', messageId: 'x', emoji: '👍' }],
    ]) {
      const refused = await mcp(session.port, session.token, 'tools/call', { name, arguments: args });
      assert.equal(refused.json.result.isError, true, name);
    }
    assert.match(unpaired.json.result.content[0].text, /not connected/);
    const actions = await mcp(session.port, session.token, 'tools/call', {
      name: 'whatsapp_action', arguments: { action: 'list_actions' },
    });
    assert.equal(actions.json.result.isError, undefined);
    const catalog = JSON.parse(actions.json.result.content[0].text).actions;
    assert.equal(catalog.some((item) => item.action === 'list_actions' && item.inputSchema?.type === 'object'), true);
    assert.equal(catalog.some((item) => item.action === 'whatsapp_read_messages'), true);
    const viaAction = await mcp(session.port, session.token, 'tools/call', {
      name: 'whatsapp_action',
      arguments: { action: 'whatsapp_read_messages', args: { chat: '15555550100' } },
    });
    assert.equal(viaAction.json.result.isError, undefined);
    assert.deepEqual(JSON.parse(viaAction.json.result.content[0].text).messages.map((m) => m.text), [
      `${session.role} saved history`,
    ]);
    const unknownAction = await mcp(session.port, session.token, 'tools/call', {
      name: 'whatsapp_action', arguments: { action: 'not_an_action' },
    });
    assert.equal(unknownAction.json.result.isError, true);
    const unknownText = JSON.parse(unknownAction.json.result.content[0].text).error;
    assert.match(unknownText, /Unknown action "not_an_action"/);
    assert.match(unknownText, /list_actions/);
    const contacts = await mcp(session.port, session.token, 'tools/call', {
      name: 'whatsapp_find_contact', arguments: { query: 'nobody-saved' },
    });
    assert.equal(contacts.json.result.isError, undefined);
    assert.deepEqual(JSON.parse(contacts.json.result.content[0].text).contacts, []);
    assert.doesNotMatch(contacts.json.result.content[0].text, /ALLOW_SEND|ALLOW_DELETE/);
    const history = await mcp(session.port, session.token, 'tools/call', {
      name: 'whatsapp_read_messages', arguments: { chat: '15555550100' },
    });
    assert.equal(history.json.result.isError, undefined);
    assert.deepEqual(JSON.parse(history.json.result.content[0].text).messages.map((m) => m.text), [
      `${session.role} saved history`,
    ]);
    const deletion = await mcp(session.port, session.token, 'tools/call', {
      name: 'whatsapp_delete_for_everyone', arguments: { chat: '15555550100', messageId: `${session.role}-saved` },
    });
    assert.equal(deletion.json.result.isError, true);
    assert.match(deletion.json.result.content[0].text, session.role === 'assistant' ? /disabled/ : /not connected/);
    const found = await mcp(session.port, session.token, 'tools/call', {
      name: 'whatsapp_search_messages', arguments: { query: 'saved', chat: '15555550100' },
    });
    assert.equal(found.json.result.isError, undefined);
    assert.deepEqual(JSON.parse(found.json.result.content[0].text).messages.map((message) => message.id), [`${session.role}-saved`]);
    const activity = await mcp(session.port, session.token, 'tools/call', {
      name: 'whatsapp_group_activity', arguments: { since: 1, until: 2 },
    });
    assert.equal(activity.json.result.isError, undefined);
    assert.deepEqual(JSON.parse(activity.json.result.content[0].text).groups, []);
    const mentions = await mcp(session.port, session.token, 'tools/call', {
      name: 'whatsapp_mentions', arguments: { since: 1 },
    });
    assert.equal(mentions.json.result.isError, true);
    assert.match(mentions.json.result.content[0].text, /not known/);
    const groups = await mcp(session.port, session.token, 'tools/call', {
      name: 'whatsapp_group_info', arguments: { name: 'builders' },
    });
    assert.equal(groups.json.result.isError, true);
    assert.match(groups.json.result.content[0].text, /not connected/);
    assert.doesNotMatch(groups.json.result.content[0].text, /disabled|ALLOW_SEND|ALLOW_DELETE/);
    const drafted = await mcp(session.port, session.token, 'tools/call', {
      name: 'whatsapp_create_draft',
      arguments: { chat: '120363500000000001@g.us', text: 'draft-token', sendAt: 1_600_000_000 },
    });
    assert.equal(drafted.json.result.isError, undefined);
    const draft = JSON.parse(drafted.json.result.content[0].text);
    assert.equal(draft.jid, '120363500000000001@g.us');
    assert.equal(draft.sendAt, 1_600_000_000);
    assert.match(draft.id, /^[a-f0-9]{32}$/);
    const listedDrafts = await mcp(session.port, session.token, 'tools/call', {
      name: 'whatsapp_list_drafts', arguments: {},
    });
    assert.equal(listedDrafts.json.result.isError, undefined);
    assert.equal(JSON.parse(listedDrafts.json.result.content[0].text).drafts.some((item) => item.id === draft.id), true);
    const refusedDraft = await mcp(session.port, session.token, 'tools/call', {
      name: 'whatsapp_send_draft', arguments: { id: draft.id },
    });
    assert.equal(refusedDraft.json.result.isError, true);
    assert.match(refusedDraft.json.result.content[0].text, /not connected/);
    const kept = await mcp(session.port, session.token, 'tools/call', {
      name: 'whatsapp_list_drafts', arguments: {},
    });
    assert.equal(JSON.parse(kept.json.result.content[0].text).drafts.some((item) => item.id === draft.id), true);
    const cancelled = await mcp(session.port, session.token, 'tools/call', {
      name: 'whatsapp_cancel_draft', arguments: { id: draft.id },
    });
    assert.equal(cancelled.json.result.isError, undefined);
    const gone = await mcp(session.port, session.token, 'tools/call', {
      name: 'whatsapp_list_drafts', arguments: {},
    });
    assert.equal(JSON.parse(gone.json.result.content[0].text).drafts.some((item) => item.id === draft.id), false);
  }
  console.log('PASS: dual health, twenty-three tools, cross-token rejection, unpaired send/delete refusal, offline history reads, disconnected group counts, draft stays unsent');
  console.log('Live pairing and message delivery require the two WhatsApp phones.');
} finally {
  for (const child of children) child.kill('SIGTERM');
  await delay(500);
  await rm(root, { recursive: true, force: true });
}
