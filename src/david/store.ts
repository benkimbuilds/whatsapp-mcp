import { WebhookBlocklist, type BlockEntry } from '../webhook-blocklist.js';
/** David-only SQLite. Personal history is a different file and is not opened here. */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EscalationContext } from './payloads.js';
import type { Lang } from './persona.js';
import { parseRecipient } from './resolve.js';

export type EscalationRow = {
  requestId: string;
  type: string;
  status: string;
  summary: string;
  suggestedAction: string;
  chatId: string;
  requesterPhone: string;
  context: EscalationContext;
  fallbackAfterMinutes: number;
  issuedAt: string;
  dueAt: string;
  lang: Lang;
  decision: string | null;
  note: string | null;
  editedAction: string | null;
  resolvedAt: string | null;
  resolvedVia: string | null;
  secretaryPostedAt: string | null;
  timeoutPostedAt: string | null;
  ownerDmAt: string | null;
  resolvedPostedAt: string | null;
};

export type CodeRow = {
  requestId: string;
  requesterPhone: string;
  repo: string;
  ask: string;
  chatId: string;
  status: string;
  prUrl: string | null;
  summary: string | null;
  issuedAt: string;
  updatedAt: string;
  lang: Lang;
  messageId: string | null;
};

export type DeflectionRow = {
  at: string;
  chatId: string;
  requesterPhone: string;
  summary: string;
};

export type ApprovedContact = {
  jid: string;
  phone: string;
  displayName: string;
  note: string;
  addedBy: string;
  addedAt: string;
  lid: string | null;
};

type ApprovedSql = {
  jid: string;
  phone: string;
  display_name: string;
  note: string;
  added_by: string;
  added_at: string;
  lid: string | null;
};

type CodeSql = {
  request_id: string;
  requester_phone: string;
  repo: string;
  ask: string;
  chat_id: string;
  status: string;
  pr_url: string | null;
  summary: string | null;
  issued_at: string;
  updated_at: string;
  lang: string;
  message_id?: string | null;
};

export type OutboxView = {
  id: number;
  chatId: string;
  messageId: string;
  enqueuedAt: number;
  sentAt: number | null;
  type: string;
  hint: string | null;
  text: string;
};

type EscalationSql = {
  request_id: string;
  type: string;
  status: string;
  summary: string;
  suggested_action: string;
  chat_id: string;
  requester_phone: string;
  context_json: string;
  fallback_after_minutes: number;
  issued_at: string;
  due_at: string;
  lang: string;
  decision: string | null;
  note: string | null;
  edited_action: string | null;
  resolved_at: string | null;
  resolved_via: string | null;
  secretary_posted_at: string | null;
  timeout_posted_at: string | null;
  owner_dm_at: string | null;
  resolved_posted_at: string | null;
};

/** How long a saved onWhatsApp answer is reused. A later send must not ask again. */
export const WHATSAPP_LOOKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function asLang(value: string): Lang {
  return value === 'es' ? 'es' : 'en';
}

function codeFrom(row: CodeSql): CodeRow {
  return {
    requestId: row.request_id,
    requesterPhone: row.requester_phone,
    repo: row.repo,
    ask: row.ask,
    chatId: row.chat_id,
    status: row.status,
    prUrl: row.pr_url,
    summary: row.summary,
    issuedAt: row.issued_at,
    updatedAt: row.updated_at,
    lang: asLang(row.lang),
    messageId: row.message_id ?? null,
  };
}

