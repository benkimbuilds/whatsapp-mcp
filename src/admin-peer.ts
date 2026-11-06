import type { BlockAdd, BlockEntry, BlocklistView } from './webhook-blocklist.js';
/**
 * Personal admin client for David's internal read API.
 * The bearer is DAVID_READ_SECRET. The URL is restricted to http on localhost
 * or a single Compose DNS label so a bad env value cannot send that secret
 * to a public host.
 */
import { strongSecret } from './admin-secret.js';

const TIMEOUT_MS = 2000;
const MAX_BODY = 2_000_000;
const JID = /^[0-9A-Za-z._-]{1,64}@[A-Za-z0-9._-]{1,32}$/;

const PATHS = new Set([
  '/internal/admin/webhook-blocklist',
  '/internal/admin/webhook-blocklist/remove',
  '/internal/admin/webhook-blocklist/purge',
  '/internal/admin/overview',
  '/internal/admin/chats',
  '/internal/admin/messages',
  '/internal/admin/activity',
  '/internal/admin/stats',
  '/internal/admin/requests',
  '/internal/admin/context',
  '/internal/admin/style',
  '/internal/admin/approved-contacts',
  '/internal/admin/approved-contacts/remove',
  '/internal/admin/approved-contacts/cap',
]);

export type PeerFailureReason = 'unconfigured' | 'unavailable' | 'unauthorized' | 'disabled' | 'forbidden' | 'invalid';

export type PeerResult<T> = { ok: true; data: T } | { ok: false; reason: PeerFailureReason; detail?: string };

export type AdminActivity = {
  jid: string;
  name?: string;
  id: string;
  timestamp: number | null;
  fromMe: boolean | null;
  snippet: string;
};

export type AdminChat = {
  id: string;
  name?: string;
  unreadCount?: number;
  conversationTimestamp?: number;
};

export type AdminMessage = {
  timestamp: number | null;
  fromMe: boolean | null;
  text: string;
};

export type AdminSearchHit = {
  timestamp: number | null;
  snippet: string;
};

export type AdminMessages = {
  searching: boolean;
  name?: string;
  messages: AdminMessage[];
  hits: AdminSearchHit[];
  nextOffset?: number;
};

export type AdminStatsGroup = {
  jid: string;
  name?: string;
  total: number;
  days: Array<{ date: string; messages: number }>;
};

export type AdminCall = {
  at: number;
  tool: string;
  action: string | null;
  argsSummary: string;
  durationMs: number;
  ok: boolean;
};

export type AssistantSummary = {
  quiet: string;
  aibmGroupJid: string;
  openEscalations: number;
  codeInFlight: number;
  deflections: number;
};

export type AdminEscalation = {
  issuedAt: string;
  status: string;
  type: string;
  chatId: string;
  summary: string;
  suggestedAction: string;
  excerpt: string;
  decision: string | null;
  note: string | null;
  resolvedVia: string | null;
  secretaryPostedAt: string | null;
  ownerDmAt: string | null;
  requesterPhone: string;
};

export type AdminCodeRequest = {
  updatedAt: string;
  status: string;
  repo: string;
  ask: string;
  prUrl: string | null;
  summary: string | null;
  requesterPhone: string;
  chatId: string;
};

export type AdminOutbox = {
  id: number;
  chatId: string;
  messageId: string;
  enqueuedAt: number;
  sentAt: number | null;
  type: string;
  hint: string | null;
  text: string;
};

export type AdminPace = {
  queued: number;
  sentLastMinute: number;
  sentLastHour: number;
};

export type AdminContext = AssistantSummary & {
  escalations: AdminEscalation[];
  codeRequests: AdminCodeRequest[];
  allowlist: Array<{ phone: string; repos: string[] }>;
  deflectionLog: Array<{ at: string; chatId: string; requesterPhone: string; summary: string }>;
  /** Absent on an older David process. */
  unsentOutbox: number;
  outbox: AdminOutbox[];
  pace: AdminPace | null;
};

