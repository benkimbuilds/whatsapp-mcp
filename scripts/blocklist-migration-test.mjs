import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { MemoryStore } from '../dist/store.js';

const dir = await mkdtemp(path.join(tmpdir(), 'sender-key-migration-'));
const file = path.join(dir, 'history.sqlite');
const pn = '525512345678@s.whatsapp.net';
const legacy = '5215512345678:7@s.whatsapp.net';
const group = '12345@g.us';
let store, external;
try {
  store = new MemoryStore(file);
  await store.backfillSenderKeys();
  external = new DatabaseSync(file); // Deliberately never register any custom functions.
  const insert = external.prepare(`INSERT INTO messages (jid, id, from_me, participant, timestamp, push_name, text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (jid, id) DO UPDATE SET from_me = COALESCE(excluded.from_me, messages.from_me),
      participant = COALESCE(excluded.participant, messages.participant), timestamp = excluded.timestamp,
      push_name = excluded.push_name,
      text = CASE WHEN messages.deleted_for_everyone = 1 THEN NULL ELSE excluded.text END`);
  // Same explicit-column INSERT/upsert shape used before sender_key existed.
  insert.run(pn, 'old', 0, null, 1, null, 'old build');
  insert.run(pn, 'old', 0, null, 2, null, 'old build replay');
  assert.equal(external.prepare("SELECT sender_key FROM messages WHERE id = 'old'").get().sender_key, null);
  // Recurring sweep must discover later old-build writes without a restart or explicit backfill call.
  const deadline = Date.now() + 5000;
  while (external.prepare("SELECT sender_key FROM messages WHERE id = 'old'").get().sender_key === null) {
    assert.ok(Date.now() < deadline, 'Periodic sweep did not pick up old-build insert');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const entry = store.webhookBlocklist.add({ identifier: pn, approved_by: 'Test', reason: 'Compatibility' }).entry;
  assert.equal(store.webhookBlocklist.list().entries.find(row => row.jid === entry.jid).stored_count, 1);
  external.exec("UPDATE messages SET text = 'manual update' WHERE id = 'old'; DELETE FROM messages WHERE id = 'old';");
  assert.equal(store.webhookBlocklist.list().entries.find(row => row.jid === entry.jid).stored_count, 0);
  store.webhookBlocklist.remove(pn);

  store.upsertMessage({ key: { remoteJid: group, id: 'group', participant: legacy, fromMe: false }, message: { conversation: 'test' } });
  store.upsertMessage({ key: { remoteJid: group, id: 'group' }, message: { conversation: 'partial replay' } });
  const key = () => external.prepare("SELECT sender_key FROM messages WHERE id = 'group'").get().sender_key;
  assert.equal(key(), pn, 'Partial replay retains persisted participant key');
  store.markDeletedForEveryone(group, 'group');
  assert.equal(key(), pn, 'Tombstone retains group participant key');
  store.upsertMessage({ key: { remoteJid: group, id: 'group', participant: '123456@lid' }, message: { conversation: 'replacement' } });
  assert.equal(key(), '123456@lid');
  store.markDeletedForEveryone(pn, 'dm-tombstone');
  assert.equal(external.prepare("SELECT sender_key FROM messages WHERE id = 'dm-tombstone'").get().sender_key, pn);
  insert.run('invalid', 'invalid', null, null, 1, null, 'invalid');
  await store.backfillSenderKeys();
  assert.equal(external.prepare("SELECT sender_key FROM messages WHERE id = 'invalid'").get().sender_key, '');
  assert.equal(external.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_key IS NULL').get().n, 0);
  await store.backfillSenderKeys(); // Idempotent.

  // A competing writer forces maintenance to wait in SQLite. The main thread
  // must still service timers and indexed list calls while that lock is held.
  insert.run(pn, 'locked-writer', 0, null, 1, null, 'lock test');
  external.exec('BEGIN IMMEDIATE');
  let ticks = 0;
  const probe = setInterval(() => {
    ticks++;
    const start = performance.now();
    store.webhookBlocklist.list();
    assert.ok(performance.now() - start < 100, 'List blocked by maintenance writer wait');
  }, 10);
  let locked = true;
  const release = setTimeout(() => { external.exec('COMMIT'); locked = false; }, 200);
  try {
    await store.backfillSenderKeys();
  } finally {
    clearInterval(probe);
    clearTimeout(release);
    if (locked) external.exec('ROLLBACK');
  }
  assert.ok(ticks >= 5, 'SQLite writer wait must not block the socket event loop');
  assert.equal(external.prepare("SELECT sender_key FROM messages WHERE id = 'locked-writer'").get().sender_key, pn);

  // Exercise normal app writes while the worker updates the same WAL database.
  external.exec('BEGIN');
  for (let i = 0; i < 10_000; i++) insert.run(pn, `concurrent-${i}`, 0, null, i, null, 'old build');
  external.exec('COMMIT');
  let writes = 0;
  const appWrites = setInterval(() => {
    store.upsertMessage({ key: { remoteJid: group, id: `app-${writes++}`, participant: legacy, fromMe: false }, message: { conversation: 'live' } });
  }, 10);
  try {
    await store.backfillSenderKeys();
  } finally {
    clearInterval(appWrites);
  }
  assert.ok(writes > 0, 'App writes must continue during maintenance');
  assert.equal(external.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_key IS NULL').get().n, 0);

  // Cancellation finishes a bounded transaction and leaves NULLs for restart.
  external.exec("UPDATE messages SET sender_key = NULL WHERE id LIKE 'concurrent-%'");
  const cancelled = store.backfillSenderKeys();
  store.close();
  await cancelled;
  // Rollback: external/old writer can INSERT, upsert, UPDATE and DELETE while app is stopped.
  insert.run(pn, 'after-rollback', 0, null, 1, null, 'rollback');
  external.exec("UPDATE messages SET text = 'rollback update' WHERE id = 'invalid'; DELETE FROM messages WHERE id = 'invalid';");
  store = new MemoryStore(file);
  await store.backfillSenderKeys();
  assert.equal(external.prepare("SELECT sender_key FROM messages WHERE id = 'after-rollback'").get().sender_key, pn);
  console.log('PASS: function-free external writes, old SQL inserts/upserts, periodic NULL catch-up, nonblocking writer waits, restart, replay and tombstone keys');
} finally {
  external?.close();
  try { store?.close(); } catch {}
  await rm(dir, { recursive: true, force: true });
}