function escalationFrom(row: EscalationSql): EscalationRow {
  let context: EscalationContext = { when: '', who: '', raw_excerpt: '' };
  try {
    const parsed = JSON.parse(row.context_json) as Partial<EscalationContext>;
    context = {
      when: typeof parsed.when === 'string' ? parsed.when : '',
      who: typeof parsed.who === 'string' ? parsed.who : '',
      raw_excerpt: typeof parsed.raw_excerpt === 'string' ? parsed.raw_excerpt : '',
    };
  } catch {
    context = { when: '', who: '', raw_excerpt: '' };
  }
  return {
    requestId: row.request_id,
    type: row.type,
    status: row.status,
    summary: row.summary,
    suggestedAction: row.suggested_action,
    chatId: row.chat_id,
    requesterPhone: row.requester_phone,
    context,
    fallbackAfterMinutes: row.fallback_after_minutes,
    issuedAt: row.issued_at,
    dueAt: row.due_at,
    lang: asLang(row.lang),
    decision: row.decision,
    note: row.note,
    editedAction: row.edited_action,
    resolvedAt: row.resolved_at,
    resolvedVia: row.resolved_via,
    secretaryPostedAt: row.secretary_posted_at,
    timeoutPostedAt: row.timeout_posted_at,
    ownerDmAt: row.owner_dm_at,
    resolvedPostedAt: row.resolved_posted_at,
  };
}

export class DavidStore {
  private readonly db: DatabaseSync;
  readonly webhookBlocklist: WebhookBlocklist;

