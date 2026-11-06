import { WebhookBlocklist, blocklistSenderKey, type BlockEntry } from './webhook-blocklist.js';
/** Baileys' recent-message cache backed by a durable, per-session SQLite history. */
import { WAMessageStubType, extractMessageContent, type Chat, type Contact, type WAMessage, type WAMessageKey, type proto } from '@whiskeysockets/baileys';
import { describeMedia, type PreparedMedia } from './media.js';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

export type ChatSummary = {
  id: string;
  name?: string;
  unreadCount?: number;
  conversationTimestamp?: number;
};

export type DraftRecord = {
  id: string;
  jid: string;
  text: string;
  sendAt: number | null;
  createdAt: number;
};

/** A saved message ready to pass as Baileys `quoted`, or whose key a reaction can target. */
export type StoredMessage = {
  /** Chat the message was found in. Can be the linked PN/LID peer of the requested chat. */
  jid: string;
  /** cache: the full WAMessage from this process. history: rebuilt from saved text. */
  source: 'cache' | 'history';
  message: WAMessage;
};

export class MemoryStore {
  readonly chats = new Map<string, Chat>();
  readonly contacts = new Map<string, Contact>();
  /** jid -> message id -> WAMessage (newest kept; capped per chat) */
  private readonly messagesByChat = new Map<string, Map<string, WAMessage>>();
  /** Content-free timestamps used to suppress late chat-preview updates. */
  private readonly blockedTimestamps = new Map<string, Set<number>>();
  /** Draft ids whose send is in progress in this process. Never resumed on startup. */
  private readonly draftSends = new Set<string>();
  private readonly maxPerChat: number;
  private readonly db: DatabaseSync;
  private blocklist?: WebhookBlocklist;
  private closed = false;
  private senderBackfill?: Promise<void>;
  private senderBackfillCancel?: Int32Array;
  private readonly dbPath: string;
  private readonly senderBackfillTimer: NodeJS.Timeout;
  get webhookBlocklist(): WebhookBlocklist {
    if (!this.blocklist) this.setInboundBlocklist(new WebhookBlocklist(this.db));
    return this.blocklist!;
  }

