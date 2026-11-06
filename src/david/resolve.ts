/**
 * Turn a phone, a phone JID, or a LID into the phone JID David stores.
 * Groups pass through. Anything else is an error the caller can show.
 */

const PHONE = /^\d{8,15}$/;
const LID_USER = /^\d{1,24}$/;

export type ResolvedPhone = { jid: string; phone: string; lid: string | null };

export type ParsedRecipient =
  | { ok: true; kind: 'pn'; phone: string; jid: string }
  | { ok: true; kind: 'lid'; lid: string }
  | { ok: true; kind: 'group'; jid: string }
  | { ok: false; error: string };

const USE_A_PHONE = 'Use a phone number, a @s.whatsapp.net JID, or a @lid JID.';
const PHONE_LENGTH = 'Phone numbers need a country code (8 to 15 digits).';

export function parseRecipient(raw: string): ParsedRecipient {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return { ok: false, error: USE_A_PHONE };
  if (!trimmed.includes('@')) {
    const digits = trimmed.replace(/\D/g, '');
    if (!PHONE.test(digits)) return { ok: false, error: PHONE_LENGTH };
    return { ok: true, kind: 'pn', phone: digits, jid: `${digits}@s.whatsapp.net` };
  }
  const lower = trimmed.toLowerCase();
  const at = lower.indexOf('@');
  if (at <= 0 || lower.includes('@', at + 1)) return { ok: false, error: USE_A_PHONE };
  const server = lower.slice(at + 1);
  const user = lower.slice(0, at).split(':')[0] ?? '';
  if (server === 'g.us') {
    if (!/^[0-9a-z._-]{1,64}$/.test(user)) return { ok: false, error: USE_A_PHONE };
    return { ok: true, kind: 'group', jid: `${user}@g.us` };
  }
  if (server === 'lid') {
    if (!LID_USER.test(user)) return { ok: false, error: `Could not resolve ${clip(trimmed)} to a WhatsApp phone number.` };
    return { ok: true, kind: 'lid', lid: `${user}@lid` };
  }
  if (server === 's.whatsapp.net' || server === 'c.us') {
    if (!PHONE.test(user)) return { ok: false, error: PHONE_LENGTH };
    return { ok: true, kind: 'pn', phone: user, jid: `${user}@s.whatsapp.net` };
  }
  return { ok: false, error: USE_A_PHONE };
}

/** Baileys may return a phone JID, a device JID, or digits. Empty when it is not a phone. */
export function normalizePn(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = parseRecipient(value.trim());
  return parsed.ok && parsed.kind === 'pn' ? parsed.jid : null;
}

type LidMapping = { getPNForLID?: (lid: string) => Promise<string | null> };

/** David's Baileys lid-mapping store. Null when the socket has no mapping. */
export async function pnFromBaileys(sock: unknown, lid: string): Promise<string | null> {
  const mapping = (sock as { signalRepository?: { lidMapping?: LidMapping } } | null)?.signalRepository?.lidMapping;
  if (!mapping?.getPNForLID) return null;
  try {
    return normalizePn(await mapping.getPNForLID(lid));
  } catch {
    return null;
  }
}

/** Phone already saved from a lid-mapping event on this process. */
export function pnFromStore(store: { phoneForJid?: (jid: string) => string } | null | undefined, lid: string): string | null {
  try {
    const phone = store?.phoneForJid?.(lid) ?? '';
    return PHONE.test(phone) ? `${phone}@s.whatsapp.net` : null;
  } catch {
    return null;
  }
}

export function unresolvedLid(lid: string): string {
  return `Could not resolve ${clip(lid)} to a WhatsApp phone number.`;
}

function clip(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}