  constructor(dbPath: string, private readonly ownerPhone: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(dbPath);
    this.webhookBlocklist = new WebhookBlocklist(this.db);
    if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS david_allowlist (
        phone TEXT NOT NULL,
        repo TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        PRIMARY KEY (phone, repo)
      );
      CREATE TABLE IF NOT EXISTS david_escalations (
        request_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        suggested_action TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        requester_phone TEXT NOT NULL,
        context_json TEXT NOT NULL,
        fallback_after_minutes INTEGER NOT NULL,
        issued_at TEXT NOT NULL,
        due_at TEXT NOT NULL,
        lang TEXT NOT NULL,
        decision TEXT,
        note TEXT,
        edited_action TEXT,
        resolved_at TEXT,
        resolved_via TEXT,
        secretary_posted_at TEXT,
        timeout_posted_at TEXT,
        owner_dm_at TEXT,
        resolved_posted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS david_escalations_open ON david_escalations (status, due_at);
      CREATE TABLE IF NOT EXISTS david_code_requests (
        request_id TEXT PRIMARY KEY,
        requester_phone TEXT NOT NULL,
        repo TEXT NOT NULL,
        ask TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        status TEXT NOT NULL,
        pr_url TEXT,
        summary TEXT,
        issued_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lang TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS david_deflections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        requester_phone TEXT NOT NULL,
        summary TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS david_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS david_chat_lang (
        chat_key TEXT PRIMARY KEY,
        lang TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS david_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL,
        sent_at INTEGER,
        UNIQUE (chat_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS david_outbox_unsent ON david_outbox (sent_at, id);
      CREATE TABLE IF NOT EXISTS david_approved_contacts (
        jid TEXT PRIMARY KEY,
        phone TEXT NOT NULL,
        display_name TEXT NOT NULL,
        note TEXT NOT NULL,
        added_by TEXT NOT NULL,
        added_at TEXT NOT NULL,
        lid TEXT
      );
      CREATE TABLE IF NOT EXISTS david_approved_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        day TEXT NOT NULL,
        action TEXT NOT NULL,
        jid TEXT NOT NULL,
        phone TEXT NOT NULL,
        actor TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS david_approved_log_day ON david_approved_log (action, day);
      CREATE TABLE IF NOT EXISTS david_whatsapp_lookup (
        phone TEXT PRIMARY KEY,
        jid TEXT NOT NULL,
        exists_on_whatsapp INTEGER NOT NULL,
        checked_at TEXT NOT NULL
      );
    `);
    const codeColumns = this.db.prepare('PRAGMA table_info(david_code_requests)').all() as Array<{ name: string }>;
    if (!codeColumns.some((column) => column.name === 'message_id')) {
      this.db.exec('ALTER TABLE david_code_requests ADD COLUMN message_id TEXT');
    }
    if (/^\d{8,15}$/.test(ownerPhone)) this.grant(ownerPhone, '*');
  }

  close(): void {
    this.db.close();
  }

  grant(phone: string, repo: string): void {
    this.db.prepare(`
      INSERT INTO david_allowlist (phone, repo, granted_at) VALUES (?, ?, ?)
      ON CONFLICT (phone, repo) DO NOTHING
    `).run(phone, repo, new Date().toISOString());
  }

  /** Owner wildcard stays. Returns how many rows were removed. */
  revoke(phone: string, repo: string | null): number {
    if (this.ownerPhone && phone === this.ownerPhone) return 0;
    const result = repo
      ? this.db.prepare('DELETE FROM david_allowlist WHERE phone = ? AND repo = ?').run(phone, repo)
      : this.db.prepare('DELETE FROM david_allowlist WHERE phone = ?').run(phone);
    return Number(result.changes ?? 0);
  }

  reposFor(phone: string): string[] {
    const rows = this.db.prepare('SELECT repo FROM david_allowlist WHERE phone = ? ORDER BY repo').all(phone) as Array<{ repo: string }>;
    const repos = rows.map((row) => row.repo);
    if (this.ownerPhone && phone === this.ownerPhone && !repos.includes('*')) repos.unshift('*');
    return repos;
  }

  canCode(phone: string, repo: string): boolean {
    const wanted = repo.toLowerCase();
    return this.reposFor(phone).some((item) => item === '*' || item.toLowerCase() === wanted);
  }

  listAllowlist(): Array<{ phone: string; repos: string[] }> {
    const rows = this.db.prepare('SELECT phone, repo FROM david_allowlist ORDER BY phone, repo').all() as Array<{ phone: string; repo: string }>;
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const list = grouped.get(row.phone) ?? [];
      list.push(row.repo);
      grouped.set(row.phone, list);
    }
    if (this.ownerPhone && !grouped.has(this.ownerPhone)) grouped.set(this.ownerPhone, ['*']);
    return [...grouped.entries()].map(([phone, repos]) => ({ phone, repos })).sort((a, b) => a.phone.localeCompare(b.phone));
  }

  createEscalation(input: {
    type: string;
    summary: string;
    suggestedAction: string;
    chatId: string;
    requesterPhone: string;
    context: EscalationContext;
    fallbackAfterMinutes: number;
    issuedAt: string;
    dueAt: string;
    lang: Lang;
  }): EscalationRow {
    const requestId = randomUUID();
    this.db.prepare(`
      INSERT INTO david_escalations (
        request_id, type, status, summary, suggested_action, chat_id, requester_phone,
        context_json, fallback_after_minutes, issued_at, due_at, lang
      ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId,
      input.type,
      input.summary,
      input.suggestedAction,
      input.chatId,
      input.requesterPhone,
      JSON.stringify(input.context),
      input.fallbackAfterMinutes,
      input.issuedAt,
      input.dueAt,
      input.lang,
    );
    return this.getEscalation(requestId)!;
  }

  getEscalation(requestId: string): EscalationRow | null {
    const row = this.db.prepare('SELECT * FROM david_escalations WHERE request_id = ?').get(requestId) as EscalationSql | undefined;
    return row ? escalationFrom(row) : null;
  }

  listEscalations(statuses: string[]): EscalationRow[] {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => '?').join(', ');
    const rows = this.db.prepare(`SELECT * FROM david_escalations WHERE status IN (${marks}) ORDER BY issued_at`).all(...statuses) as EscalationSql[];
    return rows.map(escalationFrom);
  }

  countEscalations(statuses: string[]): number {
    if (statuses.length === 0) return 0;
    const marks = statuses.map(() => '?').join(', ');
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM david_escalations WHERE status IN (${marks})`).get(...statuses) as { n: number };
    return Number(row.n);
  }

  unpostedEscalations(): EscalationRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM david_escalations
      WHERE secretary_posted_at IS NULL AND status != 'resolved'
      ORDER BY issued_at
    `).all() as EscalationSql[];
    return rows.map(escalationFrom);
  }

  dueForFallback(nowIso: string): EscalationRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM david_escalations
      WHERE status IN ('open', 'awaiting_owner') AND due_at <= ?
        AND (owner_dm_at IS NULL OR timeout_posted_at IS NULL)
      ORDER BY due_at
    `).all(nowIso) as EscalationSql[];
    return rows.map(escalationFrom);
  }

  unpostedWhatsappResolutions(): EscalationRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM david_escalations
      WHERE status = 'resolved' AND resolved_via = 'whatsapp' AND resolved_posted_at IS NULL
      ORDER BY resolved_at
    `).all() as EscalationSql[];
    return rows.map(escalationFrom);
  }

