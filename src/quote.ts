import type { WAMessage } from '@whiskeysockets/baileys';
import type { StoredMessage } from './store.js';

export type QuoteLookup = { getStoredMessage?: (jid: string, id: string) => StoredMessage | null };

/**
 * Builds Baileys `quoted` for a reply from the saved original, so the quote
 * shows the original text and the right sender (key.fromMe and, in a group,
 * key.participant). Returns a note instead when the original is not saved
 * here; the caller then sends without a quote rather than a broken one.
 */
export function replyQuote(store: QuoteLookup, jid: string, replyTo: string | null | undefined): { quoted?: WAMessage; quoteNote?: string } {
  if (!replyTo) return {};
  const stored = typeof store.getStoredMessage === 'function' ? store.getStoredMessage(jid, replyTo) : null;
  if (!stored) {
    return { quoteNote: `Message ${replyTo} is not saved in this chat (or was deleted), so it was sent without a quote.` };
  }
  // The send target names the chat. A PN/LID peer row still quotes the same person.
  return { quoted: { ...stored.message, key: { ...stored.message.key, remoteJid: jid } } };
}

/** One emoji grapheme (including flags, keycaps, skin tones and ZWJ sequences). */
export function isSingleEmoji(text: string): boolean {
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
  if (segments.length !== 1) return false;
  return /\p{Extended_Pictographic}|\u20E3|\p{Regional_Indicator}/u.test(text);
}
