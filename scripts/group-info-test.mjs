import assert from 'node:assert/strict';
import { Boom } from '@hapi/boom';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from '../dist/mcp-tools.js';
import {
  GroupQueryGuard,
  GroupRateLimitError,
  linkAndFilter,
  projectGroup,
  projectGroups,
  publicGroupError,
} from '../dist/group-info.js';

const PHONE = '5215550100001';
const OTHER = '5215550199888';
const OTHER_ADMIN_PHONE = '5215550177777';
const ME_LID = '111111111111111';
const OTHER_LID = '222222222222222';
const community = '120363000000000001@g.us';
const announce = '120363000000000002@g.us';
const events = '120363000000000003@g.us';
const family = '120363000000000004@g.us';
const fresh = '120363000000000009@g.us';
const secrets = [PHONE, OTHER, OTHER_ADMIN_PHONE, ME_LID, OTHER_LID, '@lid', '@s.whatsapp.net', 'phoneNumber', 'inviteCode'];

const directory = {
  [community]: {
    id: community,
    subject: 'AI Builders México',
    isCommunity: true,
    desc: `secret note ${OTHER}`,
    owner: `${OTHER}@s.whatsapp.net`,
    inviteCode: 'secret-invite',
    participants: [
      { id: `${ME_LID}@lid`, phoneNumber: `${PHONE}@s.whatsapp.net`, admin: 'superadmin' },
      { id: `${OTHER_LID}@lid`, phoneNumber: `${OTHER_ADMIN_PHONE}@s.whatsapp.net`, admin: 'admin' },
      { id: `${OTHER}@s.whatsapp.net`, admin: null },
    ],
  },
  [announce]: {
    id: announce,
    subject: 'AI Builders México Announcements',
    isCommunityAnnounce: true,
    linkedParent: community,
    size: 100,
    participants: [{ id: `${ME_LID}@lid`, admin: 'admin' }],
  },
  [events]: {
    id: events,
    subject: 'AI Builders Events',
    linkedParent: community,
    participants: [
      { id: `${OTHER_LID}@lid`, phoneNumber: `${PHONE}@s.whatsapp.net`, admin: 'admin' },
      { id: `${OTHER}@s.whatsapp.net`, admin: null },
    ],
  },
  [family]: {
    id: family,
    subject: 'Family chat',
    linkedParent: `${OTHER}@s.whatsapp.net`,
    size: 1,
    participants: [
      { id: `${PHONE}@s.whatsapp.net`, admin: null },
      { id: `${OTHER}@s.whatsapp.net`, admin: 'admin' },
    ],
  },
};

function assertNoSecrets(text) {
  for (const secret of secrets) assert.equal(text.includes(secret), false, secret);
}

function participatingSocket(load, metadata) {
  const calls = { all: 0, one: 0 };
  const socket = {
    user: { id: `${PHONE}:14@s.whatsapp.net`, lid: `${ME_LID}@lid`, phoneNumber: `${PHONE}@s.whatsapp.net` },
    groupFetchAllParticipating: async () => {
      calls.all += 1;
      return await load();
    },
    groupMetadata: async (jid) => {
      calls.one += 1;
      return await metadata(jid);
    },
  };
  return {
    calls,
    socket: new Proxy(socket, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, receiver);
        return () => { throw new Error(`unexpected socket.${String(prop)}`); };
      },
    }),
  };
}

function session(socket, state = 'open') {
  return {
    getStatus: () => ({ state, hasCreds: true, pairedJid: `${PHONE}@s.whatsapp.net`, pairedNumber: PHONE }),
    getSocket: () => socket,
    getStore: () => { throw new Error('group info must not read history'); },
    resolveJid: async () => { throw new Error('group info must not resolve phone numbers'); },
    start: async () => {},
  };
}