export type AdminOverview = {
  chats: number;
  messages: number;
  activity: AdminActivity[];
  assistant: AssistantSummary | null;
};

export type AdminStyleLine = {
  id: string;
  label: string;
  placeholders: string;
  en: string;
  es: string;
};

export type AdminStyle = {
  guide: string;
  guideMax: number;
  strip: boolean;
  lineMax: number;
  lines: AdminStyleLine[];
};

export type StyleUpdate = {
  guide: string;
  strip: boolean;
  lines: Record<string, { en: string; es: string }>;
};

export type AdminApprovedContact = {
  jid: string;
  phone: string;
  displayName: string;
  note: string;
  addedBy: string;
  addedAt: string;
  lid: string | null;
};

export type AdminApproved = {
  coldPerDay: number;
  coldSentToday: number;
  contacts: AdminApprovedContact[];
};

export type ApprovedAdd = {
  identifier: string;
  displayName: string;
  note: string;
};

export type DavidPeer = {
  blocklist(): Promise<PeerResult<BlocklistView>>;
  addBlocklist(input: BlockAdd): Promise<PeerResult<Record<string, unknown>>>;
  purgeBlocklist(identifier: string, confirmation: string): Promise<PeerResult<Record<string, unknown>>>;
  removeBlocklist(identifier: string): Promise<PeerResult<Record<string, unknown>>>;
  configured: boolean;
  baseUrl: string;
  overview(): Promise<PeerResult<AdminOverview>>;
  chats(): Promise<PeerResult<AdminChat[]>>;
  messages(jid: string, offset: number, query: string): Promise<PeerResult<AdminMessages>>;
  activity(): Promise<PeerResult<AdminActivity[]>>;
  stats(): Promise<PeerResult<AdminStatsGroup[]>>;
  requests(): Promise<PeerResult<AdminCall[]>>;
  context(): Promise<PeerResult<AdminContext>>;
  style(): Promise<PeerResult<AdminStyle>>;
  saveStyle(update: StyleUpdate): Promise<PeerResult<AdminStyle>>;
  approved(): Promise<PeerResult<AdminApproved>>;
  addApproved(input: ApprovedAdd): Promise<PeerResult<AdminApprovedContact>>;
  removeApproved(identifier: string): Promise<PeerResult<{ jid: string }>>;
  saveApprovedCap(coldPerDay: number): Promise<PeerResult<AdminApproved>>;
};

/** http://host:port with no userinfo, path, or query. Host is localhost or one DNS label. */
export function normalizeDavidAdminUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
  if (parsed.search || parsed.hash) return null;
  if (!parsed.port) return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = parsed.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const label = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(host);
  if (!local && !label) return null;
  return `${parsed.protocol}//${parsed.host}`;
}

