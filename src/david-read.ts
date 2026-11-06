/**
 * JSON for the personal admin dashboard.
 *
 * Personal fetches this over the Compose network (http://david:8788) with
 * DAVID_READ_SECRET. The same secret authorizes the style write, the approved
 * contact list, and the cold-send cap. David stays on loopback. This is not
 * an HTML admin. It does not send. The dashboard can explicitly purge stored
 * blocklisted history/outbox rows over the authenticated internal transport. The code allowlist stays
 * read-only. Approved contacts are a separate list.
 *
 * A shared SQLite mount was rejected: David's process already has the WAL files
 * open, and a second container opening them read-only can fail when it cannot
 * create the WAL index. HTTP fails closed when David is down.
 */
import express, { type Express, type Response } from 'express';
import { safeEqual, strongSecret } from './admin-secret.js';
import type { PaceStatus } from './david/pacing.js';
import type { DavidStore } from './david/store.js';
import {
  addApprovedContact,
  approvedAdminView,
  removeApprovedContact,
  setColdCap,
  type ApprovedAdminView,
} from './david/approved.js';
import type { ResolvedPhone } from './david/resolve.js';
import { parseStyleBody, readStyle, styleSettingRows } from './david/style.js';
import { rejectProxiedInternal } from './internal-guard.js';
import type { MemoryStore } from './store.js';

const PAGE_SIZE = 30;
const JID = /^[0-9A-Za-z._-]{1,64}@[A-Za-z0-9._-]{1,32}$/;

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function sendJson(res: Response, status: number, body: unknown): void {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.status(status).json(body);
}

function bearer(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length).trim();
}

