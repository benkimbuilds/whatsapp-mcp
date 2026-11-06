import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../dist/store.js';

const dir = await mkdtemp(path.join(tmpdir(), 'whatsapp-history-'));
const dbPath = path.join(dir, 'auth', 'history.sqlite');
const jid = '15555550100@s.whatsapp.net';

try {
  const first = new MemoryStore(dbPath, 2);
  assert.equal((await stat(dbPath)).mode & 0o777, 0o600);
  first.upsertChat({ id: jid, name: 'Example', conversationTimestamp: 10 });
  for (let n = 1; n <= 5; n++) {
    first.upsertMessage({
      key: { remoteJid: jid, id: `m${n}`, fromMe: n % 2 === 0 },
      messageTimestamp: n,
      message: { conversation: `message ${n}` },
    });
  }
  first.upsertMessage({
    key: { remoteJid: jid, id: 'm5', fromMe: false },
    messageTimestamp: 5,
    message: { conversation: 'edited message 5' },
  });
  first.close();

  const reopened = new MemoryStore(dbPath, 2);
  assert.equal(reopened.listChats(10)[0].name, 'Example');
  const newest = reopened.listMessages(jid, 2);
  assert.deepEqual(newest.messages.map((m) => m.text), ['message 4', 'edited message 5']);
  assert.equal(newest.nextOffset, 2);
  const older = reopened.listMessages(jid, 2, newest.nextOffset);
  assert.deepEqual(older.messages.map((m) => m.text), ['message 2', 'message 3']);
  assert.equal(older.nextOffset, 4);
  const oldest = reopened.listMessages(jid, 2, older.nextOffset);
  assert.deepEqual(oldest.messages.map((m) => m.text), ['message 1']);
  assert.equal(oldest.nextOffset, undefined);

  reopened.upsertMessage({
    key: { remoteJid: jid, id: 'm2', fromMe: true },
    messageTimestamp: 2,
    message: { conversation: 'message 2' },
  });
  reopened.updateMessage(
    { remoteJid: jid, id: 'm2', fromMe: true },
    { key: { remoteJid: jid, id: 'other-protocol-key', fromMe: true }, message: { conversation: 'edited message 2' } },
  );
  assert.equal(reopened.listMessages(jid, 5).messages.find((m) => m.id === 'm2')?.text, 'edited message 2');
  assert.equal(reopened.listMessages(jid, 10).messages.some((m) => m.id === 'other-protocol-key'), false);

  assert.deepEqual(reopened.getOwnMessageKey(jid, 'm4'), { remoteJid: jid, id: 'm4', fromMe: true });
  assert.equal(reopened.getOwnMessageKey(jid, 'm5'), null);
  reopened.markDeleteRequested(jid, 'm4');
  const pending = reopened.listMessages(jid, 5).messages.find((m) => m.id === 'm4');
  assert.equal(pending?.text, '[delete requested]');
  assert.equal(pending?.deleteRequested, true);
  reopened.markDeletedForEveryone(jid, 'm4');
  assert.equal(reopened.getOwnMessageKey(jid, 'm4'), null);
  reopened.upsertMessage({
    key: { remoteJid: jid, id: 'm4', fromMe: true },
    messageTimestamp: 4,
    message: { conversation: 'message 4 returned by history sync' },
  });
  const deleted = reopened.listMessages(jid, 5).messages.find((m) => m.id === 'm4');
  assert.equal(deleted?.text, '[deleted for everyone]');
  assert.equal(deleted?.deleteRequested, false);
  assert.equal(deleted?.deletedForEveryone, true);

  const group = '123456789@g.us';
  reopened.upsertMessage({
    key: { remoteJid: group, id: 'group-own', fromMe: true, participant: jid },
    messageTimestamp: 11,
    message: { conversation: 'group message' },
  });
  assert.deepEqual(reopened.getOwnMessageKey(group, 'group-own'), { remoteJid: group, id: 'group-own', fromMe: true, participant: jid });

  reopened.deleteChats([jid, group]);
  assert.deepEqual(reopened.listChats(10), []);
  assert.deepEqual(reopened.listMessages(jid, 10).messages, []);
  reopened.close();

  const legacyPath = path.join(dir, 'legacy', 'history.sqlite');
  await mkdir(path.dirname(legacyPath), { recursive: true });
  const legacyDb = new DatabaseSync(legacyPath);
  legacyDb.exec(`CREATE TABLE messages (
    jid TEXT NOT NULL, id TEXT NOT NULL, from_me INTEGER, timestamp INTEGER,
    push_name TEXT, text TEXT, PRIMARY KEY (jid, id)
  )`);
  legacyDb.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(jid, 'old-outgoing', 1, 1, null, 'old sent message');
  legacyDb.close();
  const migrated = new MemoryStore(legacyPath);
  assert.deepEqual(migrated.getOwnMessageKey(jid, 'old-outgoing'), { remoteJid: jid, id: 'old-outgoing', fromMe: true });
  migrated.markDeletedForEveryone(jid, 'old-outgoing');
  assert.equal(migrated.listMessages(jid, 10).messages[0].deletedForEveryone, true);
  migrated.close();
  console.log('PASS: SQLite history survives restart, deduplicates, pages, and preserves deletion tombstones');
} finally {
  await rm(dir, { recursive: true, force: true });
}
