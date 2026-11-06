import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { workerData } from 'node:worker_threads';
import { blocklistSenderKey } from './webhook-blocklist.js';

// A synchronous SQLite COMMIT can fsync/checkpoint for far longer than the row
// budget. Keep that work off the socket thread; never weaken SQLite durability.
const { dbPath, cancel: buffer } = workerData as { dbPath: string; cancel: SharedArrayBuffer };
const cancel = new Int32Array(buffer);
const db = new DatabaseSync(dbPath);
try {
  // Wait for ordinary app/old-build writes here without blocking the main loop.
  db.exec('PRAGMA busy_timeout = 1000');
  const select = db.prepare(`SELECT rowid, jid, participant FROM messages
    WHERE sender_key IS NULL LIMIT 50`);
  const update = db.prepare('UPDATE messages SET sender_key = ? WHERE rowid = ? AND sender_key IS NULL');
  while (!Atomics.load(cancel, 0)) {
    await yieldToEventLoop();
    // IMMEDIATE reserves the writer before reading/updating the transaction,
    // avoiding a read-to-write upgrade failure when another connection writes.
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = select.all() as Array<{ rowid: number; jid: string; participant: string | null }>;
      if (!rows.length) {
        db.exec('COMMIT');
        break;
      }
      const deadline = performance.now() + 4;
      for (const row of rows) {
        if (Atomics.load(cancel, 0)) break;
        const sender = row.jid.endsWith('@g.us') ? row.participant ?? '' : row.jid;
        update.run(blocklistSenderKey(sender) ?? '', row.rowid);
        if (performance.now() >= deadline) break;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
} finally {
  db.close();
}
