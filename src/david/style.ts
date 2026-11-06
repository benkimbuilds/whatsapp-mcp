/**
 * David style settings. Defaults live here. Saved overrides live in david_settings.
 * Personal does not read this module on its send path.
 */

export type StyleLang = 'en' | 'es';

export const STYLE_GUIDE_MAX = 2000;
export const CANNED_LINE_MAX = 500;

export const DEFAULT_STYLE_GUIDE = 'Be succinct: one or two short sentences. Do not be flattering or subservient. No thanks-so-much, happy-to-help, gushing, or over-apologizing. Match the sender\'s language. In Spanish, never use ¡ or ¿.';

export const STYLE_GUIDE_KEY = 'style.guide';
export const STYLE_STRIP_KEY = 'style.strip';

export const CANNED_IDS = [
  'ai_truth',
  'generic',
  'no_welcome',
  'meeting_ack',
  'meeting_deflect',
  'code_ack',
  'code_need_repo',
  'code_denied',
  'code_failed',
  'code_unavailable',
  'decision_approve',
  'decision_deny',
  'decision_edit',
  'fallback_dm',
  'pull_request',
  'pull_request_plain',
  'code_failed_notice',
  'ignored_command',
] as const;

export type CannedId = typeof CANNED_IDS[number];

type CannedLine = {
  id: CannedId;
  label: string;
  placeholders: string;
  en: string;
  es: string;
};

const CANNED: readonly CannedLine[] = [
  {
    id: 'ai_truth',
    label: 'Asked if David is a bot',
    placeholders: '{owner}',
    en: "Yes. I'm {owner}'s assistant.",
    es: 'Sí. Soy el asistente de {owner}.',
  },
  {
    id: 'generic',
    label: 'Intro',
    placeholders: '{owner}',
    en: "I'm {owner}'s assistant. Send a meeting time or a note for them.",
    es: 'Soy el asistente de {owner}. Manda una hora de reunión o un recado.',
  },
  {
    id: 'no_welcome',
    label: 'Welcome request',
    placeholders: '',
    en: "I don't send welcome messages.",
    es: 'No envío mensajes de bienvenida.',
  },
  {
    id: 'meeting_ack',
    label: 'Meeting confirmation',
    placeholders: '{owner}',
    en: "I'll check with {owner} before booking that.",
    es: 'Lo consulto con {owner} antes de agendarlo.',
  },
  {
    id: 'meeting_deflect',
    label: 'Optional meeting',
    placeholders: '',
    en: "That sounds optional, so I won't book it.",
    es: 'Eso suena opcional, así que no lo agendo.',
  },
  {
    id: 'code_ack',
    label: 'Code request started',
    placeholders: '{repo}',
    en: 'Started on {repo}. The pull request link comes here when it is ready.',
    es: 'Empecé con {repo}. El enlace del pull request llega aquí cuando esté listo.',
  },
  {
    id: 'code_need_repo',
    label: 'Code request needs a repo',
    placeholders: '',
    en: 'Which repository? Use owner/name.',
    es: 'Qué repositorio? Usa owner/name.',
  },
  {
    id: 'code_denied',
    label: 'Code request denied',
    placeholders: '{owner}',
    en: 'This number cannot start code changes. {owner} has to approve access first.',
    es: 'Este número no puede pedir cambios de código. {owner} tiene que autorizar el acceso primero.',
  },
  {
    id: 'code_failed',
    label: 'Code request did not start',
    placeholders: '',
    en: 'That code change did not start.',
    es: 'Ese cambio de código no empezó.',
  },
  {
    id: 'code_unavailable',
    label: 'Code agent unavailable',
    placeholders: '',
    en: 'The code agent is not configured. Nothing started.',
    es: 'El agente de código no está configurado. Nada empezó.',
  },
  {
    id: 'decision_approve',
    label: 'Owner approved',
    placeholders: '{owner}',
    en: '{owner} approved this. It is not on the calendar.',
    es: '{owner} lo aprobó. No está en el calendario.',
  },
  {
    id: 'decision_deny',
    label: 'Owner declined',
    placeholders: '{owner}',
    en: '{owner} declined that.',
    es: '{owner} lo rechazó.',
  },
  {
    id: 'decision_edit',
    label: 'Owner asked for a change',
    placeholders: '{change}, {owner}',
    en: '{owner} asked to change it: {change}',
    es: '{owner} pidió cambiarlo: {change}',
  },
  {
    id: 'fallback_dm',
    label: 'Note to the owner',
    placeholders: '{requestId}, {summary}',
    en: 'Needs you ({requestId}). {summary} Reply /approve {requestId} or /deny {requestId}.',
    es: 'Te toca ({requestId}). {summary} Responde /approve {requestId} o /deny {requestId}.',
  },
  {
    id: 'pull_request',
    label: 'Pull request with a summary',
    placeholders: '{url}, {summary}',
    en: 'Pull request: {url} — {summary}',
    es: 'Pull request listo: {url}. {summary}',
  },
  {
    id: 'pull_request_plain',
    label: 'Pull request link',
    placeholders: '{url}',
    en: 'Pull request: {url}',
    es: 'Pull request listo: {url}',
  },
  {
    id: 'code_failed_notice',
    label: 'Code change failed',
    placeholders: '',
    en: "The code change didn't finish. There is no pull request.",
    es: 'El cambio de código no terminó. No hay pull request.',
  },
  {
    id: 'ignored_command',
    label: 'Unhandled command',
    placeholders: '{owner}',
    en: 'Send a note for {owner}.',
    es: 'Manda un recado para {owner}.',
  },
];

