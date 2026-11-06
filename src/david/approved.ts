/**
 * Approved contacts let David send a first message. The row is the phone JID.
 * The daily cap counts cold sends: messages to someone on this list who has
 * never written. It does not replace the paced sender.
 */
import type { ResolvedPhone } from './resolve.js';
import type { DavidStore, ApprovedContact } from './store.js';

export const COLD_PER_DAY_KEY = 'approved.cold_per_day';
export const DEFAULT_COLD_PER_DAY = 5;
export const MAX_COLD_PER_DAY = 100;

export const COLD_CAP_ERROR = 'Cold-send limit reached for today. This approved contact has not written to this account.';

export function readColdPerDay(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === '') return DEFAULT_COLD_PER_DAY;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_COLD_PER_DAY) return DEFAULT_COLD_PER_DAY;
  return value;
}

/** YYYY-MM-DD in the given IANA zone. */
export function localDay(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  }
}

export type ApprovedAdminContact = {
  jid: string;
  phone: string;
  displayName: string;
  note: string;
  addedBy: string;
  addedAt: string;
  lid: string | null;
};

export type ApprovedAdminView = {
  coldPerDay: number;
  coldSentToday: number;
  contacts: ApprovedAdminContact[];
};

export function approvedAdminView(store: DavidStore, now: Date, timeZone: string): ApprovedAdminView {
  return {
    coldPerDay: readColdPerDay(store.getSetting(COLD_PER_DAY_KEY)),
    coldSentToday: store.countColdSends(localDay(now, timeZone)),
    contacts: store.listApproved().map(adminContact),
  };
}

export function approvedMcpView(store: DavidStore, now: Date, timeZone: string): Record<string, unknown> {
  const view = approvedAdminView(store, now, timeZone);
  return {
    ok: true,
    cold_per_day: view.coldPerDay,
    cold_sent_today: view.coldSentToday,
    contacts: view.contacts.map((contact) => ({
      jid: contact.jid,
      phone: contact.phone,
      display_name: contact.displayName,
      note: contact.note,
      added_by: contact.addedBy,
      added_at: contact.addedAt,
      lid: contact.lid,
    })),
  };
}

export async function addApprovedContact(options: {
  store: DavidStore;
  identifier: string;
  displayName: string;
  note: string;
  addedBy: string;
  now: Date;
  timeZone: string;
  resolve: (identifier: string) => Promise<{ ok: true; contact: ResolvedPhone } | { ok: false; error: string }>;
  log: (line: string) => void;
}): Promise<{ ok: true; contact: ApprovedAdminContact } | { ok: false; error: string }> {
  const displayName = options.displayName.trim();
  const note = options.note.trim();
  const addedBy = options.addedBy.trim();
  if (!options.identifier.trim() || options.identifier.trim().length > 128) {
    return { ok: false, error: 'Use a phone number, a @s.whatsapp.net JID, or a @lid JID.' };
  }
  if (displayName.length > 80) return { ok: false, error: 'display_name must be 80 characters or less.' };
  if (!note || note.length > 300) return { ok: false, error: 'A reason is required (300 characters or less).' };
  if (!addedBy || addedBy.length > 80) return { ok: false, error: 'approved_by is required (80 characters or less).' };
  const resolved = await options.resolve(options.identifier);
  if (!resolved.ok) return resolved;
  const addedAt = options.now.toISOString();
  const outcome = options.store.addApproved({
    jid: resolved.contact.jid,
    phone: resolved.contact.phone,
    displayName,
    note,
    addedBy,
    addedAt,
    lid: resolved.contact.lid,
    day: localDay(options.now, options.timeZone),
  });
  if (outcome === 'exists') return { ok: false, error: 'That contact is already approved.' };
  options.log(`approved=add jid=${resolved.contact.jid} phone=${resolved.contact.phone} by=${addedBy}`);
  const row = options.store.findApproved(resolved.contact.jid);
  return { ok: true, contact: adminContact(row ?? {
    jid: resolved.contact.jid,
    phone: resolved.contact.phone,
    displayName,
    note,
    addedBy,
    addedAt,
    lid: resolved.contact.lid,
  }) };
}

export function removeApprovedContact(options: {
  store: DavidStore;
  identifier: string;
  actor: string;
  now: Date;
  timeZone: string;
  log: (line: string) => void;
}): { ok: true; jid: string } | { ok: false; error: string } {
  const actor = options.actor.trim().slice(0, 80) || 'dashboard';
  const row = options.store.findApproved(options.identifier);
  if (!row) return { ok: false, error: 'That contact is not on the approved list.' };
  const removed = options.store.removeApproved(row.jid, {
    at: options.now.toISOString(),
    day: localDay(options.now, options.timeZone),
    actor,
  });
  if (!removed) return { ok: false, error: 'That contact is not on the approved list.' };
  options.log(`approved=remove jid=${row.jid} by=${actor}`);
  return { ok: true, jid: row.jid };
}

export function setColdCap(store: DavidStore, value: number, log: (line: string) => void): { ok: true; coldPerDay: number } | { ok: false; error: string } {
  if (!Number.isInteger(value) || value < 0 || value > MAX_COLD_PER_DAY) {
    return { ok: false, error: 'cold_per_day must be an integer from 0 to 100.' };
  }
  store.setSetting(COLD_PER_DAY_KEY, String(value));
  log(`approved=cap cold_per_day=${value}`);
  return { ok: true, coldPerDay: value };
}

function adminContact(row: ApprovedContact): ApprovedAdminContact {
  return {
    jid: row.jid,
    phone: row.phone,
    displayName: row.displayName,
    note: row.note,
    addedBy: row.addedBy,
    addedAt: row.addedAt,
    lid: row.lid,
  };
}
