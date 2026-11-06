/** Which WhatsApp account this process is. The role string is SESSION_ROLE, not a guess. */

export type BridgeAccount = {
  account: string;
  accountJid: string | null;
  accountPhone: string | null;
};

export type AccountSource = {
  id?: string;
  lid?: string;
  phoneNumber?: string;
  pairedJid?: string;
  pairedNumber?: string;
};

function phoneJid(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const bare = trimmed.split(':')[0]?.toLowerCase() ?? '';
  if (bare.endsWith('@s.whatsapp.net') || bare.endsWith('@c.us')) {
    const user = bare.split('@')[0] ?? '';
    return /^\d{8,15}$/.test(user) ? `${user}@s.whatsapp.net` : null;
  }
  if (trimmed.includes('@')) return null;
  const digits = trimmed.replace(/\D/g, '');
  return /^\d{8,15}$/.test(digits) ? `${digits}@s.whatsapp.net` : null;
}

function bareJid(value: string | undefined): string | null {
  if (!value) return null;
  const bare = value.trim().toLowerCase().split(':')[0] ?? '';
  return bare.includes('@') ? bare : null;
}

/** Phone JID when one is known, otherwise the paired LID or id. Phone digits only when they are a real number. */
export function bridgeAccount(role: string, source?: AccountSource | null): BridgeAccount {
  const account = role.trim() || 'default';
  const phone = phoneJid(source?.phoneNumber)
    || phoneJid(source?.pairedJid)
    || phoneJid(source?.id)
    || phoneJid(source?.pairedNumber);
  const jid = phone
    || bareJid(source?.lid)
    || bareJid(source?.id)
    || bareJid(source?.pairedJid);
  return {
    account,
    accountJid: jid,
    accountPhone: phone ? phone.split('@')[0] ?? null : null,
  };
}