export function createDavidPeer(options: {
  secret: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): DavidPeer {
  const secret = options.secret.trim();
  const base = normalizeDavidAdminUrl(options.baseUrl);
  const configured = strongSecret(secret) && base !== null;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function get(path: string): Promise<PeerResult<unknown>> {
    if (!configured || !base) return { ok: false, reason: 'unconfigured' };
    let url: URL;
    try {
      url = new URL(path, base);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (url.origin !== new URL(base).origin || !PATHS.has(url.pathname)) {
      return { ok: false, reason: 'unavailable' };
    }
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${secret}`,
        },
      });
      if (response.status === 401) return { ok: false, reason: 'unauthorized' };
      if (response.status === 403) return { ok: false, reason: 'forbidden' };
      if (response.status === 404) return { ok: false, reason: 'disabled' };
      if (response.status === 400) return { ok: false, reason: 'invalid', detail: await errorDetail(response) };
      if (!response.ok) return { ok: false, reason: 'unavailable' };
      const text = await response.text();
      if (text.length > MAX_BODY) return { ok: false, reason: 'unavailable' };
      return { ok: true, data: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  function map<T>(result: PeerResult<unknown>, parse: (value: unknown) => T | null): PeerResult<T> {
    if (!result.ok) return result;
    const data = parse(result.data);
    if (!data) return { ok: false, reason: 'unavailable' };
    return { ok: true, data };
  }

  async function post(path: string, body: unknown): Promise<PeerResult<unknown>> {
    return write('POST', path, body);
  }

  async function put(path: string, body: unknown): Promise<PeerResult<unknown>> {
    return write('PUT', path, body);
  }

  async function write(method: 'POST' | 'PUT', path: string, body: unknown): Promise<PeerResult<unknown>> {
    if (!configured || !base) return { ok: false, reason: 'unconfigured' };
    let url: URL;
    try {
      url = new URL(path, base);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (url.origin !== new URL(base).origin || !PATHS.has(url.pathname)) {
      return { ok: false, reason: 'unavailable' };
    }
    try {
      const response = await fetchImpl(url, {
        method,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(body),
      });
      if (response.status === 401) return { ok: false, reason: 'unauthorized' };
      if (response.status === 403) return { ok: false, reason: 'forbidden' };
      if (response.status === 404) return { ok: false, reason: 'disabled' };
      if (response.status === 400) return { ok: false, reason: 'invalid', detail: await errorDetail(response) };
      if (!response.ok) return { ok: false, reason: 'unavailable' };
      const textBody = await response.text();
      if (textBody.length > MAX_BODY) return { ok: false, reason: 'unavailable' };
      return { ok: true, data: JSON.parse(textBody) as unknown };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  return {
    blocklist: async () => map(await get('/internal/admin/webhook-blocklist'), parseBlocklist),
    addBlocklist: async (input) => map(await post('/internal/admin/webhook-blocklist', input), value => isRecord(value) ? value : null),
    purgeBlocklist: async (identifier, confirmation) => map(await post('/internal/admin/webhook-blocklist/purge', { identifier, confirmation }), value => isRecord(value) ? value : null),
    removeBlocklist: async (identifier) => map(await post('/internal/admin/webhook-blocklist/remove', { identifier }), value => isRecord(value) ? value : null),
    configured,
    baseUrl: configured && base ? base : '',
    overview: async () => map(await get('/internal/admin/overview'), parseOverview),
    chats: async () => map(await get('/internal/admin/chats'), (value) => {
      if (!isRecord(value)) return null;
      return parseChats(value.chats);
    }),
    messages: async (jid, offset, query) => {
      const params = new URLSearchParams({ jid, offset: String(offset) });
      if (query) params.set('q', query);
      return map(await get(`/internal/admin/messages?${params}`), parseMessages);
    },
    activity: async () => map(await get('/internal/admin/activity'), (value) => {
      if (!isRecord(value)) return null;
      return parseActivity(value.activity);
    }),
    stats: async () => map(await get('/internal/admin/stats'), (value) => {
      if (!isRecord(value)) return null;
      return parseStats(value.groups);
    }),
    requests: async () => map(await get('/internal/admin/requests'), (value) => {
      if (!isRecord(value)) return null;
      return parseCalls(value.calls);
    }),
    context: async () => map(await get('/internal/admin/context'), parseContext),
    style: async () => map(await get('/internal/admin/style'), parseStyle),
    saveStyle: async (update) => map(await put('/internal/admin/style', update), (value) => {
      if (!isRecord(value)) return null;
      return parseStyle(value.style);
    }),
    approved: async () => map(await get('/internal/admin/approved-contacts'), parseApproved),
    addApproved: async (input) => map(await post('/internal/admin/approved-contacts', {
      identifier: input.identifier,
      displayName: input.displayName,
      note: input.note,
      addedBy: 'dashboard',
    }), (value) => {
      if (!isRecord(value)) return null;
      return parseApprovedContact(value.contact);
    }),
    removeApproved: async (identifier) => map(await post('/internal/admin/approved-contacts/remove', { identifier }), (value) => {
      if (!isRecord(value)) return null;
      const jid = text(value.jid, 98);
      if (!jid || !JID.test(jid)) return null;
      return { jid };
    }),
    saveApprovedCap: async (coldPerDay) => map(await put('/internal/admin/approved-contacts/cap', { coldPerDay }), parseApproved),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  return value.length > max ? value.slice(0, max) : value;
}

function optText(value: unknown, max: number): string | undefined | null {
  if (value == null || value === '') return undefined;
  return text(value, max);
}

function count(value: unknown, max = 1_000_000_000): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) return null;
  return value;
}

function stamp(value: unknown): number | null | undefined {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function flag(value: unknown): boolean | null | undefined {
  if (value == null) return null;
  if (typeof value !== 'boolean') return undefined;
  return value;
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  return value;
}

function parseActivity(value: unknown): AdminActivity[] | null {
  if (!Array.isArray(value)) return null;
  const rows: AdminActivity[] = [];
  for (const item of value.slice(0, 50)) {
    if (!isRecord(item)) return null;
    const jid = text(item.jid, 98);
    const id = text(item.id, 128);
    const snippet = text(item.snippet, 200);
    const timestamp = stamp(item.timestamp);
    const fromMe = flag(item.fromMe);
    const name = optText(item.name, 200);
    if (!jid || !JID.test(jid) || !id || snippet == null || timestamp === undefined || fromMe === undefined || name === null) return null;
    rows.push({ jid, id, snippet, timestamp, fromMe, ...(name ? { name } : {}) });
  }
  return rows;
}

function parseChats(value: unknown): AdminChat[] | null {
  if (!Array.isArray(value)) return null;
  const rows: AdminChat[] = [];
  for (const item of value.slice(0, 200)) {
    if (!isRecord(item)) return null;
    const id = text(item.id, 98);
    const name = optText(item.name, 200);
    if (!id || !JID.test(id) || name === null) return null;
    let unread: number | undefined;
    if (item.unreadCount != null) {
      const parsed = count(item.unreadCount);
      if (parsed == null) return null;
      unread = parsed;
    }
    let when: number | undefined;
    if (item.conversationTimestamp != null) {
      const parsed = stamp(item.conversationTimestamp);
      if (typeof parsed !== 'number') return null;
      when = parsed;
    }
    rows.push({
      id,
      ...(name ? { name } : {}),
      ...(unread != null ? { unreadCount: unread } : {}),
      ...(when != null ? { conversationTimestamp: when } : {}),
    });
  }
  return rows;
}

function parseMessages(value: unknown): AdminMessages | null {
  if (!isRecord(value) || typeof value.searching !== 'boolean') return null;
  const name = optText(value.name, 200);
  const next = value.nextOffset == null ? undefined : count(value.nextOffset, 100_000);
  if (name === null || (value.nextOffset != null && next == null)) return null;
  if (value.searching) {
    if (!Array.isArray(value.hits)) return null;
    const hits: AdminSearchHit[] = [];
    for (const item of value.hits.slice(0, 50)) {
      if (!isRecord(item)) return null;
      const snippet = text(item.snippet, 200);
      const timestamp = stamp(item.timestamp);
      if (snippet == null || timestamp === undefined) return null;
      hits.push({ snippet, timestamp });
    }
    return { searching: true, ...(name ? { name } : {}), messages: [], hits, ...(next != null ? { nextOffset: next } : {}) };
  }
  if (!Array.isArray(value.messages)) return null;
  const messages: AdminMessage[] = [];
  for (const item of value.messages.slice(0, 50)) {
    if (!isRecord(item)) return null;
    const body = text(item.text, 8000);
    const timestamp = stamp(item.timestamp);
    const fromMe = flag(item.fromMe);
    if (body == null || timestamp === undefined || fromMe === undefined) return null;
    messages.push({ text: body, timestamp, fromMe });
  }
  return { searching: false, ...(name ? { name } : {}), messages, hits: [], ...(next != null ? { nextOffset: next } : {}) };
}

function parseStats(value: unknown): AdminStatsGroup[] | null {
  if (!Array.isArray(value)) return null;
  const groups: AdminStatsGroup[] = [];
  for (const item of value.slice(0, 200)) {
    if (!isRecord(item)) return null;
    const jid = text(item.jid, 98);
    const name = optText(item.name, 200);
    const total = count(item.total);
    if (!jid || !JID.test(jid) || name === null || total == null || !Array.isArray(item.days)) return null;
    const days: Array<{ date: string; messages: number }> = [];
    for (const day of item.days.slice(0, 40)) {
      if (!isRecord(day)) return null;
      const date = text(day.date, 10);
      const messages = count(day.messages);
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || messages == null) return null;
      days.push({ date, messages });
    }
    groups.push({ jid, total, days, ...(name ? { name } : {}) });
  }
  return groups;
}

function parseCalls(value: unknown): AdminCall[] | null {
  if (!Array.isArray(value)) return null;
  const calls: AdminCall[] = [];
  for (const item of value.slice(0, 100)) {
    if (!isRecord(item)) return null;
    const at = stamp(item.at);
    const tool = text(item.tool, 80);
    const action = item.action == null ? null : text(item.action, 80);
    const argsSummary = text(item.argsSummary, 240);
    const durationMs = count(item.durationMs, 600_000);
    const badAction = item.action != null && action == null;
    if (typeof at !== 'number' || !tool || badAction || argsSummary == null || durationMs == null || typeof item.ok !== 'boolean') return null;
    calls.push({ at, tool, action, argsSummary, durationMs, ok: item.ok });
  }
  return calls;
}

function parseSummary(value: Record<string, unknown>): AssistantSummary | null {
  const quiet = text(value.quiet, 32);
  const aibmGroupJid = text(value.aibmGroupJid, 98);
  const openEscalations = count(value.openEscalations);
  const codeInFlight = count(value.codeInFlight);
  const deflections = count(value.deflections);
  if (quiet == null || aibmGroupJid == null || openEscalations == null || codeInFlight == null || deflections == null) return null;
  if (aibmGroupJid && !JID.test(aibmGroupJid)) return null;
  return { quiet, aibmGroupJid, openEscalations, codeInFlight, deflections };
}

function parseOverview(value: unknown): AdminOverview | null {
  if (!isRecord(value)) return null;
  const chats = count(value.chats);
  const messages = count(value.messages);
  const activity = parseActivity(value.activity);
  if (chats == null || messages == null || !activity) return null;
  let assistant: AssistantSummary | null = null;
  if (value.assistant != null) {
    if (!isRecord(value.assistant)) return null;
    assistant = parseSummary(value.assistant);
    if (!assistant) return null;
  }
  return { chats, messages, activity, assistant };
}

function parseContext(value: unknown): AdminContext | null {
  if (!isRecord(value)) return null;
  const summary = parseSummary(value);
  if (!summary || !Array.isArray(value.escalations) || !Array.isArray(value.codeRequests) || !Array.isArray(value.allowlist) || !Array.isArray(value.deflectionLog)) return null;
  const escalations: AdminEscalation[] = [];
  for (const item of value.escalations.slice(0, 40)) {
    if (!isRecord(item)) return null;
    const issuedAt = iso(item.issuedAt) ?? '';
    const status = text(item.status, 40);
    const type = text(item.type, 40);
    const chatId = text(item.chatId, 98);
    const rowSummary = text(item.summary, 500);
    const suggestedAction = text(item.suggestedAction, 500);
    const excerpt = text(item.excerpt, 240);
    const decision = item.decision == null ? null : text(item.decision, 40);
    const note = item.note == null ? null : text(item.note, 300);
    const resolvedVia = item.resolvedVia == null ? null : text(item.resolvedVia, 40);
    const secretaryPostedAt = iso(item.secretaryPostedAt);
    const ownerDmAt = iso(item.ownerDmAt);
    const requesterPhone = text(item.requesterPhone, 32);
    if (!status || !type || chatId == null || rowSummary == null || suggestedAction == null || excerpt == null || decision === null && item.decision != null || note === null && item.note != null || resolvedVia === null && item.resolvedVia != null || requesterPhone == null) return null;
    if (item.secretaryPostedAt != null && secretaryPostedAt == null) return null;
    if (item.ownerDmAt != null && ownerDmAt == null) return null;
    escalations.push({
      issuedAt, status, type, chatId, summary: rowSummary, suggestedAction, excerpt,
      decision, note, resolvedVia, secretaryPostedAt, ownerDmAt, requesterPhone,
    });
  }
  const codeRequests: AdminCodeRequest[] = [];
  for (const item of value.codeRequests.slice(0, 40)) {
    if (!isRecord(item)) return null;
    const updatedAt = iso(item.updatedAt) ?? '';
    const status = text(item.status, 40);
    const repo = text(item.repo, 120);
    const ask = text(item.ask, 500);
    const prUrl = item.prUrl == null ? null : text(item.prUrl, 300);
    const rowSummary = item.summary == null ? null : text(item.summary, 300);
    const requesterPhone = text(item.requesterPhone, 32);
    const chatId = text(item.chatId, 98);
    if (!status || repo == null || ask == null || prUrl === null && item.prUrl != null || rowSummary === null && item.summary != null || requesterPhone == null || chatId == null) return null;
    codeRequests.push({ updatedAt, status, repo, ask, prUrl, summary: rowSummary, requesterPhone, chatId });
  }
  const allowlist: Array<{ phone: string; repos: string[] }> = [];
  for (const item of value.allowlist.slice(0, 200)) {
    if (!isRecord(item) || !Array.isArray(item.repos)) return null;
    const phone = text(item.phone, 32);
    if (phone == null) return null;
    const repos: string[] = [];
    for (const repo of item.repos.slice(0, 20)) {
      const name = text(repo, 80);
      if (name == null) return null;
      repos.push(name);
    }
    allowlist.push({ phone, repos });
  }
  const deflectionLog: AdminContext['deflectionLog'] = [];
  for (const item of value.deflectionLog.slice(0, 30)) {
    if (!isRecord(item)) return null;
    const at = iso(item.at) ?? '';
    const chatId = text(item.chatId, 98);
    const requesterPhone = text(item.requesterPhone, 32);
    const rowSummary = text(item.summary, 300);
    if (chatId == null || requesterPhone == null || rowSummary == null) return null;
    deflectionLog.push({ at, chatId, requesterPhone, summary: rowSummary });
  }
  const outbox = parseOutbox(value.outbox);
  const unsentOutbox = count(value.unsentOutbox, 1_000_000) ?? outbox.filter((row) => row.sentAt == null).length;
  const pace = value.pace == null ? null : parsePace(value.pace);
  return { ...summary, escalations, codeRequests, allowlist, deflectionLog, unsentOutbox, outbox, pace };
}

function parseOutbox(value: unknown): AdminOutbox[] {
  if (!Array.isArray(value)) return [];
  const rows: AdminOutbox[] = [];
  for (const item of value.slice(0, 40)) {
    if (!isRecord(item)) continue;
    const id = count(item.id, 1_000_000_000_000);
    const chatId = text(item.chatId, 98);
    const messageId = text(item.messageId, 128);
    const enqueuedAt = msStamp(item.enqueuedAt);
    const sentAt = item.sentAt == null ? null : msStamp(item.sentAt);
    const type = text(item.type, 40);
    const hint = item.hint == null ? null : text(item.hint, 40);
    const rowText = text(item.text, 240);
    const badSent = item.sentAt != null && sentAt == null;
    const badHint = item.hint != null && hint == null;
    if (id == null || chatId == null || messageId == null || enqueuedAt == null || badSent || type == null || badHint || rowText == null) continue;
    rows.push({ id, chatId, messageId, enqueuedAt, sentAt, type, hint, text: rowText });
  }
  return rows;
}

function parsePace(value: unknown): AdminPace | null {
  if (!isRecord(value)) return null;
  const queued = count(value.queued, 1_000_000);
  const sentLastMinute = count(value.sentLastMinute, 1_000_000);
  const sentLastHour = count(value.sentLastHour, 1_000_000);
  if (queued == null || sentLastMinute == null || sentLastHour == null) return null;
  return { queued, sentLastMinute, sentLastHour };
}

function msStamp(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10_000_000_000_000) return null;
  return value;
}

function parseApproved(value: unknown): AdminApproved | null {
  if (!isRecord(value)) return null;
  const coldPerDay = count(value.coldPerDay, 100);
  const coldSentToday = count(value.coldSentToday, 1_000_000);
  if (coldPerDay == null || coldSentToday == null || !Array.isArray(value.contacts)) return null;
  const contacts: AdminApprovedContact[] = [];
  for (const item of value.contacts.slice(0, 200)) {
    const contact = parseApprovedContact(item);
    if (!contact) return null;
    contacts.push(contact);
  }
  return { coldPerDay, coldSentToday, contacts };
}

function parseApprovedContact(value: unknown): AdminApprovedContact | null {
  if (!isRecord(value)) return null;
  const jid = text(value.jid, 98);
  const phone = text(value.phone, 32);
  const displayName = text(value.displayName, 80);
  const note = text(value.note, 300);
  const addedBy = text(value.addedBy, 80);
  const addedAt = iso(value.addedAt) ?? '';
  const lid = value.lid == null || value.lid === '' ? null : text(value.lid, 98);
  if (!jid || !JID.test(jid) || !jid.endsWith('@s.whatsapp.net') || phone == null || !/^\d{8,15}$/.test(phone)) return null;
  if (displayName == null || note == null || addedBy == null || !addedAt) return null;
  if (lid != null && !JID.test(lid)) return null;
  return { jid, phone, displayName, note, addedBy, addedAt, lid };
}

function parseStyle(value: unknown): AdminStyle | null {
  if (!isRecord(value)) return null;
  const guide = text(value.guide, 2000);
  const guideMax = count(value.guideMax, 10_000);
  const lineMax = count(value.lineMax, 10_000);
  if (guide == null || guideMax == null || lineMax == null || typeof value.strip !== 'boolean' || !Array.isArray(value.lines)) return null;
  const lines: AdminStyleLine[] = [];
  for (const item of value.lines.slice(0, 40)) {
    if (!isRecord(item)) return null;
    const id = text(item.id, 40);
    const label = text(item.label, 80);
    const placeholders = text(item.placeholders, 80);
    const en = text(item.en, 500);
    const es = text(item.es, 500);
    if (!id || !/^[a-z0-9_]+$/.test(id) || label == null || placeholders == null || en == null || es == null) return null;
    lines.push({ id, label, placeholders, en, es });
  }
  if (lines.length === 0) return null;
  return { guide, guideMax, strip: value.strip, lineMax, lines };
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const textBody = await response.text();
    if (textBody.length > 1000) return 'invalid';
    const parsed = JSON.parse(textBody) as { error?: unknown };
    return typeof parsed.error === 'string' && parsed.error.length <= 240 ? parsed.error : 'invalid';
  } catch {
    return 'invalid';
  }
}

function parseBlocklist(value: unknown): BlocklistView | null {
  if (!isRecord(value) || !Array.isArray(value.entries) || count(value.skipped) == null) return null;
  const entries: BlockEntry[] = [];
  for (const row of value.entries) {
    if (!isRecord(row)) return null;
    for (const [key, max] of [['jid',128], ['phone',15], ['name',80], ['note',300], ['added_by',80], ['reason',300], ['added_at',40]] as const) {
      if (typeof row[key] !== 'string' || row[key].length > max) return null;
    }
    if (!JID.test(row.jid as string) || (row.lid !== null && (typeof row.lid !== 'string' || !JID.test(row.lid)))) return null;
    if (count(row.stored_count) == null || count(row.event_count) == null) return null;
    entries.push(row as BlockEntry);
  }
  if (value.dropped != null && count(value.dropped) == null) return null;
  return { entries, skipped: value.skipped as number, dropped: (value.dropped as number | undefined) ?? 0 };
}
