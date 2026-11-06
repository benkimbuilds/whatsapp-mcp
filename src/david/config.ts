/**
 * David runs only when this process is the david session.
 * Personal and assistant stay on the existing bridge path.
 */

export type DavidConfig = {
  role: string;
  ownerPhone: string;
  aibmGroupJid: string;
  secretaryUrl: string;
  secretaryKey: string;
  sweUrl: string;
  sweKey: string;
  fallbackAfterMinutes: number;
  callbackPublicBase: string;
  callbackSecret: string;
  timezone: string;
  /** Fixed window for the Secretary batch. 0 flushes on enqueue. */
  escalationBatchMs: number;
  /** When true, every group message is an event. Default false: only messages that address David. */
  groupAll: boolean;
  contextMessages: number;
  typingMinMs: number;
  typingMaxMs: number;
  typingMsPerChar: number;
  chatGapMs: number;
  sendPerMinute: number;
  sendPerHour: number;
  sendMaxWaitMs: number;
};

export function isDavidMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const role = (env.SESSION_ROLE || '').trim().toLowerCase();
  if (role === 'david') return true;
  const flag = (env.DAVID_MODE || '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
}

function cleanSecret(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (!value || /[\r\n]/.test(value)) return '';
  return value;
}

/** http(s) URL with no embedded userinfo. Empty when unset or invalid. */
export function optionalHttpUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    if (parsed.username || parsed.password) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

/** Digits only, country code included. Empty when unset or not 8–15 digits. There is no default. */
function ownerPhone(raw: string | undefined): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  return /^\d{8,15}$/.test(digits) ? digits : '';
}

function fallbackMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 30;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 24 * 60) return 30;
  return value;
}

function timeZone(raw: string | undefined): string {
  const value = raw?.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch {
    return 'UTC';
  }
}

function groupJid(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  return value.endsWith('@g.us') ? value : '';
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function flag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return fallback;
}

export function loadDavidConfig(env: NodeJS.ProcessEnv = process.env): DavidConfig {
  const sweKey = cleanSecret(env.SWE_CODE_AGENT_WEBHOOK_KEY);
  const callbackSecret = cleanSecret(env.DAVID_CALLBACK_SECRET) || sweKey;
  const typingMinMs = boundedInt(env.DAVID_TYPING_MIN_MS, 2000, 0, 120_000);
  const typingMaxMs = Math.max(typingMinMs, boundedInt(env.DAVID_TYPING_MAX_MS, 12_000, 0, 120_000));
  const role = (env.SESSION_ROLE || 'david').trim() || 'david';
  return {
    role,
    ownerPhone: ownerPhone(env.OWNER_PHONE),
    aibmGroupJid: groupJid(env.AIBM_GROUP_JID),
    secretaryUrl: optionalHttpUrl(env.SECRETARY_ESCALATION_WEBHOOK_URL),
    secretaryKey: cleanSecret(env.SECRETARY_ESCALATION_WEBHOOK_KEY),
    sweUrl: optionalHttpUrl(env.SWE_CODE_AGENT_WEBHOOK_URL),
    sweKey,
    fallbackAfterMinutes: fallbackMinutes(env.FALLBACK_AFTER_MINUTES),
    callbackPublicBase: optionalHttpUrl(env.DAVID_CALLBACK_PUBLIC_BASE),
    callbackSecret,
    timezone: timeZone(env.DAVID_TIMEZONE),
    escalationBatchMs: boundedInt(env.SECRETARY_ESCALATION_BATCH_SECONDS, 60, 0, 86_400) * 1000,
    groupAll: flag(env.DAVID_GROUP_ALL, false),
    contextMessages: boundedInt(env.DAVID_EVENT_CONTEXT_MESSAGES, 10, 1, 50),
    typingMinMs,
    typingMaxMs,
    typingMsPerChar: boundedInt(env.DAVID_TYPING_MS_PER_CHAR, 40, 0, 1_000),
    chatGapMs: boundedInt(env.DAVID_CHAT_GAP_MS, 15_000, 0, 3_600_000),
    sendPerMinute: boundedInt(env.DAVID_SEND_PER_MINUTE, 5, 1, 600),
    sendPerHour: boundedInt(env.DAVID_SEND_PER_HOUR, 40, 1, 5_000),
    sendMaxWaitMs: boundedInt(env.DAVID_SEND_MAX_WAIT_MS, 60_000, 0, 3_600_000),
  };
}

/** Origin plus `/david/cursor-callback`. Empty base yields no callback. */
export function codeCallbackUrl(base: string): string | null {
  if (!base) return null;
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.username || parsed.password) return null;
    const path = parsed.pathname.replace(/\/$/, '');
    parsed.pathname = `${path}/david/cursor-callback`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}
