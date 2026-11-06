import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../dist/store.js';
import { blocklistSenderKey } from '../dist/webhook-blocklist.js';

// Entirely synthetic, on disk, with no sockets or production data. Start with
// the pre-migration schema so opening MemoryStore exercises batched backfill.
const dir = await mkdtemp(path.join(tmpdir(), 'blocklist-perf-'));
const dbPath = path.join(dir, 'history.sqlite');
const pn = '525512345678@s.whatsapp.net';
const legacy = '5215512345678@s.whatsapp.net';
const lid = '111111@lid';
const group = '123456@g.us';
let store;
let fixture;
try {
  fixture = new DatabaseSync(dbPath);
  fixture.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE messages (jid TEXT NOT NULL, id TEXT NOT NULL, from_me INTEGER,
      participant TEXT, timestamp INTEGER, push_name TEXT, text TEXT,
      PRIMARY KEY (jid, id));`);
  const insert = fixture.prepare('INSERT INTO messages (jid, id, from_me, participant, timestamp, text) VALUES (?, ?, ?, ?, ?, ?)');
  fixture.exec('BEGIN');
  for (let i = 0; i < 156_000; i++) {
    // Includes unrelated DMs, groups and outgoing rows, not just one chat.
    insert.run(i % 2 ? `${15550000000 + i % 1000}@s.whatsapp.net` : group,
      `bulk-${i}`, i % 7 === 0 ? 1 : 0, `${900000 + i % 500}@lid`, i, 'fake');
  }
  // Canonical, legacy, device, c.us, whitespace, case and bare phone forms
  // accepted by the old matcher must all count, for DMs and group participants.
  const senders = [pn, legacy, '5215512345678:7@s.whatsapp.net', '525512345678@c.us',
    ' 525512345678@S.WHATSAPP.NET ', '+52 55 1234 5678', lid, '111111:2@LID',
    '222222@lid', '333333@lid', '444444@lid', '555555@lid', '666666@lid'];
  let seq = 0;
  for (const sender of senders) {
    for (const chat of [sender, group]) {
      for (const fromMe of [0, null, 1]) insert.run(chat, `match-${seq++}`, fromMe, sender, seq, 'fake');
    }
  }
  for (const sender of ['bad@lid', '525512345678@invalid', '525512345678_1@s.whatsapp.net', '123456@g.us', '']) {
    insert.run(sender, `invalid-${seq++}`, 0, null, seq, 'fake');
    insert.run(group, `invalid-${seq++}`, 0, sender, seq, 'fake');
  }
  // A malformed uppercase group used to be treated as a DM; preserve that.
  insert.run('123456@G.US', 'uppercase-group', 0, pn, seq, 'fake');
  fixture.exec('COMMIT');
  // Simulate PR #22's expression index; only this fixture connection knows the UDF.
  fixture.function('blocklist_sender_key', { deterministic: true }, raw => typeof raw === 'string' ? blocklistSenderKey(raw) : null);
  fixture.exec(`CREATE INDEX messages_by_blocklist_sender ON messages
    (blocklist_sender_key(CASE WHEN substr(jid, -5) = '@g.us' THEN participant ELSE jid END), jid, id)
    WHERE from_me IS NOT 1`);
  fixture.close();
  fixture = undefined;

  const migrationStart = performance.now();
  store = new MemoryStore(dbPath);
  const migrationMs = performance.now() - migrationStart;
  // Initialize the policy before probing.
  const maintenancePolicy = store.webhookBlocklist;
  let backfillListMaxMs = 0;
  let backfillTicks = 0, maxBackfillTickMs = 0, lastTick = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    maxBackfillTickMs = Math.max(maxBackfillTickMs, now - lastTick);
    lastTick = now;
    backfillTicks++;
    const listStart = performance.now();
    maintenancePolicy.list();
    backfillListMaxMs = Math.max(backfillListMaxMs, performance.now() - listStart);
  }, 0);
  const backfillStart = performance.now();
  let backfillMs;
  try {
    await store.backfillSenderKeys();
    backfillMs = performance.now() - backfillStart;
    // Include the final batch/connection close in the observed timer gaps.
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally {
    clearInterval(probe);
  }
  assert.ok(backfillTicks > 1, 'Backfill must yield between small batches');
  assert.ok(maxBackfillTickMs < 100, `Backfill delayed event loop ${maxBackfillTickMs.toFixed(2)}ms`);
  assert.ok(backfillListMaxMs < 100, `List during backfill took ${backfillListMaxMs.toFixed(2)}ms`);
  for (let i = 0; i < 500; i++) store.linkJids(`${900000 + i}@lid`, `${15550001000 + i}@s.whatsapp.net`);
  store.linkJids(lid, legacy);
  store.linkJids('222222@lid', pn); // multiple LIDs for the same PN
  store.linkJids('333333@lid', '777777@lid');
  store.linkJids('777777@lid', pn); // multi-hop mapping
  store.upsertContact({ id: '444444@lid', phoneNumber: pn }); // contacts fallback
  const entry = store.webhookBlocklist.add({ identifier: pn, approved_by: 'Test', reason: 'Synthetic performance fixture' }).entry;
  const unknown = store.webhookBlocklist.add({ identifier: '555555@lid', approved_by: 'Test', reason: 'Late LID mapping' }).entry;
  // Also resolve a LID stored only in a contact's lid field.
  store.upsertContact({ id: '15550009999@s.whatsapp.net', lid: '666666@lid', phoneNumber: pn });

  const db = new DatabaseSync(dbPath);
  fixture = db;
  // No functions registered: this is also the sqlite3 CLI compatibility check.
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'messages_by_blocklist_sender'").get(), undefined);
  db.prepare('UPDATE messages SET text = ? WHERE id = ?').run('manual edit', 'uppercase-group');
  db.prepare('DELETE FROM messages WHERE id = ?').run('uppercase-group');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_key IS NULL').get().n, 0);
  // Force the contact fallback without a corresponding jid_links edge.
  db.prepare('DELETE FROM jid_links WHERE jid IN (?, ?)').run('444444@lid', '666666@lid');
  const allRows = db.prepare('SELECT jid, id, participant, from_me FROM messages').all();
  const oracle = entry => allRows.filter(row => row.from_me !== 1 && store.webhookBlocklist.matchesEntry(
    entry, row.jid.endsWith('@g.us') ? row.participant ?? '' : row.jid, jid => store.phoneForJid(jid)));
  const baselineStart = performance.now();
  const expected = oracle(entry);
  const baselineMs = performance.now() - baselineStart;
  assert.equal(expected.length, 48);
  const assertCounts = () => {
    const entries = store.webhookBlocklist.list().entries;
    assert.equal(entries.find(e => e.jid === entry.jid).stored_count, oracle(entry).length);
    assert.equal(entries.find(e => e.jid === unknown.jid).stored_count, oracle(unknown).length);
  };
  assertCounts();

  const durations = [];
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    const result = store.webhookBlocklist.list();
    durations.push(performance.now() - start);
    assert.equal(result.entries.find(e => e.jid === entry.jid).stored_count, expected.length);
  }
  const worstMs = Math.max(...durations);
  assert.ok(worstMs < 100, `156k-row blocklist list took ${worstMs.toFixed(2)}ms (budget 100ms)`);

  // Deterministic guard against returning to a table scan, even on fast hosts.
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM messages
    WHERE from_me IS NOT 1 AND sender_key = ?`).all(pn);
  assert.ok(plan.some(row => /SEARCH messages USING .*messages_by_sender_key/.test(row.detail)), JSON.stringify(plan));
  assert.ok(!plan.some(row => /SCAN messages/.test(row.detail)), JSON.stringify(plan));

  store.linkJids('555555@lid', legacy); // late mapping changes counts immediately
  assertCounts();
  store.linkJids(lid, '15550008888@s.whatsapp.net'); // replaced mapping stops matching
  assertCounts();
  const beforePurge = oracle(entry);
  const purged = store.webhookBlocklist.purge(entry.jid, 'PURGE');
  assert.equal(purged.purged_messages, beforePurge.length);
  assert.equal(store.webhookBlocklist.list().entries.find(e => e.jid === entry.jid).stored_count, 0);
  const purgedIds = new Set(beforePurge.map(row => row.id));
  const remaining = new Set(db.prepare('SELECT id FROM messages').all().map(row => row.id));
  for (const row of allRows) assert.equal(remaining.has(row.id), !purgedIds.has(row.id), row.id);

  // App code maintains keys for writes, participant changes, outgoing rows,
  // unknown-direction tombstones and replay upserts without a count cache.
  store.webhookBlocklist.remove(pn);
  store.upsertMessage({ key: { remoteJid: group, id: 'live', participant: pn, fromMe: false }, message: { conversation: 'fake' } });
  store.upsertMessage({ key: { remoteJid: group, id: 'live', participant: '15550007777@s.whatsapp.net', fromMe: false }, message: { conversation: 'fake' } });
  store.markDeletedForEveryone(pn, 'tombstone');
  store.webhookBlocklist.add({ identifier: pn, approved_by: 'Test', reason: 'Re-add' });
  assert.equal(store.webhookBlocklist.list().entries.find(e => e.jid === pn).stored_count, 1);
  // A dense match also stays inside the budget: COUNT runs within SQLite and
  // never transfers a message-sized result to JavaScript. Check that queued
  // event-loop work gets its turn within the same latency budget.
  db.prepare("UPDATE messages SET jid = ?, from_me = 0, sender_key = NULL WHERE id LIKE 'bulk-%'").run(pn);
  await store.backfillSenderKeys();
  const tickStart = performance.now();
  const nextTick = new Promise(resolve => setImmediate(resolve));
  const denseStart = performance.now();
  assert.equal(store.webhookBlocklist.list().entries.find(e => e.jid === pn).stored_count, 156_001);
  const denseMs = performance.now() - denseStart;
  await nextTick;
  const eventLoopMs = performance.now() - tickStart;
  assert.ok(eventLoopMs < 100, `Dense count delayed queued work ${eventLoopMs.toFixed(2)}ms`);
  store.close();
  store = undefined;
  const reopenStart = performance.now();
  store = new MemoryStore(dbPath);
  const reopenMs = performance.now() - reopenStart;
  await store.backfillSenderKeys();
  assert.equal(store.webhookBlocklist.list().entries.find(e => e.jid === pn).stored_count, 156_001);
  console.log(`PASS: synthetic 156k+ rows; old filter ${baselineMs.toFixed(2)}ms; startup migration ${migrationMs.toFixed(2)}ms; backfill ${backfillMs.toFixed(2)}ms, ${backfillTicks} ticks, max tick ${maxBackfillTickMs.toFixed(2)}ms, max concurrent list ${backfillListMaxMs.toFixed(2)}ms; reopen ${reopenMs.toFixed(2)}ms; list mean ${(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2)}ms, max ${worstMs.toFixed(2)}ms; dense count ${denseMs.toFixed(2)}ms, queued tick ${eventLoopMs.toFixed(2)}ms; exact counts, indexed plan, late mappings, purge and writes`);
} finally {
  fixture?.close();
  store?.close();
  await rm(dir, { recursive: true, force: true });
}
