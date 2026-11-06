/** Account-local inbound storage and forwarding policy. Sending is unchanged. */
import type { DatabaseSync } from 'node:sqlite';
import { parseRecipient } from './david/resolve.js';

export type BlockEntry = { jid: string; phone: string; lid: string | null; name: string; note: string; added_by: string; reason: string; added_at: string; stored_count?: number; event_count?: number };
export type BlocklistView = { entries: BlockEntry[]; skipped: number; dropped: number };
export type BlockAdd = { identifier: string; name?: string; note?: string; approved_by: string; reason: string };
function phoneKey(phone: string): string {
  return /^521\d{10}$/.test(phone) ? `52${phone.slice(3)}` : phone;
}
/** Stable, mapping-independent key for the persisted sender index. */
export function blocklistSenderKey(raw: string): string | null {
  const parsed = parseRecipient(raw);
  if (!parsed.ok || parsed.kind === 'group') return null;
  return parsed.kind === 'lid' ? parsed.lid : `${phoneKey(parsed.phone)}@s.whatsapp.net`;
}
function identity(raw: string, lookup: (jid: string) => string): { jid: string; phone: string; lid: string | null } {
  const p = parseRecipient(raw);
  if (!p.ok || p.kind === 'group') throw new Error('Use a phone number, PN JID, or LID.');
  const lid = p.kind === 'lid' ? p.lid : null;
  const phone = phoneKey(p.kind === 'pn' ? p.phone : lookup(p.lid));
  return { jid: phone ? `${phone}@s.whatsapp.net` : lid!, phone, lid };
}
export class WebhookBlocklist {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS webhook_blocklist (
      jid TEXT PRIMARY KEY, phone TEXT NOT NULL, lid TEXT, name TEXT NOT NULL,
      note TEXT NOT NULL, added_by TEXT NOT NULL, reason TEXT NOT NULL, added_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_blocklist_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
    // New installs start with an empty list. Add entries with the MCP tools or /admin/david.
  }
  private storage?: { count: (entry: BlockEntry) => { stored_count: number; event_count: number }; purge: (entry: BlockEntry) => unknown };
  configureStorage(storage: NonNullable<WebhookBlocklist['storage']>): void { this.storage = storage; }
  private entries(): BlockEntry[] {
    return this.db.prepare('SELECT * FROM webhook_blocklist ORDER BY added_at, jid').all() as BlockEntry[];
  }
  list(): BlocklistView {
    return { entries: this.entries().map(entry => ({ ...entry, ...(this.storage?.count(entry) ?? { stored_count: 0, event_count: 0 }) })),
      skipped: (this.db.prepare("SELECT value FROM webhook_blocklist_meta WHERE key = 'skipped'").get() as { value: number } | undefined)?.value ?? 0,
      dropped: (this.db.prepare("SELECT value FROM webhook_blocklist_meta WHERE key = 'dropped'").get() as { value: number } | undefined)?.value ?? 0 };
  }
  matchesEntry(row: BlockEntry, raw: string, lookup: (jid: string) => string = () => ''): boolean {
    let candidate;
    try { candidate = identity(raw, lookup); } catch { return false; }
    return !!(row.jid === candidate.jid || (candidate.lid && row.lid === candidate.lid) ||
      (candidate.phone && [row.phone, row.lid ? lookup(row.lid) : ''].some(p => p && phoneKey(p) === candidate.phone)));
  }
  matches(raw: string, lookup: (jid: string) => string = () => ''): boolean {
    return this.entries().some(row => this.matchesEntry(row, raw, lookup));
  }
  purge(identifier: string, confirmation: unknown): unknown {
    if (confirmation !== 'PURGE') throw new Error('Explicit PURGE confirmation is required.');
    const entry = this.entries().find(row => row.jid === identifier);
    if (!entry || !this.storage) throw new Error('Blocklist entry or storage unavailable.');
    return this.storage.purge(entry);
  }
  skip(raw: string, lookup?: (jid: string) => string): boolean {
    if (!this.matches(raw, lookup)) return false;
    this.db.prepare("INSERT INTO webhook_blocklist_meta VALUES ('skipped', 1) ON CONFLICT(key) DO UPDATE SET value = value + 1").run();
    return true;
  }
  /** Count ingress observations, including replays; retain the old skip total. */
  drop(raw: string, lookup?: (jid: string) => string): boolean {
    if (!this.skip(raw, lookup)) return false;
    this.db.prepare("INSERT INTO webhook_blocklist_meta VALUES ('dropped', 1) ON CONFLICT(key) DO UPDATE SET value = value + 1").run();
    return true;
  }
  add(input: BlockAdd, lookup: (jid: string) => string = () => ''): { ok: true; entry: BlockEntry } {
    for (const [key, max, required] of [['identifier',128,true], ['approved_by',80,true], ['reason',300,true], ['name',80,false], ['note',300,false]] as const) {
      const v = input?.[key];
      if ((required && (typeof v !== 'string' || !v.trim())) || (v != null && (typeof v !== 'string' || v.length > max))) throw new Error(`${key} is invalid or missing (maximum ${max}).`);
    }
    const who = identity(input.identifier, lookup);
    if (this.matches(input.identifier, lookup)) throw new Error('Already on the webhook blocklist.');
    const entry: BlockEntry = { ...who, name: input.name?.trim() ?? '', note: input.note?.trim() ?? '', added_by: input.approved_by.trim(), reason: input.reason.trim(), added_at: new Date().toISOString() };
    this.db.prepare('INSERT INTO webhook_blocklist VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(entry.jid, entry.phone, entry.lid, entry.name, entry.note, entry.added_by, entry.reason, entry.added_at);
    return { ok: true, entry };
  }
  remove(identifier: string, lookup: (jid: string) => string = () => ''): { ok: true } {
    const who = identity(identifier, lookup);
    for (const row of this.entries()) {
      if (row.jid === who.jid || (who.lid && row.lid === who.lid) || (who.phone && phoneKey(row.phone || (row.lid ? lookup(row.lid) : '')) === who.phone)) {
        this.db.prepare('DELETE FROM webhook_blocklist WHERE jid = ?').run(row.jid);
        return { ok: true };
      }
    }
    throw new Error('Not on the webhook blocklist.');
  }
}