  markSecretaryPosted(requestId: string, at: string): void {
    this.db.prepare('UPDATE david_escalations SET secretary_posted_at = ? WHERE request_id = ? AND secretary_posted_at IS NULL').run(at, requestId);
  }

  markTimeoutPosted(requestId: string, at: string): void {
    this.db.prepare('UPDATE david_escalations SET timeout_posted_at = ? WHERE request_id = ? AND timeout_posted_at IS NULL').run(at, requestId);
  }

  markOwnerDm(requestId: string, at: string): void {
    this.db.prepare(`
      UPDATE david_escalations
      SET owner_dm_at = ?, status = 'awaiting_owner'
      WHERE request_id = ? AND owner_dm_at IS NULL AND status IN ('open', 'awaiting_owner')
    `).run(at, requestId);
  }

  markResolvedPosted(requestId: string, at: string): void {
    this.db.prepare('UPDATE david_escalations SET resolved_posted_at = ? WHERE request_id = ? AND resolved_posted_at IS NULL').run(at, requestId);
  }

  /** First resolve wins. A second call leaves the row unchanged and returns null. */
  resolveEscalation(requestId: string, input: {
    decision: string;
    note: string | null;
    editedAction: string | null;
    via: 'mcp' | 'whatsapp';
    at: string;
  }): EscalationRow | null {
    const result = this.db.prepare(`
      UPDATE david_escalations
      SET status = 'resolved', decision = ?, note = ?, edited_action = ?, resolved_via = ?, resolved_at = ?
      WHERE request_id = ? AND status != 'resolved'
    `).run(input.decision, input.note, input.editedAction, input.via, input.at, requestId);
    if (Number(result.changes ?? 0) < 1) return null;
    return this.getEscalation(requestId);
  }

  logDeflection(input: { at: string; chatId: string; requesterPhone: string; summary: string }): void {
    this.db.prepare('INSERT INTO david_deflections (at, chat_id, requester_phone, summary) VALUES (?, ?, ?, ?)').run(
      input.at,
      input.chatId,
      input.requesterPhone,
      input.summary.slice(0, 300),
    );
  }

  deflectionCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM david_deflections').get() as { n: number };
    return Number(row.n);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM david_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO david_settings (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  /**
   * Replace style.guide, style.strip, and style.line.* in one transaction.
   * Other settings, including quiet hours, stay.
   */
  saveStyleKeys(rows: Array<{ key: string; value: string }>): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        DELETE FROM david_settings
        WHERE key = 'style.guide' OR key = 'style.strip' OR key LIKE 'style.line.%'
      `).run();
      const insert = this.db.prepare('INSERT INTO david_settings (key, value) VALUES (?, ?)');
      for (const row of rows) insert.run(row.key, row.value);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getChatLang(key: string): Lang | null {
    const row = this.db.prepare('SELECT lang FROM david_chat_lang WHERE chat_key = ?').get(key) as { lang: string } | undefined;
    if (!row) return null;
    return row.lang === 'es' ? 'es' : row.lang === 'en' ? 'en' : null;
  }

  setChatLang(key: string, lang: Lang, at: string): void {
    this.db.prepare(`
      INSERT INTO david_chat_lang (chat_key, lang, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (chat_key) DO UPDATE SET lang = excluded.lang, updated_at = excluded.updated_at
    `).run(key, lang, at);
  }

  /** Insert once. A repeated chat and message id is ignored so a replay does not duplicate the event. */
  enqueueOutbox(input: { chatId: string; messageId: string; body: unknown; enqueuedAt: number }): boolean {
    const result = this.db.prepare(`
      INSERT INTO david_outbox (chat_id, message_id, body_json, enqueued_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (chat_id, message_id) DO NOTHING
    `).run(input.chatId, input.messageId, JSON.stringify(input.body), input.enqueuedAt);
    return Number(result.changes ?? 0) > 0;
  }

  blockedEvents(entry: BlockEntry, lookup: (jid: string) => string): number[] {
    const rows = this.db.prepare('SELECT id, body_json FROM david_outbox').all() as Array<{ id: number; body_json: string }>;
    return rows.filter(row => {
      try {
        const event = JSON.parse(row.body_json);
        return [event.sender_jid, event.sender_phone].some(jid => typeof jid === 'string' && this.webhookBlocklist.matchesEntry(entry, jid, lookup));
      } catch { return false; }
    }).map(row => row.id);
  }

  purgeBlockedEvents(entry: BlockEntry, lookup: (jid: string) => string): number {
    const ids = this.blockedEvents(entry, lookup);
    const remove = this.db.prepare('DELETE FROM david_outbox WHERE id = ?');
    for (const id of ids) remove.run(id);
    return ids.length;
  }

  oldestUnsentAt(): number | null {
    const row = this.db.prepare(`
      SELECT enqueued_at FROM david_outbox WHERE sent_at IS NULL ORDER BY id LIMIT 1
    `).get() as { enqueued_at: number } | undefined;
    return row ? Number(row.enqueued_at) : null;
  }

  unsentCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM david_outbox WHERE sent_at IS NULL').get() as { n: number };
    return Number(row.n);
  }

  unsentEvents(limit = 100): Array<{ id: number; body: unknown }> {
    const rows = this.db.prepare(`
      SELECT id, body_json FROM david_outbox WHERE sent_at IS NULL ORDER BY id LIMIT ?
    `).all(Math.max(1, Math.min(limit, 100))) as Array<{ id: number; body_json: string }>;
    return rows.map((row) => {
      try {
        return { id: Number(row.id), body: JSON.parse(row.body_json) as unknown };
      } catch {
        return { id: Number(row.id), body: null };
      }
    }).filter((row) => row.body && typeof row.body === 'object');
  }

  markOutboxSent(ids: number[], at: number): void {
    if (ids.length === 0) return;
    const marks = ids.map(() => '?').join(', ');
    this.db.prepare(`UPDATE david_outbox SET sent_at = ? WHERE id IN (${marks}) AND sent_at IS NULL`).run(at, ...ids);
  }

  createCode(input: {
    requesterPhone: string;
    repo: string;
    ask: string;
    chatId: string;
    issuedAt: string;
    lang: Lang;
    messageId?: string | null;
  }): CodeRow {
    const requestId = randomUUID();
    this.db.prepare(`
      INSERT INTO david_code_requests (
        request_id, requester_phone, repo, ask, chat_id, status, issued_at, updated_at, lang, message_id
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(
      requestId,
      input.requesterPhone,
      input.repo,
      input.ask.slice(0, 2000),
      input.chatId,
      input.issuedAt,
      input.issuedAt,
      input.lang,
      input.messageId ?? null,
    );
    return this.getCode(requestId)!;
  }

  getCode(requestId: string): CodeRow | null {
    const row = this.db.prepare('SELECT * FROM david_code_requests WHERE request_id = ?').get(requestId) as CodeSql | undefined;
    return row ? codeFrom(row) : null;
  }

  markCode(requestId: string, status: string, prUrl: string | null, summary: string | null, at: string): void {
    this.db.prepare(`
      UPDATE david_code_requests
      SET status = ?, pr_url = COALESCE(?, pr_url), summary = COALESCE(?, summary), updated_at = ?
      WHERE request_id = ?
    `).run(status, prUrl, summary, at, requestId);
  }

  countCode(statuses: string[]): number {
    if (statuses.length === 0) return 0;
    const marks = statuses.map(() => '?').join(', ');
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM david_code_requests WHERE status IN (${marks})`).get(...statuses) as { n: number };
    return Number(row.n);
  }

  /** Newest escalations, any status. Read-only. Does not change a row. */
  listRecentEscalations(limit: number): EscalationRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM david_escalations ORDER BY issued_at DESC, request_id DESC LIMIT ?
    `).all(cap(limit)) as EscalationSql[];
    return rows.map(escalationFrom);
  }

  /** Newest code-agent rows, including callback status and PR URL. */
  listRecentCodes(limit: number): CodeRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM david_code_requests ORDER BY updated_at DESC, request_id DESC LIMIT ?
    `).all(cap(limit)) as CodeSql[];
    return rows.map(codeFrom);
  }

  /**
   * Newest Secretary events, sent and waiting. The summary is type, hint, and a
   * clipped text excerpt. Prior-message context and webhook material stay out.
   */
  listRecentOutbox(limit: number): OutboxView[] {
    const rows = this.db.prepare(`
      SELECT id, chat_id, message_id, body_json, enqueued_at, sent_at
      FROM david_outbox ORDER BY id DESC LIMIT ?
    `).all(cap(limit)) as Array<{
      id: number;
      chat_id: string;
      message_id: string;
      body_json: string;
      enqueued_at: number;
      sent_at: number | null;
    }>;
    return rows.map((row) => ({
      id: Number(row.id),
      chatId: row.chat_id,
      messageId: row.message_id,
      enqueuedAt: Number(row.enqueued_at),
      sentAt: row.sent_at == null ? null : Number(row.sent_at),
      ...outboxSummary(row.body_json),
    }));
  }

  /** Newest polite deflections. Group ignores are not stored. */
  listDeflections(limit: number): DeflectionRow[] {
    return this.db.prepare(`
      SELECT at, chat_id AS chatId, requester_phone AS requesterPhone, summary
      FROM david_deflections ORDER BY id DESC LIMIT ?
    `).all(cap(limit)) as DeflectionRow[];
  }

  /** Match a stored phone JID, the digits, or the LID saved when they were added. */
  findApproved(key: string): ApprovedContact | null {
    const parsed = parseRecipient(key);
    let jid = '';
    let phone = '';
    let lid = '';
    if (parsed.ok && parsed.kind === 'pn') {
      jid = parsed.jid;
      phone = parsed.phone;
    } else if (parsed.ok && parsed.kind === 'lid') {
      lid = parsed.lid;
    } else {
      return null;
    }
    const row = this.db.prepare(`
      SELECT jid, phone, display_name, note, added_by, added_at, lid
      FROM david_approved_contacts
      WHERE jid = ? OR (? != '' AND phone = ?) OR (? != '' AND lid = ?)
      LIMIT 1
    `).get(jid, phone, phone, lid, lid) as ApprovedSql | undefined;
    return row ? approvedFrom(row) : null;
  }

  listApproved(): ApprovedContact[] {
    const rows = this.db.prepare(`
      SELECT jid, phone, display_name, note, added_by, added_at, lid
      FROM david_approved_contacts
      ORDER BY added_at, jid
    `).all() as ApprovedSql[];
    return rows.map(approvedFrom);
  }

  /** Insert the contact and an add log row. An existing phone JID is left unchanged. */
  addApproved(input: ApprovedContact & { day: string }): 'created' | 'exists' {
    if (this.findApproved(input.jid)) return 'exists';
    this.db.exec('BEGIN');
    try {
      const inserted = this.db.prepare(`
        INSERT INTO david_approved_contacts (jid, phone, display_name, note, added_by, added_at, lid)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (jid) DO NOTHING
      `).run(input.jid, input.phone, input.displayName, input.note, input.addedBy, input.addedAt, input.lid);
      if (Number(inserted.changes ?? 0) < 1) {
        this.db.exec('COMMIT');
        return 'exists';
      }
      this.insertApprovedLog({
        at: input.addedAt,
        day: input.day,
        action: 'add',
        jid: input.jid,
        phone: input.phone,
        actor: input.addedBy,
        detail: input.note,
      });
      this.db.exec('COMMIT');
      return 'created';
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Delete one phone JID and log the removal. */
  removeApproved(jid: string, meta: { at: string; day: string; actor: string }): boolean {
    const row = this.findApproved(jid);
    if (!row) return false;
    this.db.exec('BEGIN');
    try {
      const deleted = this.db.prepare('DELETE FROM david_approved_contacts WHERE jid = ?').run(row.jid);
      if (Number(deleted.changes ?? 0) < 1) {
        this.db.exec('COMMIT');
        return false;
      }
      this.insertApprovedLog({
        at: meta.at,
        day: meta.day,
        action: 'remove',
        jid: row.jid,
        phone: row.phone,
        actor: meta.actor,
        detail: '',
      });
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordColdSend(input: { jid: string; phone: string; at: string; day: string }): void {
    this.insertApprovedLog({
      at: input.at,
      day: input.day,
      action: 'cold_send',
      jid: input.jid,
      phone: input.phone,
      actor: 'david',
      detail: '',
    });
  }

  countColdSends(day: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM david_approved_log WHERE action = 'cold_send' AND day = ?
    `).get(day) as { n: number };
    return Number(row.n);
  }