const CANNED_BY_ID = new Map<CannedId, CannedLine>(CANNED.map((line) => [line.id, line]));

const PLACEHOLDERS = ['repo', 'change', 'requestId', 'summary', 'url', 'owner'] as const;

/** Default name used in canned lines when OWNER_NAME is unset. */
export const DEFAULT_OWNER_NAME = 'the owner';

/** The owner's display name for canned lines: OWNER_NAME, or a neutral default. */
export function ownerName(env: NodeJS.ProcessEnv = process.env): string {
  const value = (env.OWNER_NAME ?? '').trim().replace(/\s+/g, ' ');
  return value ? value.slice(0, 60) : DEFAULT_OWNER_NAME;
}

export type StyleUpdate = {
  guide: string;
  strip: boolean;
  lines: Record<CannedId, { en: string; es: string }>;
};

export type StyleLineView = {
  id: CannedId;
  label: string;
  placeholders: string;
  en: string;
  es: string;
};

export type StyleView = {
  guide: string;
  guideMax: number;
  strip: boolean;
  lineMax: number;
  lines: StyleLineView[];
};

export type StyleSettingRow = { key: string; value: string };

export function lineSettingKey(id: CannedId, lang: StyleLang): string {
  return `style.line.${id}.${lang}`;
}

export function isCannedId(value: string): value is CannedId {
  return CANNED_BY_ID.has(value as CannedId);
}

/** Remove ¡ and ¿. Collapse spaces that removal leaves, including a leading run. Text with neither mark is unchanged. */
export function stripInvertedPunctuation(text: string): string {
  const stripped = text.replace(/[¡¿]/g, '');
  if (stripped === text) return text;
  return stripped.replace(/ {2,}/g, ' ').replace(/^ +/, '').replace(/ +$/, '');
}

/** Missing or unrecognized values stay on. Only off, false, and 0 disable the strip. */
export function stripEnabled(stored: string | null | undefined): boolean {
  if (stored == null) return true;
  const value = stored.trim().toLowerCase();
  if (value === '' || value === 'on' || value === 'true' || value === '1') return true;
  if (value === 'off' || value === 'false' || value === '0') return false;
  return true;
}

export function styleGuideText(stored: string | null | undefined): string {
  const value = normalizeNewlines(stored ?? '').trim();
  if (!value) return DEFAULT_STYLE_GUIDE;
  return value.length > STYLE_GUIDE_MAX ? value.slice(0, STYLE_GUIDE_MAX) : value;
}

export function renderCanned(
  id: CannedId,
  lang: StyleLang,
  stored: string | null | undefined,
  vars: Record<string, string>,
): string {
  return fillTemplate(effectiveLine(id, lang, stored), vars);
}

export function readStyle(get: (key: string) => string | null): StyleView {
  return {
    guide: styleGuideText(get(STYLE_GUIDE_KEY)),
    guideMax: STYLE_GUIDE_MAX,
    strip: stripEnabled(get(STYLE_STRIP_KEY)),
    lineMax: CANNED_LINE_MAX,
    lines: CANNED.map((line) => ({
      id: line.id,
      label: line.label,
      placeholders: line.placeholders,
      en: effectiveLine(line.id, 'en', get(lineSettingKey(line.id, 'en'))),
      es: effectiveLine(line.id, 'es', get(lineSettingKey(line.id, 'es'))),
    })),
  };
}