function queryString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function mountDavidRead(app: Express, options: {
  secret: string;
  store: MemoryStore;
  davidStore: DavidStore;
  aibmGroupJid: string;
  role: string;
  pace?: () => PaceStatus;
  timezone?: string;
  resolveContact?: (identifier: string) => Promise<{ ok: true; contact: ResolvedPhone } | { ok: false; error: string }>;
}): void {
  const { secret, store, davidStore, aibmGroupJid, role, pace } = options;
  const timezone = options.timezone || 'UTC';
  const log = (line: string) => console.log(`[whatsapp-bridge:${role}] ${line}`);
  if (!strongSecret(secret)) {
    console.log(`[whatsapp-bridge:${role}] David read API disabled. Set DAVID_READ_SECRET to a random string of at least 24 characters so the personal admin can read this service.`);
    return;
  }
  console.log(`[whatsapp-bridge:${role}] David admin API enabled at /internal/admin`);

  app.use('/internal/admin', rejectProxiedInternal);
  app.use('/internal/admin', (req, res, next) => {
    const given = bearer(req.header('authorization'));
    if (given.length === 0 || given.length > 256 || !safeEqual(given, secret)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    next();
  });

  app.get('/internal/admin/webhook-blocklist', (_req, res) => {
    sendJson(res, 200, davidStore.webhookBlocklist.list());
  });
  app.post('/internal/admin/webhook-blocklist', express.json({ limit: '8kb' }), (req, res) => {
    try { sendJson(res, 200, davidStore.webhookBlocklist.add(req.body, jid => store.phoneForJid(jid))); }
    catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' }); }
  });
  app.post('/internal/admin/webhook-blocklist/remove', express.json({ limit: '2kb' }), (req, res) => {
    try {
      if (typeof req.body?.identifier !== 'string') throw new Error('identifier is required');
      sendJson(res, 200, davidStore.webhookBlocklist.remove(req.body.identifier, jid => store.phoneForJid(jid)));
    } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' }); }
  });

  // Internal transport used exclusively by the authenticated dashboard. No MCP action.
  app.post('/internal/admin/webhook-blocklist/purge', express.json({ limit: '2kb' }), (req, res) => {
    try {
      if (typeof req.body?.identifier !== 'string') throw new Error('identifier is required');
      sendJson(res, 200, davidStore.webhookBlocklist.purge(req.body.identifier, req.body.confirmation));
    } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' }); }
  });

  app.get('/internal/admin/overview', (_req, res) => {
    try {
      const counts = store.overviewCounts();
      sendJson(res, 200, {
        chats: counts.chats,
        messages: counts.messages,
        activity: store.recentActivity(8),
        assistant: assistantCounts(davidStore, aibmGroupJid),
      });
    } catch {
      sendJson(res, 500, { error: 'Unavailable' });
    }
  });

  app.get('/internal/admin/chats', (_req, res) => {
    try {
      sendJson(res, 200, { chats: store.listChats(200) });
    } catch {
      sendJson(res, 500, { error: 'Unavailable' });
    }
  });

  app.get('/internal/admin/messages', (req, res) => {
    const jid = queryString(req.query.jid);
    if (!JID.test(jid)) {
      sendJson(res, 400, { error: 'Bad request' });
      return;
    }
    const offset = Math.max(0, Math.min(Number.parseInt(queryString(req.query.offset), 10) || 0, 10_000));
    const query = queryString(req.query.q).trim();
    if (query.length > 80) {
      sendJson(res, 400, { error: 'Bad request' });
      return;
    }
    try {
      if (query) {
        const page = store.searchMessages(query, { chat: jid, limit: PAGE_SIZE, offset });
        sendJson(res, 200, {
          searching: true,
          hits: page.messages.map((message) => ({
            timestamp: message.timestamp,
            snippet: clip(message.snippet, 200),
          })),
          ...(page.nextOffset != null ? { nextOffset: page.nextOffset } : {}),
        });
        return;
      }
      const page = store.listMessages(jid, PAGE_SIZE, offset);
      sendJson(res, 200, {
        searching: false,
        ...(page.name ? { name: clip(page.name, 200) } : {}),
        messages: page.messages.map((message) => ({
          timestamp: message.timestamp ?? null,
          fromMe: message.fromMe ?? null,
          text: clip(message.text ?? '', 8000),
        })),
        ...(page.nextOffset != null ? { nextOffset: page.nextOffset } : {}),
      });
    } catch {
      sendJson(res, 500, { error: 'Unavailable' });
    }
  });

  app.get('/internal/admin/activity', (_req, res) => {
    try {
      sendJson(res, 200, { activity: store.recentActivity(40) });
    } catch {
      sendJson(res, 500, { error: 'Unavailable' });
    }
  });

  app.get('/internal/admin/stats', (_req, res) => {
    try {
      sendJson(res, 200, { groups: store.messageStats(14) });
    } catch {
      sendJson(res, 500, { error: 'Unavailable' });
    }
  });

  app.get('/internal/admin/requests', (_req, res) => {
    try {
      sendJson(res, 200, { calls: store.listMcpCalls(100) });
    } catch {
      sendJson(res, 500, { error: 'Unavailable' });
    }
  });

  app.get('/internal/admin/context', (_req, res) => {
    try {
      sendJson(res, 200, contextPayload(davidStore, aibmGroupJid, pace));
    } catch {
      sendJson(res, 500, { error: 'Unavailable' });
    }
  });

  app.get('/internal/admin/style', (_req, res) => {
    try {
      sendJson(res, 200, readStyle((key) => davidStore.getSetting(key)));
    } catch {
      sendJson(res, 500, { error: 'Unavailable' });
    }
  });

  app.put('/internal/admin/style', express.json({ limit: '32kb' }), (req, res) => {
    const parsed = parseStyleBody(req.body);
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }
    try {
      davidStore.saveStyleKeys(styleSettingRows(parsed.value));
      sendJson(res, 200, { ok: true, style: readStyle((key) => davidStore.getSetting(key)) });
    } catch {
      sendJson(res, 500, { error: 'Unavailable' });
    }
  });

  app.get('/internal/admin/approved-contacts', (_req, res) => {
    try {
      sendJson(res, 200, approvedAdminView(davidStore, new Date(), timezone));
    } catch {
      sendJson(res, 500, { error: 'Unavailable' });
    }
  });

  app.post('/internal/admin/approved-contacts', express.json({ limit: '32kb' }), (req, res) => {
    const parsed = parseApprovedAdd(req.body);
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }
    const resolve = options.resolveContact ?? (async () => ({ ok: false as const, error: 'Contact resolution is not available on this process.' }));
    void addApprovedContact({
      store: davidStore,
      identifier: parsed.value.identifier,
      displayName: parsed.value.displayName,
      note: parsed.value.note,
      addedBy: parsed.value.addedBy,
      now: new Date(),
      timeZone: timezone,
      resolve,
      log,
    }).then((result) => {
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return;
      }
      sendJson(res, 200, { ok: true, contact: result.contact, ...approvedAdminView(davidStore, new Date(), timezone) });
    }).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'Unavailable' });
    });
  });

  app.post('/internal/admin/approved-contacts/remove', express.json({ limit: '8kb' }), (req, res) => {
    const identifier = typeof req.body?.identifier === 'string' ? req.body.identifier.trim() : '';
    if (!identifier || identifier.length > 128) {
      sendJson(res, 400, { error: 'identifier is required.' });
      return;
    }
    try {
      const result = removeApprovedContact({
        store: davidStore,
        identifier,
        actor: 'dashboard',
        now: new Date(),
        timeZone: timezone,
        log,
      });
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return;
      }
      sendJson(res, 200, { ok: true, jid: result.jid });
    } catch {
      sendJson(res, 500, { error: 'Unavailable' });
    }
  });

  app.put('/internal/admin/approved-contacts/cap', express.json({ limit: '4kb' }), (req, res) => {
    const value = coldPerDayField(req.body);
    if (value == null) {
      sendJson(res, 400, { error: 'cold_per_day must be an integer from 0 to 100.' });
      return;
    }
    try {
      const saved = setColdCap(davidStore, value, log);
      if (!saved.ok) {
        sendJson(res, 400, { error: saved.error });
        return;
      }
      sendJson(res, 200, { ok: true, ...approvedAdminView(davidStore, new Date(), timezone) });
    } catch {
      sendJson(res, 500, { error: 'Unavailable' });
    }
  });
}

