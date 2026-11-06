/**
 * Rule-based labels for inbound messages.
 * The label is a hint on the Secretary event. It never sends a WhatsApp message.
 */

/** Words that name the owner in escalation phrases: OWNER_NAME's first word (when set) or generic forms. */
function ownerPattern(env: NodeJS.ProcessEnv = process.env): string {
  const generic = ['the owner', 'your boss', 'tu jefe', 'tu jefa', 'el titular'];
  const first = (env.OWNER_NAME ?? '').trim().split(/\s+/)[0] ?? '';
  const names = first ? [first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ...generic] : generic;
  return `(?:${names.join('|')})`;
}

export type OwnerCommand =
  | { name: 'allowlist_list' }
  | { name: 'allowlist_grant'; phone: string; repo: string }
  | { name: 'allowlist_revoke'; phone: string; repo: string | null }
  | { name: 'allowlist_usage' }
  | { name: 'status' }
  | { name: 'quiet_show' }
  | { name: 'quiet_set'; window: string | null }
  | { name: 'quiet_invalid' }
  | { name: 'approve'; requestId: string | null }
  | { name: 'deny'; requestId: string | null }
  | { name: 'edit'; requestId: string; text: string };

export type Intent =
  | { kind: 'command'; command: OwnerCommand }
  | { kind: 'ignored_command' }
  | { kind: 'ai' }
  | { kind: 'welcome' }
  | { kind: 'meeting'; change: boolean; unimportant: boolean }
  | { kind: 'code'; repo: string | null }
  | { kind: 'escalate'; escalationType: 'policy' | 'other' }
  | { kind: 'chat' };

