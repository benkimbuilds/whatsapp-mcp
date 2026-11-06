/** Turn one Baileys notify into the fields David needs. History upserts never reach this. */

export type Inbound = {
  id: string;
  chatJid: string;
  senderJid: string;
  fromMe: boolean;
  text: string;
  mentions: string[];
  pushName: string;
  stub: boolean;
  replyParticipant: string;
  replyToId: string;
  /** Phone JID when WhatsApp sent the chat as a LID and included the PN alongside it. */
  altJid: string;
  /** Unix milliseconds. Zero when the notify did not carry a timestamp. */
  timestampMs: number;
  /** Text of the message this one quotes, when WhatsApp included it. */
  quotedText: string;
};

type KeyLike = {
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  fromMe?: boolean | null;
  id?: string | null;
  participant?: string | null;
  participantAlt?: string | null;
};

function textOf(message: object | null | undefined): string {
  if (!message) return '';
  const fields = message as Record<string, unknown>;
  if (fields.protocolMessage || fields.reactionMessage) return '';
  if (typeof fields.conversation === 'string') return fields.conversation;
  const extended = fields.extendedTextMessage as { text?: unknown } | undefined;
  if (typeof extended?.text === 'string') return extended.text;
  const image = fields.imageMessage as { caption?: unknown } | undefined;
  if (typeof image?.caption === 'string') return image.caption;
  const video = fields.videoMessage as { caption?: unknown } | undefined;
  if (typeof video?.caption === 'string') return video.caption;
  const document = fields.documentMessage as { caption?: unknown } | undefined;
  if (typeof document?.caption === 'string') return document.caption;
  return '';
}

function walkContext(message: object | null | undefined): { mentions: string[]; replyParticipant: string; replyToId: string; quotedText: string } {
  const mentions = new Set<string>();
  let replyParticipant = '';
  let replyToId = '';
  let quotedText = '';
  const stack: unknown[] = [message];
  const seen = new Set<unknown>();
  while (stack.length > 0 && seen.size < 40) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const record = node as Record<string, unknown>;
    const info = record.contextInfo;
    if (info && typeof info === 'object') {
      const context = info as { mentionedJid?: unknown; participant?: unknown; stanzaId?: unknown; quotedMessage?: unknown };
      if (Array.isArray(context.mentionedJid)) {
        for (const jid of context.mentionedJid) {
          if (typeof jid === 'string' && jid.includes('@')) mentions.add(jid.split(':')[0]?.toLowerCase() ?? jid);
        }
      }
      if (!replyParticipant && typeof context.participant === 'string') {
        replyParticipant = context.participant.split(':')[0]?.toLowerCase() ?? '';
      }
      if (!replyToId && typeof context.stanzaId === 'string') replyToId = context.stanzaId.trim().slice(0, 128);
      if (!quotedText && context.quotedMessage && typeof context.quotedMessage === 'object') {
        quotedText = textOf(context.quotedMessage).replace(/\s+/g, ' ').trim().slice(0, 300);
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === 'contextInfo' || !value || typeof value !== 'object') continue;
      stack.push(value);
    }
  }
  return { mentions: [...mentions], replyParticipant, replyToId, quotedText };
}

function timestampMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === 'bigint') return timestampMs(Number(value));
  if (value && typeof value === 'object' && 'toNumber' in value && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    return timestampMs((value as { toNumber: () => number }).toNumber());
  }
  return 0;
}

export function parseInbound(message: unknown): Inbound | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as {
    key?: KeyLike | null;
    pushName?: string | null;
    message?: object | null;
    messageStubType?: unknown;
    messageTimestamp?: unknown;
  };
  const key = record.key ?? {};
  const chatJid = key.remoteJid?.trim() ?? '';
  if (!chatJid) return null;
  const text = textOf(record.message);
  const context = walkContext(record.message);
  const participant = key.participant?.split(':')[0]?.trim() ?? '';
  const remote = key.remoteJid?.split(':')[0]?.trim() ?? '';
  const sender = participant || remote;
  const altRaw = participant ? (key.participantAlt ?? '') : (key.remoteJidAlt ?? '');
  const altJid = altRaw.split(':')[0]?.trim() ?? '';
  const stubType = record.messageStubType;
  const stub = stubType != null && stubType !== 0 && !text.trim();
  return {
    id: key.id?.trim() ?? '',
    chatJid,
    senderJid: sender,
    altJid,
    fromMe: Boolean(key.fromMe),
    text,
    mentions: context.mentions,
    pushName: record.pushName?.trim().slice(0, 80) ?? '',
    stub,
    replyParticipant: context.replyParticipant,
    replyToId: context.replyToId,
    timestampMs: timestampMs(record.messageTimestamp),
    quotedText: context.quotedText,
  };
}

export function quotedTextOf(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const record = message as { message?: object | null };
  return walkContext(record.message).quotedText;
}

export function phoneFromJid(jid: string): string {
  const lower = jid.toLowerCase();
  if (!lower.endsWith('@s.whatsapp.net') && !lower.endsWith('@c.us')) return '';
  const user = lower.split('@')[0]?.split(':')[0] ?? '';
  return /^\d{8,15}$/.test(user) ? user : '';
}

/** Strip the device suffix; keep the WhatsApp server (lid, s.whatsapp.net, …). */
function bareAccountJid(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const at = trimmed.lastIndexOf('@');
  if (at >= 0) {
    const user = (trimmed.slice(0, at).split(':')[0] ?? '').trim();
    const server = trimmed.slice(at + 1).trim();
    if (!user || !server) return null;
    return `${user}@${server}`;
  }
  const digits = trimmed.replace(/\D/g, '');
  return /^\d{8,15}$/.test(digits) ? `${digits}@s.whatsapp.net` : null;
}

function jidUser(jid: string): string {
  return jid.toLowerCase().split('@')[0]?.split(':')[0] ?? '';
}

export function accountJids(account: { id?: string; lid?: string; phoneNumber?: string }): string[] {
  const out = new Set<string>();
  for (const value of [account.id, account.lid, account.phoneNumber]) {
    if (!value) continue;
    const bare = bareAccountJid(value);
    if (bare) out.add(bare);
  }
  return [...out];
}

export function addressedToDavid(text: string, mentions: string[], accounts: string[], replyParticipant: string): boolean {
  if (/\bdavid\b/i.test(text)) return true;
  const ours = new Set(accounts.map((jid) => jid.toLowerCase()));
  const ourUsers = new Set([...ours].map(jidUser).filter(Boolean));
  // Text fallback when WhatsApp renders the mention as "@<lid-or-phone>" without a reliable JID match.
  for (const user of ourUsers) {
    if (user.length >= 8 && new RegExp(`(?:^|\\s)@${user}\\b`).test(text)) return true;
  }
  const matchesOurs = (jid: string): boolean => {
    const lower = jid.toLowerCase();
    if (!lower) return false;
    if (ours.has(lower)) return true;
    const user = jidUser(lower);
    return Boolean(user) && ourUsers.has(user);
  };
  if (replyParticipant && matchesOurs(replyParticipant)) return true;
  return mentions.some(matchesOurs);
}

export function isIgnorableChat(jid: string): boolean {
  return jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter');
}