  constructor(dbPath: string, maxPerChat = 500) {
    this.maxPerChat = maxPerChat;
    this.dbPath = path.resolve(dbPath);
    mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      -- Serialize app writes with the maintenance connection's short transactions.
      PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        name TEXT,
        unread_count INTEGER,
        conversation_timestamp INTEGER
      );
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        name TEXT,
        notify TEXT,
        verified_name TEXT,
        push_name TEXT,
        pn TEXT,
        lid TEXT,
        name_fold TEXT,
        notify_fold TEXT,
        verified_fold TEXT,
        push_fold TEXT
      );
      CREATE TABLE IF NOT EXISTS jid_links (
        jid TEXT PRIMARY KEY,
        peer TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        jid TEXT NOT NULL,
        id TEXT NOT NULL,
        from_me INTEGER,
        participant TEXT,
        timestamp INTEGER,
        push_name TEXT,
        text TEXT,
        delete_requested INTEGER NOT NULL DEFAULT 0,
        deleted_for_everyone INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (jid, id)
      );
      CREATE INDEX IF NOT EXISTS messages_by_chat_time
        ON messages (jid, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS messages_by_time
        ON messages (timestamp DESC, id DESC);
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        jid TEXT NOT NULL,
        text TEXT NOT NULL,
        send_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS drafts_by_created
        ON drafts (created_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS mcp_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        tool TEXT NOT NULL,
        action TEXT,
        args_summary TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        ok INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mcp_requests_by_time
        ON mcp_requests (at DESC, id DESC);
    `);
    const messageColumns = this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    if (!messageColumns.some((column) => column.name === 'participant')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN participant TEXT');
    }
    if (!messageColumns.some((column) => column.name === 'deleted_for_everyone')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN deleted_for_everyone INTEGER NOT NULL DEFAULT 0');
    }
    if (!messageColumns.some((column) => column.name === 'delete_requested')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN delete_requested INTEGER NOT NULL DEFAULT 0');
    }
    if (!messageColumns.some((column) => column.name === 'mentions')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN mentions TEXT');
    }
    if (!messageColumns.some((column) => column.name === 'reply_to')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN reply_to TEXT');
    }
    if (!messageColumns.some((column) => column.name === 'reply_participant')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN reply_participant TEXT');
    }
    // Ordinary columns/indexes allow old builds and sqlite3 to write without UDFs.
    this.db.exec('DROP INDEX IF EXISTS messages_by_blocklist_sender');
    if (!messageColumns.some(column => column.name === 'sender_key')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN sender_key TEXT');
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS messages_by_sender_key
      ON messages (sender_key, from_me, jid, id) WHERE sender_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS messages_pending_sender_key
      ON messages (sender_key) WHERE sender_key IS NULL`);
    for (const [name, type] of [
      ['media_kind', 'TEXT'],
      ['media_mimetype', 'TEXT'],
      ['media_filename', 'TEXT'],
      ['media_size', 'INTEGER'],
      ['media_key', 'BLOB'],
      ['media_direct_path', 'TEXT'],
      ['media_url', 'TEXT'],
    ] as const) {
      if (!messageColumns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
      }
    }
    const contactColumns = new Set((this.db.prepare('PRAGMA table_info(contacts)').all() as Array<{ name: string }>).map((column) => column.name));
    for (const column of ['notify', 'verified_name', 'push_name', 'pn', 'lid', 'name_fold', 'notify_fold', 'verified_fold', 'push_fold']) {
      if (!contactColumns.has(column)) this.db.exec(`ALTER TABLE contacts ADD COLUMN ${column} TEXT`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS jid_links_by_peer ON jid_links (peer, jid);
      CREATE INDEX IF NOT EXISTS contacts_by_pn ON contacts (pn, id, lid);
      CREATE INDEX IF NOT EXISTS contacts_by_lid ON contacts (lid);
    `);
    const unlabeled = this.db.prepare(`
      SELECT id, name FROM contacts WHERE name IS NOT NULL AND trim(name) != '' AND name_fold IS NULL
    `).all() as Array<{ id: string; name: string }>;
    const label = this.db.prepare('UPDATE contacts SET name_fold = ? WHERE id = ?');
    for (const row of unlabeled) label.run(foldName(row.name), row.id);
    const backfill = () => {
      void this.backfillSenderKeys().catch(error => console.error('Sender key backfill failed:', error));
    };
    backfill();
    // Also pick up NULL keys written later by a rolled-back/older build.
    this.senderBackfillTimer = setInterval(backfill, 1000);
    this.senderBackfillTimer.unref();
  }

  /** Coalesced maintenance; SQLite commits/checkpoints run off the socket thread. */
  backfillSenderKeys(): Promise<void> {
    if (this.senderBackfill) return this.senderBackfill;
    if (this.closed || !this.db.prepare('SELECT 1 FROM messages WHERE sender_key IS NULL LIMIT 1').get()) {
      return Promise.resolve();
    }
    const cancel = new Int32Array(new SharedArrayBuffer(4));
    const sourceRun = import.meta.url.endsWith('.ts');
    const workerUrl = new URL(sourceRun ? './sender-key-backfill.ts' : './sender-key-backfill.js', import.meta.url);
    // npm run dev uses tsx source imports; compiled deployments use plain Node.
    const worker = new Worker(sourceRun
      ? `import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(workerUrl.href)}, ${JSON.stringify(import.meta.url)}))`
      : workerUrl, {
      eval: sourceRun,
      workerData: { dbPath: this.dbPath, cancel: cancel.buffer },
    });
    this.senderBackfillCancel = cancel;
    this.senderBackfill = new Promise<void>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', code => {
        if (code === 0 || this.closed) resolve();
        else reject(new Error(`Sender key backfill worker exited with code ${code}`));
      });
    }).finally(() => {
      this.senderBackfillCancel = undefined;
      this.senderBackfill = undefined;
    });
    return this.senderBackfill;
  }

  private messageSenderKey(jid: string, participant: string | null | undefined): string {
    // Empty means processed but unmatchable; NULL is reserved for pending backfill.
    return blocklistSenderKey(jid.endsWith('@g.us') ? participant ?? '' : jid) ?? '';
  }

  /** David supplies its account policy from david.sqlite before the socket starts. */
  setInboundBlocklist(policy: WebhookBlocklist, events?: {
    count: (entry: BlockEntry) => number; purge: (entry: BlockEntry) => number;
  }): void {
    this.blocklist = policy;
    policy.configureStorage({
      count: entry => ({ stored_count: this.countStoredForEntry(entry), event_count: events?.count(entry) ?? 0 }),
      purge: entry => {
        const rows = this.storedForEntry(entry);
        this.transaction(() => {
          for (const row of rows) {
            this.db.prepare('DELETE FROM messages WHERE jid = ? AND id = ?').run(row.jid, row.id);
            this.messagesByChat.get(row.jid)?.delete(row.id);
          }
          for (const jid of new Set(rows.map(row => row.jid))) {
            const latest = this.db.prepare('SELECT MAX(timestamp) AS timestamp FROM messages WHERE jid = ?').get(jid) as { timestamp: number | null };
            this.db.prepare('UPDATE chats SET conversation_timestamp = ? WHERE id = ?').run(latest.timestamp, jid);
            const chat = this.chats.get(jid);
            if (chat) this.chats.set(jid, { id: jid, name: chat.name, conversationTimestamp: latest.timestamp ?? undefined });
          }
        });
        return { ok: true, purged_messages: rows.length, purged_events: events?.purge(entry) ?? 0 };
      },
    });
  }

  private senderKeysForEntry(entry: BlockEntry): string[] {
    const lookup = (jid: string) => this.phoneForJid(jid);
    const keys = new Set<string>();
    const add = (raw: string) => {
      const key = blocklistSenderKey(raw);
      if (key && this.webhookBlocklist.matchesEntry(entry, key, lookup)) keys.add(key);
    };
    add(entry.jid);
    if (entry.phone) add(`${entry.phone}@s.whatsapp.net`);
    if (entry.lid) {
      add(entry.lid);
      const phone = lookup(entry.lid);
      if (phone) add(`${phone}@s.whatsapp.net`);
    }
    // Walk reverse links up to phoneForJid's four-hop limit, then verify with
    // the original matcher (which also handles cycles and replaced mappings).
    // Both the link walk and contact fallback are indexed; unrelated identities
    // and messages are never visited. Re-evaluate so late mappings are visible.
    const linked = this.db.prepare(`WITH RECURSIVE aliases(jid, hops) AS (
      VALUES (?, 0)
      UNION
      SELECT links.jid, aliases.hops + 1 FROM jid_links links
      JOIN aliases ON links.peer = aliases.jid WHERE aliases.hops < 4
    ) SELECT DISTINCT jid FROM aliases WHERE hops > 0`);
    const contacts = this.db.prepare('SELECT id, lid FROM contacts WHERE pn = ?');
    for (const key of [...keys]) {
      if (!key.endsWith('@s.whatsapp.net')) continue;
      const phones = [key];
      if (/^52\d{10}@s\.whatsapp\.net$/.test(key)) phones.push(`521${key.slice(2)}`);
      for (const phone of phones) {
        for (const row of linked.all(phone) as Array<{ jid: string }>) add(row.jid);
        for (const row of contacts.all(phone) as Array<{ id: string; lid: string | null }>) {
          add(row.id);
          if (row.lid) add(row.lid);
        }
      }
    }
    return [...keys];
  }

  private countStoredForEntry(entry: BlockEntry): number {
    // One indexed aggregate per key keeps bind counts bounded and does not
    // materialize message rows. Keys are disjoint, including PN/521 aliases.
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM messages INDEXED BY messages_by_sender_key
      WHERE from_me IS NOT 1 AND sender_key = ?`);
    return this.senderKeysForEntry(entry).reduce((total, key) =>
      total + (count.get(key) as { n: number }).n, 0);
  }

  private storedForEntry(entry: BlockEntry): Array<{ jid: string; id: string }> {
    const rows = this.db.prepare(`SELECT jid, id FROM messages INDEXED BY messages_by_sender_key
      WHERE from_me IS NOT 1 AND sender_key = ?`);
    return this.senderKeysForEntry(entry).flatMap(key => rows.all(key) as Array<{ jid: string; id: string }>);
  }

  isBlockedMessage(msg: WAMessage, count = false): boolean {
    if (msg.key.fromMe) return false;
    const group = msg.key.remoteJid?.endsWith('@g.us');
    const candidates = group ? [msg.key.participant, msg.key.participantAlt] : [msg.key.remoteJid, msg.key.remoteJidAlt];
    const lookup = (jid: string) => this.phoneForJid(jid);
    const sender = candidates.find(jid => jid && this.webhookBlocklist.matches(jid, lookup));
    if (!sender) return false;
    if (count) {
      this.webhookBlocklist.drop(sender, lookup);
      if (msg.key.remoteJid && msg.messageTimestamp != null) {
        const times = this.blockedTimestamps.get(msg.key.remoteJid) ?? new Set<number>();
        times.add(Number(msg.messageTimestamp));
        if (times.size > this.maxPerChat) times.delete(times.values().next().value!);
        this.blockedTimestamps.set(msg.key.remoteJid, times);
      }
    }
    return true;
  }

  getMessage = async (key: WAMessageKey): Promise<proto.IMessage | undefined> => {
    if (!key.remoteJid || !key.id) return undefined;
    const row = this.db.prepare('SELECT deleted_for_everyone FROM messages WHERE jid = ? AND id = ?').get(key.remoteJid, key.id) as { deleted_for_everyone: number } | undefined;
    if (row?.deleted_for_everyone) return undefined;
    return this.messagesByChat.get(key.remoteJid)?.get(key.id)?.message ?? undefined;
  };

  /** Only a message this linked account sent may be revoked through the MCP tool. */
  getOwnMessageKey(jid: string, id: string): WAMessageKey | null {
    const row = this.db.prepare('SELECT from_me, participant, deleted_for_everyone FROM messages WHERE jid = ? AND id = ?').get(jid, id) as {
      from_me: number | null; participant: string | null; deleted_for_everyone: number;
    } | undefined;
    if (!row || row.from_me !== 1 || row.deleted_for_everyone) return null;
    return { remoteJid: jid, id, fromMe: true, ...(row.participant ? { participant: row.participant } : {}) };
  }

  /**
   * The saved message with the key WhatsApp needs to quote or react to it:
   * remoteJid, id, fromMe, and the sender (participant) in a group. Uses the
   * cached WAMessage when this process still holds it, else rebuilds a text-only
   * message from history. Also checks the linked PN/LID peer of a direct chat.
   * Returns null when the id is unknown in this chat, revoked, or (in a group)
   * the sender of an incoming message was never recorded.
   */
  getStoredMessage(jid: string, id: string): StoredMessage | null {
    const select = this.db.prepare(`SELECT from_me, participant, timestamp, push_name, text, deleted_for_everyone
      FROM messages WHERE jid = ? AND id = ?`);
    const candidates = [jid];
    if (!jid.endsWith('@g.us')) {
      const links = this.db.prepare('SELECT peer AS other FROM jid_links WHERE jid = ? UNION SELECT jid AS other FROM jid_links WHERE peer = ?')
        .all(jid, jid) as Array<{ other: string }>;
      for (const link of links) if (link.other && !candidates.includes(link.other)) candidates.push(link.other);
    }
    for (const chat of candidates) {
      const row = select.get(chat, id) as {
        from_me: number | null; participant: string | null; timestamp: number | null;
        push_name: string | null; text: string | null; deleted_for_everyone: number;
      } | undefined;
      if (!row) continue;
      if (row.deleted_for_everyone) return null;
      const fromMe = row.from_me === 1;
      const group = chat.endsWith('@g.us');
      const cached = this.messagesByChat.get(chat)?.get(id);
      const participant = cached?.key.participant ?? row.participant ?? undefined;
      if (group && !fromMe && !participant) return null;
      const key: WAMessageKey = { remoteJid: chat, id, fromMe, ...(participant ? { participant } : {}) };
      if (cached?.message) {
        return { jid: chat, source: 'cache', message: { ...cached, key: { ...cached.key, ...key } } };
      }
      return {
        jid: chat,
        source: 'history',
        message: {
          key,
          message: { conversation: row.text ?? '' },
          ...(row.timestamp != null ? { messageTimestamp: row.timestamp } : {}),
          ...(row.push_name ? { pushName: row.push_name } : {}),
        },
      };
    }
    return null;
  }

  markDeleteRequested(jid: string, id: string): void {
    this.db.prepare('UPDATE messages SET delete_requested = 1 WHERE jid = ? AND id = ? AND from_me = 1 AND deleted_for_everyone = 0').run(jid, id);
  }

  markDeletedForEveryone(jid: string, id: string): void {
    this.db.prepare(`
      INSERT INTO messages (jid, id, text, delete_requested, deleted_for_everyone, sender_key)
      VALUES (?, ?, NULL, 0, 1, ?)
      ON CONFLICT (jid, id) DO UPDATE SET
        text = NULL, delete_requested = 0, deleted_for_everyone = 1,
        sender_key = excluded.sender_key,
        mentions = NULL, reply_to = NULL, reply_participant = NULL,
        media_kind = NULL, media_mimetype = NULL, media_filename = NULL,
        media_size = NULL, media_key = NULL, media_direct_path = NULL, media_url = NULL
    `).run(jid, id, this.messageSenderKey(jid,
      (this.db.prepare('SELECT participant FROM messages WHERE jid = ? AND id = ?').get(jid, id) as { participant: string | null } | undefined)?.participant));
    this.messagesByChat.get(jid)?.delete(id);
  }

  transaction<T>(work: () => T): T {
    // Initialize the one-time blocklist migration outside any history transaction.
    void this.webhookBlocklist;
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.senderBackfillTimer);
    if (this.senderBackfillCancel) {
      // Finish/rollback the current small transaction, then close the connection.
      Atomics.store(this.senderBackfillCancel, 0, 1);
    }
    this.db.close();
  }

  upsertMessage(msg: WAMessage): boolean {
    if (this.isBlockedMessage(msg, true)) return false;
    const jid = msg.key.remoteJid;
    const id = msg.key.id;
    if (!jid || !id) return false;
    let bucket = this.messagesByChat.get(jid);
    if (!bucket) {
      bucket = new Map();
      this.messagesByChat.set(jid, bucket);
    }
    bucket.set(id, msg);
    const meta = mentionMeta(msg);
    const participant = msg.key.participant ??
      (jid.endsWith('@g.us') ? (this.db.prepare('SELECT participant FROM messages WHERE jid = ? AND id = ?').get(jid, id) as { participant: string | null } | undefined)?.participant : null);
    const media = describeMedia(msg.message);
    this.db.prepare(`
      INSERT INTO messages (
        jid, id, from_me, participant, timestamp, push_name, text, mentions, reply_to, reply_participant, sender_key,
        media_kind, media_mimetype, media_filename, media_size, media_key, media_direct_path, media_url
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (jid, id) DO UPDATE SET
        sender_key = excluded.sender_key,
        from_me = COALESCE(excluded.from_me, messages.from_me),
        participant = COALESCE(excluded.participant, messages.participant),
        timestamp = excluded.timestamp,
        push_name = excluded.push_name,
        text = CASE WHEN messages.deleted_for_everyone = 1 THEN NULL ELSE excluded.text END,
        mentions = COALESCE(excluded.mentions, messages.mentions),
        reply_to = COALESCE(excluded.reply_to, messages.reply_to),
        reply_participant = COALESCE(excluded.reply_participant, messages.reply_participant),
        media_kind = CASE WHEN messages.deleted_for_everyone = 1 THEN NULL ELSE COALESCE(excluded.media_kind, messages.media_kind) END,
        media_mimetype = CASE WHEN messages.deleted_for_everyone = 1 THEN NULL ELSE COALESCE(excluded.media_mimetype, messages.media_mimetype) END,
        media_filename = CASE WHEN messages.deleted_for_everyone = 1 THEN NULL ELSE COALESCE(excluded.media_filename, messages.media_filename) END,
        media_size = CASE WHEN messages.deleted_for_everyone = 1 THEN NULL ELSE COALESCE(excluded.media_size, messages.media_size) END,
        media_key = CASE WHEN messages.deleted_for_everyone = 1 THEN NULL ELSE COALESCE(excluded.media_key, messages.media_key) END,
        media_direct_path = CASE WHEN messages.deleted_for_everyone = 1 THEN NULL ELSE COALESCE(excluded.media_direct_path, messages.media_direct_path) END,
        media_url = CASE WHEN messages.deleted_for_everyone = 1 THEN NULL ELSE COALESCE(excluded.media_url, messages.media_url) END
    `).run(jid, id, msg.key.fromMe == null ? null : Number(msg.key.fromMe),
      msg.key.participant ?? null,
      msg.messageTimestamp == null ? null : Number(msg.messageTimestamp),
      msg.pushName ?? null, extractText(msg) ?? null,
      meta.mentions, meta.replyTo, meta.replyParticipant, this.messageSenderKey(jid, participant),
      media?.kind ?? null, media?.mimetype ?? null, media?.filename ?? null, media?.size ?? null,
      media?.mediaKey ? Buffer.from(media.mediaKey) : null, media?.directPath ?? null, media?.url ?? null);
    this.captureIdentity(msg);
    if (bucket.size > this.maxPerChat) {
      const first = bucket.keys().next().value;
      if (first !== undefined) bucket.delete(first);
    }
    return true;
  }

  updateMessage(key: WAMessageKey, update: Partial<WAMessage>): void {
    if (!key.remoteJid || !key.id) return;
    const saved = this.db.prepare('SELECT from_me, participant FROM messages WHERE jid = ? AND id = ?').get(key.remoteJid, key.id) as { from_me: number | null; participant: string | null } | undefined;
    const senderKey = { ...key, fromMe: key.fromMe ?? (saved?.from_me == null ? undefined : saved.from_me === 1), participant: key.participant ?? saved?.participant };
    if (this.isBlockedMessage({ ...update, key: senderKey } as WAMessage, true)) return;
    // Unknown group updates without a sender cannot safely establish a tombstone.
    if (!saved && key.remoteJid.endsWith('@g.us') && !key.participant) return;
    if (update.messageStubType === WAMessageStubType.REVOKE) {
      this.markDeletedForEveryone(key.remoteJid, key.id);
      return;
    }
    const bucket = this.messagesByChat.get(key.remoteJid);
    const existing = bucket?.get(key.id);
    if (existing && bucket) {
      // A protocol update may carry its own key; the event key names the target.
      const { key: _protocolKey, ...safeUpdate } = update;
      this.upsertMessage({ ...existing, ...safeUpdate, key: existing.key });
    }
  }

  /** In-memory Baileys message, if this process has not evicted it yet. */
  getCachedMessage(jid: string, id: string): WAMessage | undefined {
    return this.messagesByChat.get(jid)?.get(id);
  }

  /**
   * Media saved at ingestion. The key stays after the in-memory cache drops the message.
   * Returns null when the chat has no row with this id.
   */
  getStoredMedia(jid: string, id: string): {
    fromMe: boolean | null;
    participant: string | null;
    deletedForEveryone: boolean;
    deleteRequested: boolean;
    text: string | null;
    media: PreparedMedia | null;
  } | null {
    const row = this.db.prepare(`
      SELECT from_me AS fromMe, participant, text,
        delete_requested AS deleteRequested, deleted_for_everyone AS deletedForEveryone,
        media_kind AS mediaKind, media_mimetype AS mediaMimetype, media_filename AS mediaFilename,
        media_size AS mediaSize, media_key AS mediaKey, media_direct_path AS mediaDirectPath, media_url AS mediaUrl
      FROM messages WHERE jid = ? AND id = ?
    `).get(jid, id) as {
      fromMe: number | null; participant: string | null; text: string | null;
      deleteRequested: number; deletedForEveryone: number;
      mediaKind: string | null; mediaMimetype: string | null; mediaFilename: string | null;
      mediaSize: number | null; mediaKey: Uint8Array | null; mediaDirectPath: string | null; mediaUrl: string | null;
    } | undefined;
    if (!row) return null;
    const kind = mediaKind(row.mediaKind);
    const mediaKey = row.mediaKey && row.mediaKey.byteLength > 0 ? Buffer.from(row.mediaKey) : null;
    return {
      fromMe: row.fromMe == null ? null : Boolean(row.fromMe),
      participant: row.participant,
      deletedForEveryone: Boolean(row.deletedForEveryone),
      deleteRequested: Boolean(row.deleteRequested),
      text: row.text,
      media: kind && row.mediaMimetype && row.mediaFilename ? {
        kind,
        mimetype: row.mediaMimetype,
        filename: row.mediaFilename,
        size: row.mediaSize,
        mediaKey,
        directPath: row.mediaDirectPath,
        url: row.mediaUrl,
      } : null,
    };
  }

  /** Remember a refreshed CDN location after a successful re-upload. Does not change the media key. */
  updateMediaLocation(jid: string, id: string, location: { url: string | null; directPath: string | null }): void {
    this.db.prepare(`
      UPDATE messages
      SET media_url = COALESCE(?, media_url),
          media_direct_path = COALESCE(?, media_direct_path)
      WHERE jid = ? AND id = ? AND deleted_for_everyone = 0
    `).run(location.url, location.directPath, jid, id);
    const cached = this.messagesByChat.get(jid)?.get(id);
    if (!cached?.message) return;
    const content = extractMessageContent(cached.message);
    if (!content) return;
    for (const field of ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage']) {
      const media = (content as Record<string, { url?: string | null; directPath?: string | null } | undefined>)[field];
      if (!media) continue;
      if (location.url) media.url = location.url;
      if (location.directPath) media.directPath = location.directPath;
    }
  }

  upsertChat(chat: Chat): void {
    if (!chat.id) return;
    chat = this.safeChat(chat);
    const id = chat.id!;
    const existing = this.chats.get(id);
    this.chats.set(id, existing ? { ...existing, ...chat } : chat);
    this.persistChat(this.chats.get(id)!);
  }

  updateChat(update: Partial<Chat> & { id?: string | null }): void {
    if (!update.id) return;
    update = this.safeChat(update as Chat);
    const id = update.id!;
    const existing = this.chats.get(id);
    if (existing) this.chats.set(id, { ...existing, ...update });
    else this.chats.set(id, update as Chat);
    this.persistChat(this.chats.get(id)!);
  }

  private safeChat(chat: Chat): Chat {
    // Chat snapshots can embed message bodies, even when messages.upsert was filtered.
    const messages = chat.messages ?? [];
    const accepted = messages.filter(item => !item.message || !this.isBlockedMessage(item.message as WAMessage));
    const timestamp = chat.conversationTimestamp == null ? null : Number(chat.conversationTimestamp);
    // An outbound or other participant's accepted message at this time keeps its preview.
    const acceptedAtTime = timestamp != null && this.db.prepare('SELECT 1 FROM messages WHERE jid = ? AND timestamp = ? LIMIT 1').get(chat.id!, timestamp);
    const blockedTimestamp = timestamp != null && this.blockedTimestamps.get(chat.id!)?.has(timestamp);
    const blockedDm = this.webhookBlocklist.matches(chat.id ?? '', jid => this.phoneForJid(jid));
    if (accepted.length !== messages.length || (!acceptedAtTime && (blockedTimestamp || blockedDm))) {
      const existing = this.chats.get(chat.id!);
      const latest = this.db.prepare('SELECT MAX(timestamp) AS timestamp FROM messages WHERE jid = ?').get(chat.id!) as { timestamp: number | null };
      return { id: chat.id, name: chat.name ?? existing?.name,
        messages: accepted.length ? accepted : undefined,
        conversationTimestamp: latest.timestamp ?? existing?.conversationTimestamp,
        unreadCount: existing?.unreadCount } as Chat;
    }
    return chat;
  }

  deleteChats(jids: string[]): void {
    for (const jid of jids) {
      this.chats.delete(jid);
      this.messagesByChat.delete(jid);
      this.blockedTimestamps.delete(jid);
      this.db.prepare('DELETE FROM chats WHERE id = ?').run(jid);
      this.db.prepare('DELETE FROM messages WHERE jid = ?').run(jid);
    }
  }

  upsertContact(contact: Partial<Contact> & { id?: string | null }): void {
    const id = bareUserJid(contact.id);
    if (!id) return;
    const name = providedName(contact, 'name');
    const notify = providedName(contact, 'notify');
    const verified = providedName(contact, 'verifiedName');
    const pn = contactJid(contact.phoneNumber);
    const lid = bareUserJid(contact.lid);
    this.db.prepare(`
      INSERT INTO contacts (id, name, name_fold, notify, notify_fold, verified_name, verified_fold, pn, lid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        name = COALESCE(excluded.name, contacts.name),
        name_fold = CASE WHEN excluded.name IS NOT NULL THEN excluded.name_fold ELSE contacts.name_fold END,
        notify = COALESCE(excluded.notify, contacts.notify),
        notify_fold = CASE WHEN excluded.notify IS NOT NULL THEN excluded.notify_fold ELSE contacts.notify_fold END,
        verified_name = COALESCE(excluded.verified_name, contacts.verified_name),
        verified_fold = CASE WHEN excluded.verified_name IS NOT NULL THEN excluded.verified_fold ELSE contacts.verified_fold END,
        pn = COALESCE(excluded.pn, contacts.pn),
        lid = COALESCE(excluded.lid, contacts.lid)
    `).run(
      id,
      name, name ? foldName(name) : null,
      notify, notify ? foldName(notify) : null,
      verified, verified ? foldName(verified) : null,
      pn ?? null, lid ?? null,
    );
    if (pn) this.linkJids(id, pn);
    if (lid) this.linkJids(id, lid);
    if (pn && lid) this.linkJids(pn, lid);
    const existing = this.contacts.get(id) ?? { id };
    this.contacts.set(id, {
      ...existing,
      id,
      ...(name ? { name } : {}),
      ...(notify ? { notify } : {}),
      ...(verified ? { verifiedName: verified } : {}),
      ...(pn ? { phoneNumber: pn } : {}),
      ...(lid ? { lid } : {}),
    });
  }

  /** Remember that a phone JID and a LID refer to the same person. */
  linkJids(left: string | null | undefined, right: string | null | undefined): void {
    const a = bareUserJid(left);
    const b = bareUserJid(right);
    if (!a || !b || a === b) return;
    const stmt = this.db.prepare(`
      INSERT INTO jid_links (jid, peer) VALUES (?, ?)
      ON CONFLICT (jid) DO UPDATE SET peer = excluded.peer
    `);
    stmt.run(a, b);
    stmt.run(b, a);
  }

  listChats(limit: number): ChatSummary[] {
    const rows = this.db.prepare(`
      SELECT ids.id,
        c.unread_count AS unreadCount,
        MAX(COALESCE(c.conversation_timestamp, 0),
            COALESCE(latest.last_timestamp, 0)) AS conversationTimestamp
      FROM (SELECT id FROM chats UNION SELECT jid AS id FROM messages) ids
      LEFT JOIN chats c ON c.id = ids.id
      LEFT JOIN (SELECT jid, MAX(timestamp) AS last_timestamp FROM messages GROUP BY jid) latest
        ON latest.jid = ids.id
      ORDER BY conversationTimestamp DESC, ids.id
      LIMIT ?
    `).all(Math.max(1, Math.min(limit, 200))) as Array<{
      id: string; unreadCount: number | null; conversationTimestamp: number | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: this.displayName(row.id),
      unreadCount: row.unreadCount ?? undefined,
      conversationTimestamp: row.conversationTimestamp ?? undefined,
    }));
  }

  chatTitle(jid: string): string {
    return this.displayName(jid) ?? '';
  }

  overviewCounts(): { chats: number; messages: number } {
    const chats = this.db.prepare(`
      SELECT COUNT(*) AS n FROM (SELECT id FROM chats UNION SELECT jid AS id FROM messages)
    `).get() as { n: number };
    const messages = this.db.prepare(`
      SELECT COUNT(*) AS n FROM messages WHERE deleted_for_everyone = 0
    `).get() as { n: number };
    return { chats: chats.n, messages: messages.n };
  }

  /** Newest saved messages across chats. Text is truncated. Revoked rows are skipped. */
  recentActivity(limit: number): Array<{
    jid: string;
    name?: string;
    id: string;
    timestamp: number | null;
    fromMe: boolean | null;
    snippet: string;
  }> {
    const pageSize = Math.max(1, Math.min(limit, 50));
    const rows = this.db.prepare(`
      SELECT jid, id, timestamp, from_me AS fromMe, text
      FROM messages
      WHERE deleted_for_everyone = 0 AND delete_requested = 0 AND text IS NOT NULL
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(pageSize) as Array<{ jid: string; id: string; timestamp: number | null; fromMe: number | null; text: string }>;
    return rows.map((row) => ({
      jid: row.jid,
      name: this.displayName(row.jid),
      id: row.id,
      timestamp: row.timestamp,
      fromMe: row.fromMe == null ? null : Boolean(row.fromMe),
      snippet: row.text.length > 140 ? `${row.text.slice(0, 140)}…` : row.text,
    }));
  }

  /** Message counts per chat and UTC day over a recent window. No message text. */
  messageStats(days = 14): Array<{ jid: string; name?: string; total: number; days: Array<{ date: string; messages: number }> }> {
    const span = Math.max(1, Math.min(days, 31));
    const since = Math.floor(Date.now() / 1000) - span * 86400;
    const rows = this.db.prepare(`
      SELECT jid, date(timestamp, 'unixepoch') AS day, COUNT(*) AS messages
      FROM messages
      WHERE timestamp IS NOT NULL AND timestamp >= ? AND deleted_for_everyone = 0
      GROUP BY jid, day
      ORDER BY day DESC, messages DESC, jid
      LIMIT 400
    `).all(since) as Array<{ jid: string; day: string; messages: number }>;
    const grouped = new Map<string, { jid: string; name?: string; total: number; days: Array<{ date: string; messages: number }> }>();
    for (const row of rows) {
      let item = grouped.get(row.jid);
      if (!item) {
        item = { jid: row.jid, name: this.displayName(row.jid), total: 0, days: [] };
        grouped.set(row.jid, item);
      }
      item.total += row.messages;
      item.days.push({ date: row.day, messages: row.messages });
    }
    return [...grouped.values()];
  }

  /** Keep a short, redacted record of recent MCP calls. The summary is stored as given. */
  recordMcpCall(entry: { at: number; tool: string; action: string | null; argsSummary: string; durationMs: number; ok: boolean }): void {
    this.db.prepare(`
      INSERT INTO mcp_requests (at, tool, action, args_summary, duration_ms, ok)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      entry.at,
      entry.tool.slice(0, 80),
      entry.action ? entry.action.slice(0, 80) : null,
      entry.argsSummary.slice(0, 240),
      Math.max(0, Math.min(Math.round(entry.durationMs), 600_000)),
      entry.ok ? 1 : 0,
    );
    this.db.prepare(`
      DELETE FROM mcp_requests
      WHERE id <= COALESCE((SELECT id FROM mcp_requests ORDER BY id DESC LIMIT 1 OFFSET 200), -1)
    `).run();
  }

  listMcpCalls(limit: number): Array<{
    at: number;
    tool: string;
    action: string | null;
    argsSummary: string;
    durationMs: number;
    ok: boolean;
  }> {
    const rows = this.db.prepare(`
      SELECT at, tool, action, args_summary AS argsSummary, duration_ms AS durationMs, ok
      FROM mcp_requests
      ORDER BY at DESC, id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(limit, 100))) as Array<{
      at: number; tool: string; action: string | null; argsSummary: string; durationMs: number; ok: number;
    }>;
    return rows.map((row) => ({ ...row, ok: row.ok === 1 }));
  }

  listMessages(jid: string, limit: number, offset = 0): { name?: string; messages: Array<{
    id?: string | null;
    fromMe?: boolean | null;
    timestamp?: number | null;
    pushName?: string | null;
    name?: string;
    text?: string;
    hasMedia: boolean;
    filename?: string;
    mimetype?: string;
    deleteRequested?: boolean;
    deletedForEveryone?: boolean;
    remoteJid?: string | null;
  }>; nextOffset?: number } {
    const pageSize = Math.max(1, Math.min(limit, 200));
    const rows = this.db.prepare(`
      SELECT id, from_me AS fromMe, participant, timestamp, push_name AS pushName, text,
        delete_requested AS deleteRequested, deleted_for_everyone AS deletedForEveryone,
        media_kind AS mediaKind, media_filename AS mediaFilename, media_mimetype AS mediaMimetype
      FROM messages WHERE jid = ?
      ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?
    `).all(jid, pageSize + 1, offset) as Array<{
      id: string; fromMe: number | null; participant: string | null; timestamp: number | null;
      pushName: string | null; text: string | null; deleteRequested: number; deletedForEveryone: number;
      mediaKind: string | null; mediaFilename: string | null; mediaMimetype: string | null;
    }>;
    const hasMore = rows.length > pageSize;
    const names = new Map<string, string | undefined>();
    const senderName = (participant: string | null): string | undefined => {
      const sender = bareUserJid(participant) ?? (groupish(jid) ? undefined : jid);
      if (!sender) return undefined;
      const cached = names.get(sender);
      if (cached !== undefined || names.has(sender)) return cached;
      const resolved = this.identityName(sender);
      names.set(sender, resolved);
      return resolved;
    };
    const messages = rows.slice(0, pageSize).reverse().map((row) => {
      const name = row.fromMe === 1 ? undefined : (senderName(row.participant) ?? clean(row.pushName));
      return {
        id: row.id,
        fromMe: row.fromMe == null ? null : Boolean(row.fromMe),
        timestamp: row.timestamp,
        pushName: row.pushName,
        ...(name ? { name } : {}),
        remoteJid: jid,
        text: row.deletedForEveryone ? '[deleted for everyone]' : row.deleteRequested ? '[delete requested]' : row.text ?? undefined,
        ...publicMedia(row),
        deleteRequested: Boolean(row.deleteRequested),
        deletedForEveryone: Boolean(row.deletedForEveryone),
      };
    });
    const chatName = this.displayName(jid);
    return { ...(chatName ? { name: chatName } : {}), messages, ...(hasMore ? { nextOffset: offset + pageSize } : {}) };
  }

  /** Case-insensitive substring search over saved contact names. One row per person. */
  findContacts(query: string, limit: number, offset: number): { contacts: Array<{ jid: string; name: string }>; nextOffset?: number } {
    const trimmed = query.trim();
    if (trimmed.length < 1 || trimmed.length > 80) throw new Error('query must be 1 to 80 characters.');
    const pageSize = Math.max(1, Math.min(limit, 50));
    const start = Math.max(0, offset);
    const like = likeContains(trimmed);
    const rows = this.db.prepare(`
      SELECT self.id AS id, links.peer AS peer
      FROM contacts self
      LEFT JOIN jid_links links ON links.jid = self.id
      WHERE self.name_fold LIKE ? ESCAPE '\\'
         OR self.notify_fold LIKE ? ESCAPE '\\'
         OR self.verified_fold LIKE ? ESCAPE '\\'
         OR self.push_fold LIKE ? ESCAPE '\\'
      ORDER BY COALESCE(self.name_fold, self.notify_fold, self.verified_fold, self.push_fold), self.id
      LIMIT 500
    `).all(like, like, like, like) as Array<{ id: string; peer: string | null }>;
    const seen = new Set<string>();
    const contacts: Array<{ jid: string; name: string }> = [];
    for (const row of rows) {
      const peer = row.peer && row.peer !== row.id ? row.peer : null;
      const key = peer && peer < row.id ? `${peer}\n${row.id}` : `${row.id}\n${peer ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const jid = this.preferredChatJid(row.id, peer);
      const name = this.identityName(jid) ?? (peer ? this.identityName(peer) : undefined) ?? this.identityName(row.id);
      if (!name) continue;
      contacts.push({ jid, name });
    }
    contacts.sort((a, b) => a.name.localeCompare(b.name) || (a.jid < b.jid ? -1 : a.jid > b.jid ? 1 : 0));
    const page = contacts.slice(start, start + pageSize);
    return { contacts: page, ...(start + pageSize < contacts.length ? { nextOffset: start + pageSize } : {}) };
  }

  /** Newest-first search over saved text. Skips revoked and delete-requested rows so hidden text is not returned. */
  searchMessages(query: string, options: {
    chat?: string;
    since?: number;
    until?: number;
    limit: number;
    offset: number;
  }): { messages: Array<{
    jid: string;
    id: string;
    timestamp: number | null;
    fromMe: boolean | null;
    snippet: string;
    hasMedia: boolean;
    filename?: string;
    mimetype?: string;
  }>; nextOffset?: number } {
    const pageSize = Math.max(1, Math.min(options.limit, 50));
    const offset = Math.max(0, options.offset);
    const like = likeContains(query);
    const rows = this.db.prepare(`
      SELECT jid, id, timestamp, from_me AS fromMe, text,
        media_kind AS mediaKind, media_filename AS mediaFilename, media_mimetype AS mediaMimetype
      FROM messages
      WHERE deleted_for_everyone = 0
        AND delete_requested = 0
        AND (
          (text IS NOT NULL AND lower(text) LIKE ? ESCAPE '\\')
          OR (media_filename IS NOT NULL AND lower(media_filename) LIKE ? ESCAPE '\\')
        )
        AND (? IS NULL OR jid = ?)
        AND (? IS NULL OR (timestamp IS NOT NULL AND timestamp >= ?))
        AND (? IS NULL OR (timestamp IS NOT NULL AND timestamp <= ?))
      ORDER BY timestamp DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(
      like, like,
      options.chat ?? null, options.chat ?? null,
      options.since ?? null, options.since ?? null,
      options.until ?? null, options.until ?? null,
      pageSize + 1, offset,
    ) as Array<{
      jid: string; id: string; timestamp: number | null; fromMe: number | null; text: string | null;
      mediaKind: string | null; mediaFilename: string | null; mediaMimetype: string | null;
    }>;
    const hasMore = rows.length > pageSize;
    const needle = query.trim().toLowerCase();
    const messages = rows.slice(0, pageSize).map((row) => {
      const textHit = row.text != null && row.text.toLowerCase().includes(needle);
      const snippet = textHit && row.text
        ? snippetAround(row.text, query)
        : row.mediaFilename
          ? snippetAround(row.mediaFilename, query)
          : snippetAround(row.text ?? '', query);
      return {
        jid: row.jid,
        id: row.id,
        timestamp: row.timestamp,
        fromMe: row.fromMe == null ? null : row.fromMe === 1,
        snippet,
        ...publicMedia(row),
      };
    });
    return { messages, ...(hasMore ? { nextOffset: offset + pageSize } : {}) };
  }

  /**
   * Per-group message and distinct-sender counts. The sender expression is used only
   * inside COUNT(DISTINCT ...) and is never selected.
   */
  groupActivity(options: { group?: string; since: number; until: number }): {
    groups: Array<{ jid: string; messages: number; activeSenders: number; days: Array<{ date: string; messages: number; activeSenders: number }> }>;
    truncated: boolean;
  } {
    if (options.until < options.since) throw new Error('since must be less than or equal to until.');
    if (options.until - options.since > 92 * 24 * 60 * 60) throw new Error('Date range must be 92 days or less.');
    const sender = `CASE
      WHEN from_me = 1 THEN 'me'
      WHEN participant IS NOT NULL AND participant != '' THEN participant
      ELSE 'unknown'
    END`;
    const where = `
      jid LIKE '%@g.us'
      AND deleted_for_everyone = 0
      AND timestamp IS NOT NULL
      AND timestamp >= ?
      AND timestamp <= ?
      AND (? IS NULL OR jid = ?)
    `;
    const params = [options.since, options.until, options.group ?? null, options.group ?? null];
    const totals = this.db.prepare(`
      SELECT jid, COUNT(*) AS messages, COUNT(DISTINCT ${sender}) AS activeSenders
      FROM messages
      WHERE ${where}
      GROUP BY jid
      ORDER BY messages DESC, jid
      LIMIT ?
    `).all(...params, options.group ? 1 : 101) as Array<{ jid: string; messages: number; activeSenders: number }>;
    const truncated = !options.group && totals.length > 100;
    const selected = truncated ? totals.slice(0, 100) : totals;
    const daily = this.db.prepare(`
      SELECT jid, strftime('%Y-%m-%d', timestamp, 'unixepoch') AS day,
        COUNT(*) AS messages, COUNT(DISTINCT ${sender}) AS activeSenders
      FROM messages
      WHERE ${where}
      GROUP BY jid, day
    `).all(...params) as Array<{ jid: string; day: string; messages: number; activeSenders: number }>;
    const days = utcDays(options.since, options.until);
    const groups = (options.group && selected.length === 0
      ? [{ jid: options.group, messages: 0, activeSenders: 0 }]
      : selected
    ).map((group) => {
      const byDay = new Map(daily.filter((row) => row.jid === group.jid).map((row) => [row.day, row]));
      return {
        jid: group.jid,
        messages: group.messages,
        activeSenders: group.activeSenders,
        days: days.map((date) => ({
          date,
          messages: byDay.get(date)?.messages ?? 0,
          activeSenders: byDay.get(date)?.activeSenders ?? 0,
        })),
      };
    });
    return { groups, truncated };
  }

  /** Messages that @-mention this account or reply to one of its messages. Sender ids are not returned. */
  listMentions(account: { id?: string; lid?: string; phoneNumber?: string }, options: {
    since: number;
    chat?: string;
    limit: number;
    offset: number;
  }): { messages: Array<{ jid: string; id: string; timestamp: number | null; snippet: string; reason: 'mention' | 'reply' | 'both' }>; nextOffset?: number } {
    const identity = accountJids(account);
    if (identity.length === 0) throw new Error('Paired account is not known yet.');
    const pageSize = Math.max(1, Math.min(options.limit, 50));
    const offset = Math.max(0, options.offset);
    const mentionMatch = identity.map(() => `instr(COALESCE(mentions, ''), ?) > 0`).join(' OR ');
    const replyMatch = `reply_participant IN (${identity.map(() => '?').join(', ')})`;
    const replyToOwn = `reply_to IS NOT NULL AND EXISTS (
      SELECT 1 FROM messages quoted
      WHERE quoted.jid = messages.jid AND quoted.id = messages.reply_to AND quoted.from_me = 1
    )`;
    const rows = this.db.prepare(`
      SELECT jid, id, timestamp, text, mentions, reply_participant,
        CASE WHEN ${replyToOwn} THEN 1 ELSE 0 END AS replyToOwn
      FROM messages
      WHERE deleted_for_everyone = 0
        AND delete_requested = 0
        AND timestamp IS NOT NULL
        AND timestamp >= ?
        AND (? IS NULL OR jid = ?)
        AND (${mentionMatch} OR ${replyMatch} OR (${replyToOwn}))
      ORDER BY timestamp DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(
      options.since,
      options.chat ?? null, options.chat ?? null,
      ...identity.map((jid) => `|${jid}|`),
      ...identity,
      pageSize + 1, offset,
    ) as Array<{ jid: string; id: string; timestamp: number | null; text: string | null; mentions: string | null; reply_participant: string | null; replyToOwn: number }>;
    const hasMore = rows.length > pageSize;
    const messages = rows.slice(0, pageSize).flatMap((row) => {
      const mentioned = identity.some((jid) => (row.mentions ?? '').includes(`|${jid}|`));
      const replied = row.replyToOwn === 1 || (row.reply_participant != null && identity.includes(row.reply_participant));
      if (!mentioned && !replied) return [];
      const reason = mentioned && replied ? 'both' as const : mentioned ? 'mention' as const : 'reply' as const;
      return [{
        jid: row.jid,
        id: row.id,
        timestamp: row.timestamp,
        snippet: row.text ? snippetAround(row.text, '') : '',
        reason,
      }];
    });
    return { messages, ...(hasMore ? { nextOffset: offset + pageSize } : {}) };
  }

  /**
   * Save a draft. `sendAt` is reminder metadata only: nothing in this store
   * reads it to send, and opening the database does not scan drafts.
   */
  createDraft(input: { jid: string; text: string; sendAt?: number | null }): DraftRecord {
    const jid = input.jid.trim();
    const text = input.text;
    if (!jid || jid.length > 128 || !jid.includes('@')) throw new Error('chat must be a chat JID.');
    if (!text || text.length > 4096) throw new Error('Draft text must be 1 to 4096 characters.');
    const sendAt = input.sendAt ?? null;
    if (sendAt != null && (!Number.isInteger(sendAt) || sendAt < 1_000_000_000 || sendAt > 4_000_000_000)) {
      throw new Error('sendAt must be a unix timestamp.');
    }
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number };
    if (Number(count.n) >= 100) throw new Error('Too many drafts. Cancel one before creating another.');
    const id = randomBytes(16).toString('hex');
    const createdAt = Math.floor(Date.now() / 1000);
    this.db.prepare('INSERT INTO drafts (id, jid, text, send_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id, jid, text, sendAt, createdAt,
    );
    return { id, jid, text, sendAt, createdAt };
  }

  listDrafts(limit = 20, offset = 0): { drafts: DraftRecord[]; nextOffset?: number } {
    const pageSize = Math.min(Math.max(limit, 1), 50);
    const start = Math.max(offset, 0);
    const rows = this.db.prepare(`
      SELECT id, jid, text, send_at AS sendAt, created_at AS createdAt
      FROM drafts
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(pageSize + 1, start) as DraftRow[];
    const hasMore = rows.length > pageSize;
    return {
      drafts: rows.slice(0, pageSize).map(draftFromRow),
      ...(hasMore ? { nextOffset: start + pageSize } : {}),
    };
  }

  /** Drop a draft that is not currently being sent. The row, including its text, is deleted. */
  cancelDraft(id: string): 'cancelled' | 'missing' | 'sending' {
    if (!draftId(id)) return 'missing';
    if (this.draftSends.has(id)) return 'sending';
    const result = this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id);
    return Number(result.changes) > 0 ? 'cancelled' : 'missing';
  }

  /**
   * Mark one draft as being sent by an explicit caller. A second caller in this
   * process gets `sending`. Restarting the process clears the mark and does not send.
   */
  beginDraftSend(id: string): DraftRecord | 'missing' | 'sending' {
    if (!draftId(id)) return 'missing';
    if (this.draftSends.has(id)) return 'sending';
    const row = this.db.prepare(`
      SELECT id, jid, text, send_at AS sendAt, created_at AS createdAt FROM drafts WHERE id = ?
    `).get(id) as DraftRow | undefined;
    if (!row) return 'missing';
    this.draftSends.add(id);
    return draftFromRow(row);
  }

  /** Release the in-process send mark. `sent` deletes the draft after WhatsApp has accepted it. */
  finishDraftSend(id: string, sent: boolean): void {
    this.draftSends.delete(id);
    if (sent && draftId(id)) this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id);
  }

  private captureIdentity(msg: WAMessage): void {
    const senders = messageSenderJids(msg);
    if (senders.length >= 2) this.linkJids(senders[0], senders[1]);
    if (msg.key.fromMe) return;
    const push = storedName(msg.pushName);
    if (!push) return;
    for (const sender of senders) this.rememberPushName(sender, push);
  }

  private rememberPushName(jid: string, push: string): void {
    this.db.prepare(`
      INSERT INTO contacts (id, push_name, push_fold) VALUES (?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        push_name = excluded.push_name,
        push_fold = excluded.push_fold
    `).run(jid, push, foldName(push));
  }

  private contactFields(jid: string): NameFields {
    return this.db.prepare(`
      SELECT
        self.name AS self_name,
        self.notify AS self_notify,
        self.verified_name AS self_verified,
        self.push_name AS self_push,
        peer.name AS peer_name,
        peer.notify AS peer_notify,
        peer.verified_name AS peer_verified,
        peer.push_name AS peer_push,
        chats.name AS chat_name
      FROM (SELECT ? AS id) target
      LEFT JOIN contacts self ON self.id = target.id
      LEFT JOIN jid_links links ON links.jid = target.id
      LEFT JOIN contacts peer ON peer.id = links.peer
      LEFT JOIN chats ON chats.id = target.id
    `).get(jid) as NameFields;
  }

  /** Saved name, then notify, verified name, push name, then a chat title that is not a phone number. */
  private identityName(jid: string): string | undefined {
    return pickIdentity(this.contactFields(jid));
  }

  private displayName(jid: string): string | undefined {
    const fields = this.contactFields(jid);
    const identity = pickIdentity(fields);
    const chat = clean(fields.chat_name);
    if (groupish(jid)) return chat || identity;
    return identity || chat;
  }

  private preferredChatJid(id: string, peer: string | null): string {
    const ids = peer ? [id, peer] : [id];
    const marks = ids.map(() => '?').join(', ');
    const row = this.db.prepare(`
      SELECT id FROM (
        SELECT id AS id, COALESCE(conversation_timestamp, 0) AS ts FROM chats WHERE id IN (${marks})
        UNION ALL
        SELECT jid AS id, COALESCE(MAX(timestamp), 0) AS ts FROM messages WHERE jid IN (${marks}) GROUP BY jid
      )
      ORDER BY ts DESC, id
      LIMIT 1
    `).get(...ids, ...ids) as { id: string } | undefined;
    if (row?.id) return row.id;
    return ids.find((jid) => jid.endsWith('@s.whatsapp.net')) ?? id;
  }

  /** Digits for a phone JID, a LID linked in jid_links, or a contact pn. Empty when unknown. */
  phoneForJid(jid: string): string {
    const start = bareUserJid(jid);
    if (!start) return '';
    if (start.endsWith('@s.whatsapp.net')) {
      const user = start.split('@')[0] ?? '';
      return /^\d{8,15}$/.test(user) ? user : '';
    }
    let current = start;
    const seen = new Set<string>();
    for (let hop = 0; hop < 4 && current && !seen.has(current); hop += 1) {
      seen.add(current);
      const row = this.db.prepare('SELECT peer FROM jid_links WHERE jid = ?').get(current) as { peer: string } | undefined;
      const peer = bareUserJid(row?.peer);
      if (!peer) break;
      if (peer.endsWith('@s.whatsapp.net')) {
        const user = peer.split('@')[0] ?? '';
        if (/^\d{8,15}$/.test(user)) return user;
      }
      current = peer;
    }
    const contact = this.db.prepare(`
      SELECT pn FROM contacts WHERE id = ? OR lid = ? OR pn = ? LIMIT 1
    `).get(start, start, start) as { pn: string | null } | undefined;
    const pn = bareUserJid(contact?.pn);
    if (pn?.endsWith('@s.whatsapp.net')) {
      const user = pn.split('@')[0] ?? '';
      if (/^\d{8,15}$/.test(user)) return user;
    }
    return '';
  }

  /** True when this jid or phone has an inbound (from_me = 0) row, including a linked peer. */
  heardFrom(jid: string, phone = ''): boolean {
    const ids = new Set<string>();
    const add = (value: string | null | undefined) => {
      const bare = bareUserJid(value);
      if (bare) ids.add(bare);
    };
    add(jid);
    if (/^\d{8,15}$/.test(phone)) add(`${phone}@s.whatsapp.net`);
    for (const id of [...ids]) {
      const row = this.db.prepare('SELECT peer FROM jid_links WHERE jid = ?').get(id) as { peer: string } | undefined;
      add(row?.peer);
    }
    if (ids.size === 0) return false;
    const list = [...ids];
    const marks = list.map(() => '?').join(', ');
    const row = this.db.prepare(`
      SELECT 1 AS ok FROM messages
      WHERE from_me = 0 AND deleted_for_everyone = 0
        AND (jid IN (${marks}) OR participant IN (${marks}))
      LIMIT 1
    `).get(...list, ...list) as { ok: number } | undefined;
    return Boolean(row);
  }

  /**
   * True when this phone JID is already a chat, a saved message, a contact,
   * or linked to a LID. Those do not need another onWhatsApp lookup.
   */
  knownPhoneJid(jid: string): boolean {
    const id = bareUserJid(jid);
    if (!id?.endsWith('@s.whatsapp.net')) return false;
    const user = id.split('@')[0] ?? '';
    if (!/^\d{8,15}$/.test(user)) return false;
    const row = this.db.prepare(`
      SELECT 1 AS ok FROM chats WHERE id = ?
      UNION ALL
      SELECT 1 FROM messages WHERE jid = ?
      UNION ALL
      SELECT 1 FROM contacts WHERE id = ? OR pn = ?
      LIMIT 1
    `).get(id, id, id, id) as { ok: number } | undefined;
    if (row) return true;
    const link = this.db.prepare('SELECT peer FROM jid_links WHERE jid = ?').get(id) as { peer: string } | undefined;
    return Boolean(link?.peer?.toLowerCase().endsWith('@lid'));
  }

  /** True when this group has a saved chat or any saved message. */
  knownGroup(jid: string): boolean {
    if (!jid.endsWith('@g.us')) return false;
    const chat = this.db.prepare('SELECT 1 AS ok FROM chats WHERE id = ? LIMIT 1').get(jid) as { ok: number } | undefined;
    if (chat) return true;
    const message = this.db.prepare('SELECT 1 AS ok FROM messages WHERE jid = ? LIMIT 1').get(jid) as { ok: number } | undefined;
    return Boolean(message);
  }

  /** Up to `limit` saved messages in this chat, oldest first, excluding one id. */
  recentChatContext(jid: string, limit: number, excludeId = ''): Array<{
    id: string;
    fromMe: boolean;
    participant: string;
    text: string;
    timestamp: number | null;
  }> {
    const page = Math.max(1, Math.min(limit, 50));
    const rows = this.db.prepare(`
      SELECT id, from_me AS fromMe, participant, timestamp, text
      FROM messages
      WHERE jid = ? AND deleted_for_everyone = 0 AND id != ?
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(jid, excludeId, page) as Array<{
      id: string; fromMe: number | null; participant: string | null; timestamp: number | null; text: string | null;
    }>;
    return rows.reverse().map((row) => ({
      id: row.id,
      fromMe: row.fromMe === 1,
      participant: row.participant ?? '',
      text: (row.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
      timestamp: row.timestamp,
    }));
  }

  private persistChat(chat: Chat): void {
    this.db.prepare(`
      INSERT INTO chats (id, name, unread_count, conversation_timestamp)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        name = COALESCE(excluded.name, chats.name),
        unread_count = COALESCE(excluded.unread_count, chats.unread_count),
        conversation_timestamp = COALESCE(excluded.conversation_timestamp, chats.conversation_timestamp)
    `).run(chat.id!, chat.name || (chat as { displayName?: string }).displayName || null,
      chat.unreadCount == null ? null : Number(chat.unreadCount),
      chat.conversationTimestamp == null ? null : Number(chat.conversationTimestamp));
  }
}

type DraftRow = { id: string; jid: string; text: string; sendAt: number | null; createdAt: number };

function draftId(id: string): boolean {
  return /^[a-f0-9]{32}$/.test(id);
}

function draftFromRow(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    jid: row.jid,
    text: row.text,
    sendAt: row.sendAt == null ? null : Number(row.sendAt),
    createdAt: Number(row.createdAt),
  };
}

type NameFields = {
  self_name: string | null;
  self_notify: string | null;
  self_verified: string | null;
  self_push: string | null;
  peer_name: string | null;
  peer_notify: string | null;
  peer_verified: string | null;
  peer_push: string | null;
  chat_name: string | null;
};

function foldName(value: string): string {
  return value.trim().toLowerCase();
}

function clean(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function storedName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 256) : null;
}

function providedName(contact: object, key: string): string | null {
  if (!Object.hasOwn(contact, key)) return null;
  return storedName((contact as Record<string, unknown>)[key]);
}

function pickIdentity(fields: NameFields): string | undefined {
  const chat = clean(fields.chat_name);
  return clean(fields.self_name) || clean(fields.peer_name)
    || clean(fields.self_notify) || clean(fields.peer_notify)
    || clean(fields.self_verified) || clean(fields.peer_verified)
    || clean(fields.self_push) || clean(fields.peer_push)
    || (chat && !looksLikeNumber(chat) ? chat : undefined);
}

function looksLikeNumber(value: string): boolean {
  return value.replace(/[\d\s+\-().•·‧∙*#]/gu, '').length === 0;
}

function groupish(jid: string): boolean {
  return jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter');
}

function contactJid(value: unknown): string | undefined {
  const bare = bareUserJid(value);
  if (bare) return bare;
  if (typeof value !== 'string' || value.includes('@')) return undefined;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 5 || digits.length > 20) return undefined;
  return `${digits}@s.whatsapp.net`;
}

function messageSenderJids(msg: WAMessage): string[] {
  const remote = msg.key.remoteJid;
  const group = typeof remote === 'string' && groupish(remote);
  const candidates = group
    ? [msg.key.participant, msg.key.participantAlt]
    : [remote, msg.key.remoteJidAlt];
  return [...new Set(candidates.map((jid) => bareUserJid(jid)).filter((jid): jid is string => Boolean(jid)))];
}

function bareUserJid(jid: unknown): string | undefined {
  if (typeof jid !== 'string') return undefined;
  const trimmed = jid.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  if (at <= 0 || trimmed.includes('@', at + 1)) return undefined;
  const server = trimmed.slice(at + 1) === 'c.us' ? 's.whatsapp.net' : trimmed.slice(at + 1);
  if (!['s.whatsapp.net', 'lid', 'hosted', 'hosted.lid'].includes(server)) return undefined;
  const user = trimmed.slice(0, at).split(':')[0]?.split('_')[0] ?? '';
  if (!/^[0-9]+$/.test(user)) return undefined;
  return `${user}@${server}`;
}

function accountJids(account: { id?: string; lid?: string; phoneNumber?: string }): string[] {
  return [...new Set([account.id, account.lid, account.phoneNumber].map((jid) => bareUserJid(jid)).filter((jid): jid is string => Boolean(jid)))].slice(0, 6);
}

function mentionMeta(message: WAMessage): { mentions: string | null; replyTo: string | null; replyParticipant: string | null } {
  const mentions = new Set<string>();
  let replyTo: string | null = null;
  let replyParticipant: string | null = null;
  const stack: unknown[] = [message.message];
  const seen = new Set<unknown>();
  while (stack.length > 0 && seen.size < 40) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const record = node as Record<string, unknown>;
    const info = record.contextInfo;
    if (info && typeof info === 'object') {
      const context = info as { mentionedJid?: unknown; stanzaId?: unknown; participant?: unknown };
      if (Array.isArray(context.mentionedJid)) {
        for (const jid of context.mentionedJid) {
          const bare = bareUserJid(jid);
          if (bare) mentions.add(bare);
        }
      }
      if (!replyTo && typeof context.stanzaId === 'string' && context.stanzaId) {
        replyTo = context.stanzaId.slice(0, 128);
        replyParticipant = bareUserJid(context.participant) ?? null;
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === 'contextInfo' || !value || typeof value !== 'object') continue;
      stack.push(value);
    }
  }
  const packed = [...mentions].sort().map((jid) => `|${jid}|`).join('');
  return { mentions: packed || null, replyTo, replyParticipant };
}

function utcDays(since: number, until: number): string[] {
  const start = Date.parse(new Date(since * 1000).toISOString().slice(0, 10) + 'T00:00:00Z');
  const end = Date.parse(new Date(until * 1000).toISOString().slice(0, 10) + 'T00:00:00Z');
  const days: string[] = [];
  for (let time = start; time <= end && days.length < 94; time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

function likeContains(query: string): string {
  return `%${query.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function snippetAround(text: string, query: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const at = flat.toLowerCase().indexOf(query.trim().toLowerCase());
  const start = at < 0 ? 0 : Math.max(0, at - 40);
  const slice = flat.slice(start, start + max);
  return `${start > 0 ? '…' : ''}${slice}${start + slice.length < flat.length ? '…' : ''}`;
}

function publicMedia(row: { mediaKind: string | null; mediaFilename: string | null; mediaMimetype: string | null }): {
  hasMedia: boolean;
  filename?: string;
  mimetype?: string;
} {
  if (!row.mediaKind) return { hasMedia: false };
  return {
    hasMedia: true,
    ...(row.mediaFilename ? { filename: row.mediaFilename } : {}),
    ...(row.mediaMimetype ? { mimetype: row.mediaMimetype } : {}),
  };
}

function mediaKind(value: string | null): PreparedMedia['kind'] | null {
  if (value === 'image' || value === 'video' || value === 'audio' || value === 'document' || value === 'sticker') return value;
  return null;
}

function extractText(m: WAMessage): string | undefined {
  const msg = extractMessageContent(m.message ?? undefined);
  if (!msg) return undefined;
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  const media = describeMedia(msg);
  if (media?.kind === 'image') return captionLabel('image', msg.imageMessage?.caption);
  if (media?.kind === 'video') return captionLabel('video', msg.videoMessage?.caption);
  if (media?.kind === 'document') {
    const caption = clean(msg.documentMessage?.caption);
    const label = caption || (msg.documentMessage?.fileName ? media.filename : undefined);
    return label ? `[document] ${label}` : '[document]';
  }
  if (media?.kind === 'audio') return msg.audioMessage?.ptt ? '[voice]' : '[audio]';
  if (media?.kind === 'sticker') return '[sticker]';
  if (msg.contactMessage) return '[contact]';
  if (msg.locationMessage) return '[location]';
  const keys = Object.keys(msg).filter((k) => k !== 'messageContextInfo');
  return keys.length ? `[${keys[0]}]` : undefined;
}

function captionLabel(kind: string, caption: string | null | undefined): string {
  const text = clean(caption);
  return text ? `[${kind}] ${text}` : `[${kind}]`;
}