  listApprovedLog(limit = 50): Array<{ at: string; day: string; action: string; jid: string; phone: string; actor: string; detail: string }> {
    return this.db.prepare(`
      SELECT at, day, action, jid, phone, actor, detail
      FROM david_approved_log ORDER BY id DESC LIMIT ?
    `).all(cap(limit)) as Array<{ at: string; day: string; action: string; jid: string; phone: string; actor: string; detail: string }>;
  }

  /** A fresh onWhatsApp answer. Null when missing or older than 7 days. */
  lookupWhatsApp(phone: string, now: Date): { jid: string; exists: boolean } | null {
    if (!/^\d{8,15}$/.test(phone)) return null;
    const row = this.db.prepare(`
      SELECT jid, exists_on_whatsapp AS existsOn, checked_at AS checkedAt
      FROM david_whatsapp_lookup WHERE phone = ?
    `).get(phone) as { jid: string; existsOn: number; checkedAt: string } | undefined;
    if (!row) return null;
    const checked = Date.parse(row.checkedAt);
    if (!Number.isFinite(checked) || now.getTime() - checked >= WHATSAPP_LOOKUP_TTL_MS) return null;
    return { jid: row.jid, exists: row.existsOn === 1 };
  }

  saveWhatsAppLookup(phone: string, jid: string, exists: boolean, at: string): void {
    if (!/^\d{8,15}$/.test(phone)) return;
    this.db.prepare(`
      INSERT INTO david_whatsapp_lookup (phone, jid, exists_on_whatsapp, checked_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (phone) DO UPDATE SET
        jid = excluded.jid,
        exists_on_whatsapp = excluded.exists_on_whatsapp,
        checked_at = excluded.checked_at
    `).run(phone, jid, exists ? 1 : 0, at);
  }