async function start(wa) {
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  const handler = toNodeHandler(createMcpHandler(() => createMcpServer(wa, {
    role: 'personal', allowSend: false, allowDelete: false,
  })));
  app.all('/mcp', (req, res) => { void handler(req, res, req.body); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function mcp(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.text();
  const json = body.startsWith('event:')
    ? JSON.parse(body.split('\n').find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(body);
  return json.result;
}

function textOf(result) {
  const text = result.content[0].text;
  let body = text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && parsed.account === 'personal') {
      assert.equal(parsed.accountPhone, PHONE);
      assert.equal(parsed.accountJid, `${PHONE}@s.whatsapp.net`);
      const rest = { ...parsed };
      delete rest.account;
      delete rest.accountJid;
      delete rest.accountPhone;
      body = JSON.stringify(rest);
    }
  } catch {
    body = text;
  }
  assertNoSecrets(body);
  return text;
}

const servers = [];

try {
  const projected = projectGroups(directory, {
    id: `${PHONE}:14@s.whatsapp.net`,
    lid: `${ME_LID}@lid`,
    phoneNumber: `${PHONE}@c.us`,
  });
  assertNoSecrets(JSON.stringify(projected));
  assert.equal(projected.find((group) => group.jid === community).role, 'superadmin');
  assert.equal(projectGroup({
    id: family,
    subject: 'device match',
    participants: [{ id: `${PHONE}@c.us`, isSuperAdmin: true }],
  }, { id: `${PHONE}:14@s.whatsapp.net` }).role, 'superadmin');
  const many = linkAndFilter([
    { jid: community, subject: 'parent', participantCount: 1, participantListPartial: false, isAdmin: false, role: 'member', adminCount: 0, isCommunity: true, isCommunityAnnounce: false },
    ...Array.from({ length: 201 }, (_, index) => ({
      jid: `1203631000000${String(index).padStart(5, '0')}@g.us`,
      subject: 'child',
      participantCount: 1,
      participantListPartial: false,
      isAdmin: false,
      role: 'member',
      adminCount: 0,
      isCommunity: false,
      isCommunityAnnounce: false,
      linkedParentJid: community,
    })),
  ], { groupJid: community, limit: 1 });
  assert.equal(many.groups[0].linkedGroupCount, 201);
  assert.equal(many.groups[0].linkedGroupJids.length, 200);
  assert.equal(many.groups[0].linkedGroupJidsTruncated, true);

  let now = 1_000;
  const guard = new GroupQueryGuard({ ttlMs: 1_000, cooldownMs: 5_000, now: () => now });
  let inflight = 0;
  let release;
  const first = guard.load(() => new Promise((resolve) => {
    inflight += 1;
    release = () => resolve(projected);
  }));
  const second = guard.load(() => { inflight += 1; return Promise.resolve([]); });
  await Promise.resolve();
  assert.equal(inflight, 1);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.length, projected.length);
  assert.equal(right.length, projected.length);
  assert.equal((await guard.load(async () => { inflight += 1; return []; })).length, projected.length);
  assert.equal(inflight, 1);
  now += 1_001;
  assert.equal((await guard.load(async () => [])).length, 0);
  now += 1_001;
  await assert.rejects(guard.load(async () => { throw new Error('rate-overlimit'); }), /rate-overlimit/);
  await assert.rejects(guard.fetchOne(async () => { throw new Error('metadata should not run'); }), GroupRateLimitError);
  assert.match(publicGroupError(new GroupRateLimitError(1500)), /Wait 2 seconds/);
  assert.equal(publicGroupError(new Boom(`not-authorized ${PHONE}@s.whatsapp.net`, { statusCode: 403 })), 'This account cannot read that group.');
  assert.equal(publicGroupError(new Error(`failed for ${OTHER}@s.whatsapp.net`)), 'Could not read group metadata.');
  assert.doesNotMatch(publicGroupError(new Boom('rate-overlimit', { data: 429 })), new RegExp(PHONE));

  const happy = participatingSocket(
    async () => directory,
    async (jid) => {
      assert.equal(jid, fresh);
      return {
        id: fresh,
        subject: 'New subgroup',
        linkedParent: community,
        participants: [{ id: `${OTHER}@s.whatsapp.net`, admin: 'admin' }],
      };
    },
  );
  const happyServer = await start(session(happy.socket));
  servers.push(happyServer);
  const listed = await mcp(happyServer.url, 'tools/list', {});
  const tool = listed.tools.find((item) => item.name === 'whatsapp_group_info');
  assert.ok(tool);
  assert.match(tool.description, /does not send, delete, or return member phone numbers/i);
  assert.doesNotMatch(tool.description, /ALLOW_SEND|ALLOW_DELETE|disabled/);

  const all = JSON.parse(textOf(await mcp(happyServer.url, 'tools/call', { name: 'whatsapp_group_info', arguments: {} })));
  assert.equal(happy.calls.all, 1);
  assert.equal(happy.calls.one, 0);
  assert.equal(all.matched, 4);
  assert.equal(all.returned, 4);
  const byId = Object.fromEntries(all.groups.map((group) => [group.jid, group]));
  assert.equal(byId[community].participantCount, 3);
  assert.equal(byId[community].role, 'superadmin');
  assert.equal(byId[community].isAdmin, true);
  assert.equal(byId[community].adminCount, 2);
  assert.equal(byId[community].isCommunity, true);
  assert.equal(byId[community].linkedGroupCount, 2);
  assert.deepEqual(byId[community].linkedGroupJids, [announce, events]);
  assert.equal(byId[announce].participantCount, 100);
  assert.equal(byId[announce].participantListPartial, true);
  assert.equal(byId[announce].role, 'admin');
  assert.equal(byId[announce].isCommunityAnnounce, true);
  assert.equal(byId[announce].linkedParentJid, community);
  assert.equal(byId[events].role, 'admin');
  assert.equal(byId[events].participantCount, 2);
  assert.equal(byId[family].role, 'member');
  assert.equal(byId[family].isAdmin, false);
  assert.equal(byId[family].participantCount, 2);
  assert.equal(byId[family].adminCount, 1);
  assert.equal(Object.hasOwn(byId[family], 'linkedParentJid'), false);

  const cached = await mcp(happyServer.url, 'tools/call', { name: 'whatsapp_group_info', arguments: { name: 'mexico' } });
  assert.equal(happy.calls.all, 1);
  const mexico = JSON.parse(textOf(cached));
  assert.equal(mexico.matched, 2);
  assert.deepEqual(mexico.groups.map((group) => group.jid).sort(), [community, announce]);
  assert.equal(mexico.groups.find((group) => group.jid === community).linkedGroupCount, 2);

  const page = JSON.parse(textOf(await mcp(happyServer.url, 'tools/call', {
    name: 'whatsapp_group_info', arguments: { name: 'builders', limit: 1 },
  })));
  assert.equal(page.matched, 3);
  assert.equal(page.returned, 1);
  assert.equal(page.groups[0].jid, events);

  const one = JSON.parse(textOf(await mcp(happyServer.url, 'tools/call', {
    name: 'whatsapp_group_info', arguments: { group: community, name: 'family' },
  })));
  assert.equal(one.returned, 1);
  assert.equal(one.groups[0].jid, community);
  assert.equal(happy.calls.one, 0);

  const created = JSON.parse(textOf(await mcp(happyServer.url, 'tools/call', {
    name: 'whatsapp_group_info', arguments: { group: fresh },
  })));
  assert.equal(happy.calls.one, 1);
  assert.equal(created.groups[0].role, 'unknown');
  assert.equal(created.groups[0].isAdmin, false);
  assert.equal(created.groups[0].adminCount, 1);
  assert.equal(created.groups[0].linkedParentJid, community);
  await mcp(happyServer.url, 'tools/call', { name: 'whatsapp_group_info', arguments: { group: fresh } });
  assert.equal(happy.calls.one, 1);
  assert.equal(happy.calls.all, 1);

  const offline = participatingSocket(async () => { throw new Error('should not fetch'); }, async () => { throw new Error('should not fetch'); });
  const offlineServer = await start(session(offline.socket, 'connecting'));
  servers.push(offlineServer);
  const disconnected = await mcp(offlineServer.url, 'tools/call', { name: 'whatsapp_group_info', arguments: {} });
  assert.equal(disconnected.isError, true);
  assert.match(textOf(disconnected), /not connected/);
  assert.doesNotMatch(textOf(disconnected), /disabled|ALLOW_SEND|ALLOW_DELETE/);
  assert.equal(offline.calls.all, 0);

  const invalid = await mcp(happyServer.url, 'tools/call', {
    name: 'whatsapp_group_info', arguments: { group: PHONE },
  });
  assert.equal(invalid.isError, true);
  assert.match(textOf(invalid), /@g\.us/);
  assert.equal(happy.calls.all, 1);

  let mode = 'closed';
  const errors = participatingSocket(
    async () => {
      if (mode === 'closed') throw new Boom('Connection Closed', { statusCode: 428 });
      if (mode === 'leak') throw new Error(`failed for ${OTHER}@s.whatsapp.net`);
      throw new Boom('rate-overlimit', { data: 429 });
    },
    async () => { throw new Error('metadata should not run'); },
  );
  const errorServer = await start(session(errors.socket));
  servers.push(errorServer);
  assert.match(textOf(await mcp(errorServer.url, 'tools/call', { name: 'whatsapp_group_info', arguments: { group: fresh } })), /not connected/);
  mode = 'leak';
  assert.match(textOf(await mcp(errorServer.url, 'tools/call', { name: 'whatsapp_group_info', arguments: {} })), /Could not read group metadata/);
  mode = 'limit';
  assert.match(textOf(await mcp(errorServer.url, 'tools/call', { name: 'whatsapp_group_info', arguments: { group: fresh } })), /rate-limited/);
  const callsAfterLimit = errors.calls.all;
  assert.match(textOf(await mcp(errorServer.url, 'tools/call', { name: 'whatsapp_group_info', arguments: { group: fresh } })), /rate-limited/);
  assert.equal(errors.calls.all, callsAfterLimit);
  assert.equal(errors.calls.one, 0);

  const manyGroups = Object.fromEntries(Array.from({ length: 60 }, (_, index) => {
    const jid = `1203632000000${String(index).padStart(5, '0')}@g.us`;
    return [jid, {
      id: jid,
      subject: index === 0 ? 'Community parent' : `Listed group ${index}`,
      isCommunity: index === 0,
      participants: [],
    }];
  }));
  const allGroups = participatingSocket(async () => manyGroups, async () => { throw new Error('metadata should not run'); });
  const allServer = await start(session(allGroups.socket));
  servers.push(allServer);
  const paged = JSON.parse(textOf(await mcp(allServer.url, 'tools/call', { name: 'whatsapp_group_info', arguments: {} })));
  assert.equal(paged.matched, 60);
  assert.equal(paged.returned, 50);
  assert.equal(allGroups.calls.all, 1);
  const every = JSON.parse(textOf(await mcp(allServer.url, 'tools/call', { name: 'whatsapp_group_info', arguments: { all: true, limit: 1 } })));
  assert.equal(every.matched, 60);
  assert.equal(every.returned, 60);
  assert.equal(every.groups.every((group) => typeof group.participantCount === 'number'), true);
  assert.equal(every.groups.some((group) => group.isCommunity), true);
  assert.equal(allGroups.calls.all, 1);

  console.log('PASS: group counts, admin role, community links, name filter, list-all, cache, rate limit, disconnected read, no member phone numbers');
} finally {
  await Promise.all(servers.map((server) => server.close()));
}
