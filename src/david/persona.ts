/** Persona copy. David is the owner's assistant (OWNER_NAME). He does not claim to be human, and he does not deny being a bot when asked. These functions return the built-in lines. Sends read david_settings first. */

import { renderCanned } from './style.js';

export type Lang = 'es' | 'en';

const ES_WORDS = /\b(hola|gracias|por favor|reuni[oó]n|reunirnos|agendar|agéndame|agendame|cita|mañana|manana|puedes|puede|necesito|c[oó]digo|eres|buenos|buenas|junta|quiero|d[ií]a|favor|ll[aá]mada|vernos|vemos|tiempo|libre|quedamos|quedar)\b/gi;
const EN_WORDS = /\b(hello|hi|thanks|thank you|please|meeting|meet|schedule|tomorrow|can you|need|code|are you|want|book|call|free|available)\b/gi;

function wordCount(text: string, pattern: RegExp): number {
  return text.match(new RegExp(pattern.source, 'gi'))?.length ?? 0;
}

/** English when the counts tie, so older callers keep a language. */
export function detectLanguage(text: string): Lang {
  const es = wordCount(text, ES_WORDS);
  const en = wordCount(text, EN_WORDS);
  return es > en ? 'es' : 'en';
}

/** Null when the text has no marker or the two languages tie. Does not flip a stored language. */
export function languageSignal(text: string): Lang | null {
  const es = wordCount(text, ES_WORDS);
  const en = wordCount(text, EN_WORDS);
  if (es === 0 && en === 0) return null;
  if (es === en) return null;
  return es > en ? 'es' : 'en';
}

/** Mexican numbers default to Spanish when the conversation has no language signal. */
export function defaultLanguage(phone: string): Lang {
  return phone.startsWith('52') ? 'es' : 'en';
}

/** A model reply that denies being a bot, or that claims to be human, is discarded. */
export function claimsNotAiOrIsHuman(text: string): boolean {
  return /i'?m not (a |an )?(bot|ai)|i am not (a |an )?(bot|ai)|not an ai|i'?m human|i am human|soy humano|no soy (un )?(bot|ia|robot)|no soy inteligencia/i.test(text);
}

export function aiTruth(lang: Lang): string {
  return renderCanned('ai_truth', lang, null, {});
}

export function genericAssistant(lang: Lang): string {
  return renderCanned('generic', lang, null, {});
}

export function noWelcome(lang: Lang): string {
  return renderCanned('no_welcome', lang, null, {});
}

export function meetingAck(lang: Lang): string {
  return renderCanned('meeting_ack', lang, null, {});
}

export function meetingDeflect(lang: Lang): string {
  return renderCanned('meeting_deflect', lang, null, {});
}

export function codeAck(lang: Lang, repo: string): string {
  return renderCanned('code_ack', lang, null, { repo });
}

export function codeNeedRepo(lang: Lang): string {
  return renderCanned('code_need_repo', lang, null, {});
}

export function codeDenied(lang: Lang): string {
  return renderCanned('code_denied', lang, null, {});
}

export function codeFailed(lang: Lang): string {
  return renderCanned('code_failed', lang, null, {});
}

export function codeUnavailable(lang: Lang): string {
  return renderCanned('code_unavailable', lang, null, {});
}

export function decisionReply(lang: Lang, decision: 'approve' | 'deny' | 'edit', edited: string | null): string {
  if (decision === 'approve') return renderCanned('decision_approve', lang, null, {});
  if (decision === 'deny') return renderCanned('decision_deny', lang, null, {});
  return renderCanned('decision_edit', lang, null, { change: (edited ?? '').trim() });
}

export function fallbackDm(requestId: string, summary: string, lang: Lang = 'en'): string {
  return renderCanned('fallback_dm', lang, null, { requestId, summary });
}

export function pullRequestReply(url: string, summary: string | null, lang: Lang = 'en'): string {
  const extra = summary?.replace(/\s+/g, ' ').trim().slice(0, 160) ?? '';
  if (extra) return renderCanned('pull_request', lang, null, { url, summary: extra });
  return renderCanned('pull_request_plain', lang, null, { url });
}

export function codeFailedNotice(lang: Lang): string {
  return renderCanned('code_failed_notice', lang, null, {});
}

export function ignoredCommand(lang: Lang): string {
  return renderCanned('ignored_command', lang, null, {});
}

export function inQuietHours(now: Date, window: string | null, timeZone: string): boolean {
  if (!window || window === 'off') return false;
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
  if (!match) return false;
  let hour = 0;
  let minute = 0;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    hour = Number(parts.find((part) => part.type === 'hour')?.value);
    minute = Number(parts.find((part) => part.type === 'minute')?.value);
  } catch {
    return false;
  }
  if (hour === 24) hour = 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false;
  const current = hour * 60 + minute;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (start === end) return false;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}