  private insertApprovedLog(input: { at: string; day: string; action: string; jid: string; phone: string; actor: string; detail: string }): void {
    this.db.prepare(`
      INSERT INTO david_approved_log (at, day, action, jid, phone, actor, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.at, input.day, input.action, input.jid, input.phone, input.actor.slice(0, 80), input.detail.slice(0, 300));
  }
}

function approvedFrom(row: ApprovedSql): ApprovedContact {
  return {
    jid: row.jid,
    phone: row.phone,
    displayName: row.display_name,
    note: row.note,
    addedBy: row.added_by,
    addedAt: row.added_at,
    lid: row.lid || null,
  };
}

function cap(limit: number): number {
  return Math.max(1, Math.min(Math.floor(limit) || 1, 100));
}

function outboxSummary(bodyJson: string): { type: string; hint: string | null; text: string } {
  try {
    const body = JSON.parse(bodyJson) as Record<string, unknown>;
    const type = typeof body.type === 'string' ? body.type.slice(0, 40) : '';
    const hint = typeof body.hint === 'string' ? body.hint.slice(0, 40) : null;
    const text = typeof body.text === 'string' ? body.text.slice(0, 240) : '';
    return { type, hint, text };
  } catch {
    return { type: '', hint: null, text: '' };
  }
}