/** A greeting, not a request to get on the calendar. */
const MEET_GREETING = /\b(?:nice|pleased|good|great|lovely|glad|pleasure)\s+to\s+meet\b/i;
/** "meet the deadline" / "meet you there" is not a meeting request. */
const NOT_A_MEET = /\bmeet\s+(?:you|ya|the|him|her|them|our|their)\b/i;
const STRONG_MEETING = /\b(?:meetings?|meet[\s-]*ups?|meetups?|catch\s+up|hop\s+on\s+(?:a\s+)?(?:call|zoom|meet)|schedule\s+(?:a|the)|calendar\s+invite|zoom|google\s+meet|book\s+(?:a\s+)?(?:meeting|time)|call\s+me|phone\s+call|reuni[oó]n|reunirnos|junta(?:rnos|mos)?|agendar|agéndame|agendame|cita\s+con|poner\s+en\s+el\s+calendario|llamada|vernos|nos\s+vemos|podemos\s+vernos)\b/i;
const WEAK_MEETING = /\b(?:meet|are\s+you\s+free|r\s+u\s+free|est[aá]s\s+libre|estas\s+libre|tienes\s+tiempo|tiene\s+tiempo|quedamos|quedarnos)\b|\b(?:podemos|quieres|quisieras)\s+quedar\b|\bquedar\s+(?:el|la|mañana|manana|hoy|a\s+las)\b/i;
const AVAILABILITY = /\b(?:free|available|disponible|libre)\b/i;
const MEETING_CHANGE = /\b(reschedule|reprogram|move|cancel|cambiar|mover|cancelar)\b/i;
const SOFT = /\b(sometime|whenever|no rush|casual|someday|some day|if you(?:'re| are) free|alg[uú]n d[ií]a|cuando puedas|sin prisa|no hay prisa|cuando sea|grab coffee|coffee sometime)\b/i;
const CONCRETE = /\b(today|tomorrow|tonight|mañana|manana|hoy|lunes|martes|mi[eé]rcoles|miercoles|jueves|viernes|s[aá]bado|sabado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(?:at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|a las\s+\d{1,2}|\d{1,2}\s*(?:am|pm))\b|\b\d{4}-\d{2}-\d{2}\b/i;
const CODE = /\b(pull request|repo|repository|github|commit|bugfix|bug fix|implement|fix the|code change|open a pr|repositorio|c[oó]digo|arregla|corrige|implementa)\b|\bpr\b/i;
const AI_QUESTION = /\b(are you|r u|eres|es usted|usted es|sos)\b[\s\S]{0,48}\b(bot|a\.?i\.?|artificial intelligence|inteligencia artificial|robot|humano|human|real person|persona real|chatgpt|grok)\b/i;
const WELCOME = /\b(send|say|da|den|mande|envía|envia)\b.{0,40}\b(welcome|bienvenida)\b|\bwelcome (them|everyone|the new|him|her|to the)\b|\b(mensaje de bienvenida|dar la bienvenida)\b/i;

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

export function normalizeRepo(raw: string): string | null {
  const value = raw.trim();
  if (value === '*') return '*';
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (!match) return null;
  if (match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') return null;
  return `${match[1]}/${match[2]}`;
}

export function extractRepo(text: string): string | null {
  const github = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i.exec(text);
  if (github?.[1]) {
    const repo = normalizeRepo(github[1]);
    if (repo && repo !== '*') return repo;
  }
  const pair = /(?:^|[\s(])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/.exec(text);
  if (!pair?.[1]) return null;
  const repo = normalizeRepo(pair[1]);
  return repo && repo !== '*' ? repo : null;
}

function validClock(hour: string, minute: string): boolean {
  const h = Number(hour);
  const m = Number(minute);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function parseCommand(text: string): OwnerCommand | null {
  const trimmed = text.trim();
  if (/^\/status\s*$/i.test(trimmed)) return { name: 'status' };
  if (/^\/quiet\s*$/i.test(trimmed)) return { name: 'quiet_show' };
  if (/^\/quiet\s+off\s*$/i.test(trimmed)) return { name: 'quiet_set', window: null };
  const quiet = /^\/quiet\s+(\d{2}):(\d{2})-(\d{2}):(\d{2})\s*$/i.exec(trimmed);
  if (quiet) {
    if (!validClock(quiet[1] ?? '', quiet[2] ?? '') || !validClock(quiet[3] ?? '', quiet[4] ?? '')) return { name: 'quiet_invalid' };
    return { name: 'quiet_set', window: `${quiet[1]}:${quiet[2]}-${quiet[3]}:${quiet[4]}` };
  }
  if (/^\/quiet\b/i.test(trimmed)) return { name: 'quiet_invalid' };
  if (/^\/allowlist\s*$/i.test(trimmed)) return { name: 'allowlist_list' };
  const grant = /^\/allowlist\s+grant\s+(\+?[\d][\d\s-]{6,22})\s+(\S+)\s*$/i.exec(trimmed);
  if (grant?.[1] && grant[2]) return { name: 'allowlist_grant', phone: grant[1], repo: grant[2] };
  const revoke = /^\/allowlist\s+revoke\s+(\+?[\d][\d\s-]{6,22})(?:\s+(\S+))?\s*$/i.exec(trimmed);
  if (revoke?.[1]) return { name: 'allowlist_revoke', phone: revoke[1], repo: revoke[2] ?? null };
  if (/^\/allowlist\b/i.test(trimmed)) return { name: 'allowlist_usage' };
  const approve = /^\/approve(?:\s+([0-9a-fA-F-]{36}))?\s*$/i.exec(trimmed);
  if (approve) return { name: 'approve', requestId: approve[1] ?? null };
  const deny = /^\/deny(?:\s+([0-9a-fA-F-]{36}))?\s*$/i.exec(trimmed);
  if (deny) return { name: 'deny', requestId: deny[1] ?? null };
  const edit = /^\/edit\s+([0-9a-fA-F-]{36})\s+(.{1,500})$/i.exec(trimmed);
  if (edit?.[1] && edit[2]) return { name: 'edit', requestId: edit[1], text: edit[2].trim() };
  return null;
}

export function isUnimportantMeeting(text: string): boolean {
  return SOFT.test(text) && !CONCRETE.test(text);
}

/**
 * A clear scheduling ask. Strong phrases count on their own. A weaker phrase
 * (plain "meet", "are you free", "quedar", "tienes tiempo") also counts.
 * A concrete time or date plus an availability word counts even without those verbs.
 * Greetings ("nice to meet you") do not.
 */
export function isMeetingRequest(text: string): boolean {
  if (MEET_GREETING.test(text)) return false;
  if (STRONG_MEETING.test(text)) return true;
  if (WEAK_MEETING.test(text) && !NOT_A_MEET.test(text)) return true;
  return CONCRETE.test(text) && AVAILABILITY.test(text);
}

export function classify(text: string, options: { isOwnerDm: boolean }): Intent {
  const trimmed = text.trim();
  if (options.isOwnerDm) {
    const command = parseCommand(trimmed);
    if (command) return { kind: 'command', command };
  } else if (/^\/(allowlist|approve|deny|edit|quiet|status)\b/i.test(trimmed)) {
    return { kind: 'ignored_command' };
  }
  if (AI_QUESTION.test(trimmed)) return { kind: 'ai' };
  if (WELCOME.test(trimmed)) return { kind: 'welcome' };
  const coffee = /\b(coffee|caf[eé])\b/i.test(trimmed) && (SOFT.test(trimmed) || CONCRETE.test(trimmed));
  if (isMeetingRequest(trimmed) || coffee) {
    return { kind: 'meeting', change: MEETING_CHANGE.test(trimmed), unimportant: isUnimportantMeeting(trimmed) };
  }
  if (CODE.test(trimmed)) return { kind: 'code', repo: extractRepo(trimmed) };
  const owner = ownerPattern();
  if (/\b(policy|pol[ií]tica)\b/i.test(trimmed) && new RegExp(`\\b(ask ${owner}|${owner} should|approve|preg[uú]ntale a ${owner})\\b`, 'i').test(trimmed)) {
    return { kind: 'escalate', escalationType: 'policy' };
  }
  if (new RegExp(`\\b(ask ${owner}|check with ${owner}|preg[uú]ntale a ${owner}|escalate|escala)\\b`, 'i').test(trimmed)) {
    return { kind: 'escalate', escalationType: 'other' };
  }
  return { kind: 'chat' };
}

/** Optional hint for the Secretary event. Null means ordinary chat. Never a reason to send. */
export function eventHint(intent: Intent): string | null {
  if (intent.kind === 'command') return 'owner_command';
  if (intent.kind === 'ignored_command') return 'command';
  if (intent.kind === 'ai') return 'ai';
  if (intent.kind === 'welcome') return 'welcome';
  if (intent.kind === 'meeting') {
    if (intent.unimportant) return 'meeting_unimportant';
    return intent.change ? 'meeting_change' : 'meeting';
  }
  if (intent.kind === 'code') return 'code';
  if (intent.kind === 'escalate') return intent.escalationType === 'policy' ? 'policy' : 'escalate';
  return null;
}

export function shortOwnerDecision(text: string): 'approve' | 'deny' | null {
  const trimmed = text.trim();
  if (trimmed.length > 40) return null;
  if (/^(yes|y|approve|ok|okay|sí|si|dale|hazlo)\.?$/i.test(trimmed)) return 'approve';
  if (/^(no|n|deny|nope|rechaza|rechazado)\.?$/i.test(trimmed)) return 'deny';
  return null;
}

const PLACEHOLDER_TEXT = /^\[[a-z]+\]$/i;

export function actionableText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat || PLACEHOLDER_TEXT.test(flat)) return '';
  return flat.slice(0, 4000);
}

export function summarizeRequest(prefix: string, text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const sentences = flat.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 2);
  const body = (sentences.length > 0 ? sentences.join(' ') : flat).slice(0, 320);
  return `${prefix} ${body}`.trim().slice(0, 400);
}

export function meetingWhen(text: string): string {
  const match = text.match(/\b(today|tomorrow|tonight|mañana|manana|hoy|lunes|martes|mi[eé]rcoles|miercoles|jueves|viernes|s[aá]bado|sabado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\s+a las\s+\d{1,2})?/i);
  return match?.[0] ?? '';
}