function parseApprovedAdd(body: unknown): { ok: true; value: { identifier: string; displayName: string; note: string; addedBy: string } } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Expected a JSON object.' };
  const record = body as Record<string, unknown>;
  const identifier = typeof record.identifier === 'string' ? record.identifier.trim() : '';
  const displayName = typeof record.displayName === 'string' ? record.displayName.trim() : '';
  const note = typeof record.note === 'string' ? record.note.trim() : '';
  const addedBy = typeof record.addedBy === 'string' ? record.addedBy.trim() : '';
  if (!identifier || identifier.length > 128) return { ok: false, error: 'Use a phone number, a @s.whatsapp.net JID, or a @lid JID.' };
  if (displayName.length > 80) return { ok: false, error: 'display_name must be 80 characters or less.' };
  if (!note || note.length > 300) return { ok: false, error: 'A reason is required (300 characters or less).' };
  if (!addedBy || addedBy.length > 80) return { ok: false, error: 'added_by is required (80 characters or less).' };
  return { ok: true, value: { identifier, displayName, note, addedBy } };
}

function coldPerDayField(body: unknown): number | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>).coldPerDay;
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value;
}

export type { ApprovedAdminView };

function assistantCounts(davidStore: DavidStore, aibmGroupJid: string): {
  quiet: string;
  aibmGroupJid: string;
  openEscalations: number;
  codeInFlight: number;
  deflections: number;
} {
  return {
    quiet: clip(davidStore.getSetting('quiet') ?? 'off', 32),
    aibmGroupJid: clip(aibmGroupJid, 98),
    openEscalations: davidStore.countEscalations(['open', 'awaiting_owner']),
    codeInFlight: davidStore.countCode(['pending', 'acked']),
    deflections: davidStore.deflectionCount(),
  };
}

function contextPayload(davidStore: DavidStore, aibmGroupJid: string, pace?: () => PaceStatus) {
  return {
    ...assistantCounts(davidStore, aibmGroupJid),
    unsentOutbox: davidStore.unsentCount(),
    outbox: davidStore.listRecentOutbox(30).map((row) => ({
      id: row.id,
      chatId: clip(row.chatId, 98),
      messageId: clip(row.messageId, 128),
      enqueuedAt: row.enqueuedAt,
      sentAt: row.sentAt,
      type: clip(row.type, 40),
      hint: row.hint ? clip(row.hint, 40) : null,
      text: clip(row.text, 240),
    })),
    pace: paceSnapshot(pace),
    escalations: davidStore.listRecentEscalations(40).map((row) => ({
      issuedAt: row.issuedAt,
      status: clip(row.status, 40),
      type: clip(row.type, 40),
      chatId: clip(row.chatId, 98),
      summary: clip(row.summary, 500),
      suggestedAction: clip(row.suggestedAction, 500),
      excerpt: clip(row.context.raw_excerpt, 240),
      decision: row.decision ? clip(row.decision, 40) : null,
      note: row.note ? clip(row.note, 300) : null,
      resolvedVia: row.resolvedVia ? clip(row.resolvedVia, 40) : null,
      secretaryPostedAt: row.secretaryPostedAt,
      ownerDmAt: row.ownerDmAt,
      requesterPhone: clip(row.requesterPhone, 32),
    })),
    codeRequests: davidStore.listRecentCodes(40).map((row) => ({
      updatedAt: row.updatedAt,
      status: clip(row.status, 40),
      repo: clip(row.repo, 120),
      ask: clip(row.ask, 500),
      prUrl: row.prUrl ? clip(row.prUrl, 300) : null,
      summary: row.summary ? clip(row.summary, 300) : null,
      requesterPhone: clip(row.requesterPhone, 32),
      chatId: clip(row.chatId, 98),
    })),
    allowlist: davidStore.listAllowlist().slice(0, 200).map((entry) => ({
      phone: clip(entry.phone, 32),
      repos: entry.repos.slice(0, 20).map((repo) => clip(repo, 80)),
    })),
    deflectionLog: davidStore.listDeflections(30).map((row) => ({
      at: row.at,
      chatId: clip(row.chatId, 98),
      requesterPhone: clip(row.requesterPhone, 32),
      summary: clip(row.summary, 300),
    })),
  };
}

function paceSnapshot(read: (() => PaceStatus) | undefined): PaceStatus {
  const raw = read?.() ?? { queued: 0, sentLastMinute: 0, sentLastHour: 0 };
  return {
    queued: finiteCount(raw?.queued),
    sentLastMinute: finiteCount(raw?.sentLastMinute),
    sentLastHour: finiteCount(raw?.sentLastHour),
  };
}

function finiteCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(1_000_000, Math.floor(value));
}
