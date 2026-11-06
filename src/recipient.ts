/**
 * Recipient guard shared by every session.
 *
 * A bare phone (digits, optionally with +, spaces, or dashes) is a direct
 * chat and nothing else. It must end up as a phone JID
 * (<digits>@s.whatsapp.net). It can never become a group, a LID, a
 * newsletter, or a broadcast. Groups need an explicit @g.us JID.
 */

const PHONE = /^\d{8,15}$/;
const PHONE_JID = /^(\d{8,15})@s\.whatsapp\.net$/;

export const PHONE_LENGTH_ERROR = 'Phone numbers need a country code (8 to 15 digits).';

/** True when `raw` names a recipient by phone number rather than by JID. */
export function isBarePhone(raw: string): boolean {
  return !raw.trim().includes('@');
}

/** Digits of a bare phone, or null when it is not 8 to 15 digits. */
export function barePhoneDigits(raw: string): string | null {
  if (!isBarePhone(raw)) return null;
  const digits = raw.trim().replace(/\D/g, '');
  return PHONE.test(digits) ? digits : null;
}

/** Phone JID for a WhatsApp lookup result, ignoring any device suffix. Null when it is not a phone JID. */
export function phoneJidFrom(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  const at = lower.indexOf('@');
  if (at <= 0) return null;
  const user = lower.slice(0, at).split(':')[0] ?? '';
  const server = lower.slice(at + 1);
  if (server !== 's.whatsapp.net' && server !== 'c.us') return null;
  return PHONE.test(user) ? `${user}@s.whatsapp.net` : null;
}

/**
 * Final check before any send or draft. When the caller passed a bare phone,
 * the resolved JID must be a phone JID. Anything else is refused rather than
 * guessed. Explicit JIDs are returned unchanged.
 */
export function assertPhoneStaysDirect(raw: string, resolved: string): string {
  if (!isBarePhone(raw)) return resolved;
  if (PHONE_JID.test(resolved)) return resolved;
  throw new Error(
    `Refusing to send: phone number ${clip(raw.trim())} resolved to ${clip(resolved)}, which is not a direct chat. `
    + 'A phone number only sends to that person. Use an explicit group@g.us JID for a group.',
  );
}

type OnWhatsApp = (jid: string) => Promise<Array<{ exists?: unknown; jid?: unknown }> | undefined>;

/**
 * Resolve the `to` of a send for sessions without David's resolver.
 * Explicit JIDs pass through. A bare phone becomes <digits>@s.whatsapp.net,
 * or the phone JID WhatsApp reports for it. A lookup that answers with
 * anything other than a phone JID is an error.
 */
export async function resolveSendJid(to: string, onWhatsApp: OnWhatsApp | null): Promise<string> {
  const trimmed = to.trim();
  if (!trimmed) throw new Error('Empty recipient');
  if (trimmed.includes('@')) return trimmed;
  const digits = barePhoneDigits(trimmed);
  if (!digits) throw new Error(PHONE_LENGTH_ERROR);
  const candidate = `${digits}@s.whatsapp.net`;
  if (!onWhatsApp) throw new Error('WhatsApp not connected');
  const results = await onWhatsApp(candidate);
  const hit = results?.[0];
  if (!hit?.exists) return candidate;
  const pn = phoneJidFrom(hit.jid);
  if (!pn) {
    throw new Error(`WhatsApp returned ${clip(String(hit.jid ?? ''))} for ${digits}, which is not a direct chat. Not sending.`);
  }
  return assertPhoneStaysDirect(trimmed, pn);
}

export type RecipientKind = 'bare_phone' | 'phone_jid' | 'lid' | 'group' | 'other';

/**
 * Classify what the caller passed, without resolving. Used in MCP call logs so
 * a group send cannot be mistaken for a bare-phone send (Oct 25 / Oct 30).
 */
export function classifyRecipient(raw: string): { kind: RecipientKind; length: number } {
  const trimmed = raw.trim();
  const length = trimmed.length;
  if (!trimmed) return { kind: 'other', length };
  if (!trimmed.includes('@')) {
    return { kind: barePhoneDigits(trimmed) ? 'bare_phone' : 'other', length };
  }
  const lower = trimmed.toLowerCase();
  const at = lower.indexOf('@');
  if (at <= 0 || lower.includes('@', at + 1)) return { kind: 'other', length };
  const server = lower.slice(at + 1);
  if (server === 'g.us') return { kind: 'group', length };
  if (server === 'lid') return { kind: 'lid', length };
  if (server === 's.whatsapp.net' || server === 'c.us') {
    return { kind: phoneJidFrom(trimmed) ? 'phone_jid' : 'other', length };
  }
  return { kind: 'other', length };
}

function clip(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}