/** Rows to store. A blank or default line is omitted so the built-in text stays in effect. */
export function styleSettingRows(update: StyleUpdate): StyleSettingRow[] {
  const rows: StyleSettingRow[] = [{ key: STYLE_STRIP_KEY, value: update.strip ? 'on' : 'off' }];
  if (update.guide && update.guide !== DEFAULT_STYLE_GUIDE) rows.push({ key: STYLE_GUIDE_KEY, value: update.guide });
  for (const id of CANNED_IDS) {
    const line = CANNED_BY_ID.get(id)!;
    for (const lang of ['en', 'es'] as const) {
      const value = update.lines[id][lang];
      if (!value || value === line[lang]) continue;
      rows.push({ key: lineSettingKey(id, lang), value });
    }
  }
  return rows;
}

export function defaultStylePayload(): { guide: string; strip: boolean; lines: Record<CannedId, { en: string; es: string }> } {
  const lines = {} as Record<CannedId, { en: string; es: string }>;
  for (const line of CANNED) lines[line.id] = { en: line.en, es: line.es };
  return { guide: DEFAULT_STYLE_GUIDE, strip: true, lines };
}

export function parseStyleBody(body: unknown): { ok: true; value: StyleUpdate } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: 'invalid_body' };
  for (const key of Object.keys(body)) {
    if (key !== 'guide' && key !== 'strip' && key !== 'lines') return { ok: false, error: 'invalid_body' };
  }
  if (typeof body.guide !== 'string' || typeof body.strip !== 'boolean' || !isRecord(body.lines)) {
    return { ok: false, error: 'invalid_body' };
  }
  if (body.guide.includes('\u0000')) return { ok: false, error: 'invalid_body' };
  const guide = normalizeNewlines(body.guide).trim();
  if (guide.length > STYLE_GUIDE_MAX) return { ok: false, error: 'guide_too_long' };
  const incoming = body.lines;
  const names = Object.keys(incoming);
  if (names.length !== CANNED_IDS.length || names.some((name) => !isCannedId(name))) {
    return { ok: false, error: 'invalid_lines' };
  }
  const lines = {} as StyleUpdate['lines'];
  for (const id of CANNED_IDS) {
    const row = incoming[id];
    if (!isRecord(row)) return { ok: false, error: 'invalid_lines' };
    if (Object.keys(row).some((key) => key !== 'en' && key !== 'es')) return { ok: false, error: 'invalid_lines' };
    if (typeof row.en !== 'string' || typeof row.es !== 'string') return { ok: false, error: 'invalid_lines' };
    if (row.en.includes('\u0000') || row.es.includes('\u0000')) return { ok: false, error: 'invalid_lines' };
    const en = normalizeNewlines(row.en).trim();
    const es = normalizeNewlines(row.es).trim();
    if (en.length > CANNED_LINE_MAX || es.length > CANNED_LINE_MAX) return { ok: false, error: 'line_too_long' };
    lines[id] = { en, es };
  }
  return { ok: true, value: { guide, strip: body.strip, lines } };
}

/** HTML form fields from /admin/david. Checkbox absence means strip off. */
export function styleUpdateFromForm(body: unknown): { ok: true; value: StyleUpdate } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: 'invalid_body' };
  if (typeof body.guide !== 'string') return { ok: false, error: 'invalid_body' };
  const lines = {} as Record<CannedId, { en: string; es: string }>;
  for (const id of CANNED_IDS) {
    const en = body[`en_${id}`];
    const es = body[`es_${id}`];
    if (typeof en !== 'string' || typeof es !== 'string') return { ok: false, error: 'invalid_lines' };
    lines[id] = { en, es };
  }
  const strip = body.strip === '1' || body.strip === 'on' || body.strip === 'true' || body.strip === true;
  return parseStyleBody({ guide: body.guide, strip, lines });
}

export function styleErrorText(code: string): string {
  if (code === 'guide_too_long') return `Style guide must be ${STYLE_GUIDE_MAX} characters or less.`;
  if (code === 'line_too_long') return `Each canned line must be ${CANNED_LINE_MAX} characters or less.`;
  return 'Style settings were not valid.';
}

function effectiveLine(id: CannedId, lang: StyleLang, stored: string | null | undefined): string {
  const value = normalizeNewlines(stored ?? '').trim();
  if (!value) return CANNED_BY_ID.get(id)![lang];
  return value.length > CANNED_LINE_MAX ? value.slice(0, CANNED_LINE_MAX) : value;
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  const filled = template.replace(/\{(repo|change|requestId|summary|url|owner)\}/g, (match, key: typeof PLACEHOLDERS[number]) => {
    const value = key === 'owner' ? (vars.owner ?? ownerName()) : vars[key];
    return value == null ? match : value;
  });
  // A lowercase default owner name at the start of a line reads as a sentence start.
  return filled.replace(/^[a-z]/, (first) => (template.startsWith('{owner}') ? first.toUpperCase() : first));
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
