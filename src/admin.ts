import type { BlocklistView } from './webhook-blocklist.js';
import { createHmac } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
  createDavidPeer,
  type AdminActivity,
  type AdminCall,
  type AdminChat,
  type AdminCodeRequest,
  type AdminContext,
  type AdminEscalation,
  type AdminPace,
  type AdminMessage,
  type AdminMessages,
  type AdminSearchHit,
  type AdminStatsGroup,
  type AdminApproved,
  type AdminStyle,
  type AssistantSummary,
  type DavidPeer,
  type PeerFailureReason,
} from './admin-peer.js';
import { safeEqual, strongSecret } from './admin-secret.js';
import { styleErrorText, styleUpdateFromForm } from './david/style.js';
import type { MemoryStore } from './store.js';

const COOKIE = 'wa_admin';
const PAGE_SIZE = 30;
const failures = new Map<string, number[]>();

type AccountView = 'personal' | 'david' | 'all';
type AccountId = 'personal' | 'david';

type View = {
  account: AccountView;
  path: string;
  keep: Record<string, string>;
};

type TaggedActivity = AdminActivity & { account: AccountId };
type TaggedChat = AdminChat & { account: AccountId };
type TaggedStats = AdminStatsGroup & { account: AccountId };
type TaggedCall = AdminCall & { account: AccountId };

function sessionToken(secret: string): string {
  return createHmac('sha256', secret).update('whatsapp-bridge-admin-v1').digest('base64url');
}

function readCookie(header: string | undefined, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const eq = part.trim().indexOf('=');
    if (eq === -1) continue;
    if (part.trim().slice(0, eq) === name) return decodeURIComponent(part.trim().slice(eq + 1));
  }
  return '';
}

function clientIp(req: Request): string {
  return (req.ip || req.socket.remoteAddress || 'unknown').slice(0, 64);
}

function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (failures.get(ip) ?? []).filter((at) => now - at < 15 * 60 * 1000);
  failures.set(ip, recent);
  return recent.length >= 8;
}

function markFailure(ip: string): void {
  const recent = failures.get(ip) ?? [];
  recent.push(Date.now());
  failures.set(ip, recent.slice(-8));
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function formatTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  return `${new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

function formatIso(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

function validJid(jid: string): boolean {
  return /^[0-9A-Za-z._-]{1,64}@[A-Za-z0-9._-]{1,32}$/.test(jid);
}

function accountOf(req: Request): AccountView {
  const raw = req.query.account;
  if (raw === 'david' || raw === 'all') return raw;
  return 'personal';
}

function viewFor(req: Request, path: string, keep: Record<string, string> = {}): View {
  return { account: accountOf(req), path, keep };
}

function withAccount(path: string, account: AccountView, keep: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(keep)) {
    if (value) params.set(key, value);
  }
  if (account !== 'personal') params.set('account', account);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function switchHref(path: string, account: AccountView, keep: Record<string, string>): string {
  if (path === '/admin/david') {
    if (account === 'david') return '/admin?account=david';
    if (account === 'all') return '/admin?account=all';
    return '/admin';
  }
  return withAccount(path, account, keep);
}

function navHtml(account: AccountView, path: string): string {
  const link = (hrefPath: string, label: string) => {
    const href = hrefPath === '/admin/david' ? '/admin/david' : withAccount(hrefPath, account);
    const on = path === hrefPath ? ' class="on"' : '';
    return `<a href="${escapeHtml(href)}"${on}>${label}</a>`;
  };
  return `<nav>${link('/admin', 'Overview')} ${link('/admin/chats', 'Chats')} ${link('/admin/activity', 'Activity')} ${link('/admin/stats', 'Stats')} ${link('/admin/requests', 'Requests')} ${link('/admin/david', 'Assistant')} <a href="/admin/logout">Log out</a></nav>`;
}

function switcherHtml(view: View): string {
  const item = (account: AccountView, label: string) => {
    const on = account === view.account ? ' class="on"' : '';
    return `<a href="${escapeHtml(switchHref(view.path, account, view.keep))}"${on}>${label}</a>`;
  };
  return `<p class="switch"><span class="muted">Account</span> ${item('personal', 'Personal')}${item('david', 'David')}${item('all', 'All')}</p>`;
}

function page(title: string, body: string, authed: boolean, view?: View): string {
  const nav = authed ? navHtml(view?.account ?? 'personal', view?.path ?? '/admin') : '';
  const switcher = authed ? switcherHtml(view ?? { account: 'personal', path: '/admin', keep: {} }) : '';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>
    body{font:15px system-ui,sans-serif;margin:0;background:#f4f6f8;color:#17202a}
    header,main{max-width:68rem;margin:0 auto;padding:1rem 1.2rem}
    header{background:#17202a;color:white}
    header a{color:white;margin-right:.8rem}
    header a.on{text-decoration:underline}
    table{border-collapse:collapse;width:100%;background:white}
    th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid #e4e7ea;vertical-align:top}
    input,button,textarea{font:inherit;padding:.4rem .6rem}
    textarea{width:100%;max-width:40rem;box-sizing:border-box;min-height:4.2rem}
    form.stack{margin:0 0 1.2rem}
    .switch a{display:inline-block;margin:0 .35rem .35rem 0;padding:.15rem .6rem;border-radius:999px;background:#e4e7ea;color:#17202a;text-decoration:none}
    .switch .muted{margin-right:.35rem}
    .switch a.on{background:#17202a;color:#fff}
    .muted{color:#56616b}
    .err{color:#8a1f1f}
    .banner{background:#fff4f4;border:1px solid #e7c7c7;padding:.6rem .8rem;margin:.6rem 0}
  </style><header><strong>WhatsApp admin</strong> ${nav}</header><main>${switcher}${body}</main></html>`;
}

function guard(res: Response): void {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
}

function send(res: Response, status: number, title: string, body: string, authed: boolean, view?: View): void {
  guard(res);
  res.status(status).type('html').send(page(title, body, authed, view));
}

function authed(req: Request, secret: string): boolean {
  const header = req.header('authorization') ?? '';
  if (header.startsWith('Bearer ') && safeEqual(header.slice('Bearer '.length).trim(), secret)) return true;
  return safeEqual(readCookie(req.header('cookie'), COOKIE), sessionToken(secret));
}

function loginForm(failed: boolean): string {
  return `<h1>Admin login</h1><p class="muted">Read-only view of this service's saved history. Sending is unavailable. Stored blocklisted messages can be purged after confirmation on the Assistant page.</p>${failed ? '<p class="err">Login failed.</p>' : ''}<form method="post" action="/admin/login"><label>Admin secret<br><input name="secret" type="password" autocomplete="current-password" required></label><br><button type="submit">Continue</button></form>`;
}

function davidNote(reason: PeerFailureReason): string {
  const detail: Record<PeerFailureReason, string> = {
    unconfigured: 'DAVID_READ_SECRET is not set on this service, so David is not queried.',
    unavailable: 'The read API did not respond.',
    unauthorized: 'David rejected the read secret.',
    disabled: 'David did not enable the read API. Set the same DAVID_READ_SECRET on the David service and recreate it.',
    forbidden: 'David rejected the Host header. ALLOWED_HOSTS on David must include david.',
    invalid: 'David rejected the style settings.',
  };
  return `<div class="banner"><p class="err">David unavailable.</p><p class="muted">${detail[reason]}</p></div>`;
}

function accountLabel(account: AccountId): string {
  return account === 'david' ? 'David' : 'Personal';
}

function accountCells(account: AccountId, show: boolean): string {
  return show ? `<td>${accountLabel(account)}</td>` : '';
}

function chatLink(account: AccountId, jid: string, label: string): string {
  if (!validJid(jid)) return escapeHtml(label);
  return `<a href="${escapeHtml(withAccount('/admin/messages', account, { jid }))}">${escapeHtml(label)}</a>`;
}

function httpsHref(value: string | null): string {
  if (!value || !/^https:\/\/[^\s<>"']+$/.test(value)) return escapeHtml(value ?? '');
  return `<a href="${escapeHtml(value)}">${escapeHtml(value)}</a>`;
}

function tagActivity(account: AccountId, row: AdminActivity): TaggedActivity {
  return { account, ...row };
}

function mergeByTime<T>(rows: T[], limit: number, time: (row: T) => number | null): T[] {
  return [...rows].sort((a, b) => (time(b) ?? 0) - (time(a) ?? 0)).slice(0, limit);
}

/** Admin HTML and account-local settings. Purge requires an explicit confirmation. */
export function mountAdmin(app: Express, options: {
  secret: string;
  store: MemoryStore;
  role: string;
  peer?: DavidPeer;
}): void {
  const { secret, store, role } = options;
  const peer = options.peer ?? createDavidPeer({ secret: '', baseUrl: 'http://127.0.0.1:9' });
  if (!strongSecret(secret)) {
    console.log(`[whatsapp-bridge:${role}] Admin UI disabled. Set ADMIN_SECRET to a random string of at least 24 characters to serve /admin.`);
    return;
  }
  console.log(`[whatsapp-bridge:${role}] Admin UI enabled at /admin`);

  app.get('/admin/login', (req, res) => {
    if (authed(req, secret)) { res.redirect(302, '/admin'); return; }
    send(res, 200, 'Admin login', loginForm(false), false);
  });

  app.post('/admin/login', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    const ip = clientIp(req);
    if (limited(ip)) { send(res, 429, 'Too many attempts', '<h1>Try again later</h1>', false); return; }
    const given = typeof req.body?.secret === 'string' ? req.body.secret : '';
    if (given.length > 256 || !safeEqual(given, secret)) {
      markFailure(ip);
      send(res, 401, 'Admin login', loginForm(true), false);
      return;
    }
    const secure = req.secure || req.header('x-forwarded-proto') === 'https' ? '; Secure' : '';
    guard(res);
    res.set('Set-Cookie', `${COOKIE}=${sessionToken(secret)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=43200${secure}`);
    res.redirect(302, '/admin');
  });

  app.get('/admin/logout', (_req, res) => {
    guard(res);
    res.set('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
    res.redirect(302, '/admin/login');
  });

  function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    if (authed(req, secret)) { next(); return; }
    const acceptsHtml = (req.header('accept') ?? '').includes('text/html');
    if (req.method === 'GET' && acceptsHtml) { guard(res); res.redirect(302, '/admin/login'); return; }
    guard(res);
    res.status(401).json({ error: 'Unauthorized' });
  }

  app.use('/admin', requireAdmin);

  app.get('/admin', (req, res) => {
    const view = viewFor(req, '/admin');
    void finish(res, view, 'Overview', () => overviewBody(view));
  });

  app.get('/admin/chats', (req, res) => {
    const view = viewFor(req, '/admin/chats');
    void finish(res, view, 'Chats', () => chatsBody(view));
  });

  app.get('/admin/messages', (req, res) => {
    const jid = typeof req.query.jid === 'string' ? req.query.jid : '';
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const keep: Record<string, string> = {};
    if (validJid(jid)) keep.jid = jid;
    if (query && query.length <= 80) keep.q = query;
    const view = viewFor(req, '/admin/messages', keep);
    if (!validJid(jid)) { send(res, 400, 'Messages', '<h1>Choose a chat from the list.</h1>', true, view); return; }
    if (query.length > 80) { send(res, 400, 'Messages', '<h1>Search must be 80 characters or less.</h1>', true, view); return; }
    const offset = Math.max(0, Math.min(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 10_000));
    void finish(res, view, 'Messages', () => messagesBody(view, jid, offset, query));
  });

  app.get('/admin/activity', (req, res) => {
    const view = viewFor(req, '/admin/activity');
    void finish(res, view, 'Activity', () => activityBody(view));
  });

  app.get('/admin/stats', (req, res) => {
    const view = viewFor(req, '/admin/stats');
    void finish(res, view, 'Stats', () => statsBody(view));
  });

  app.get('/admin/requests', (req, res) => {
    const view = viewFor(req, '/admin/requests');
    void finish(res, view, 'Requests', () => requestsBody(view));
  });

  app.get('/admin/david', (req, res) => {
    const view = viewFor(req, '/admin/david');
    view.account = 'david';
    const notice = davidNotices(req);
    void finish(res, view, 'David', () => assistantBody(notice));
  });

  app.post('/admin/david/style', express.urlencoded({ extended: false, limit: '48kb' }), (req, res) => {
    const view = viewFor(req, '/admin/david');
    view.account = 'david';
    const parsed = styleUpdateFromForm(req.body);
    if (!parsed.ok) {
      void finish(res, view, 'David', () => assistantBody(`<p class="err">${escapeHtml(styleErrorText(parsed.error))}</p>`));
      return;
    }
    void (async () => {
      const saved = await peer.saveStyle(parsed.value);
      if (!saved.ok) {
        const detail = saved.detail ? styleErrorText(saved.detail) : '';
        const message = detail
          ? `<p class="err">${escapeHtml(detail)}</p>`
          : davidNote(saved.reason);
        send(res, 200, 'David', await assistantBody(message), true, view);
        return;
      }
      guard(res);
      res.redirect(302, '/admin/david?saved=1');
    })().catch(() => {
      if (!res.headersSent) send(res, 500, 'David', '<h1>Could not save style settings.</h1>', true, view);
    });
  });

  app.get('/admin/david/webhook-blocklist', (req, res) => {
    void (async () => {
      guard(res);
      const account = req.query.account ?? 'personal';
      if (account === 'personal') { res.json(store.webhookBlocklist.list()); return; }
      if (account !== 'david') { res.status(400).json({ error: 'Choose an account.' }); return; }
      const result = await peer.blocklist();
      if (!result.ok) { res.status(503).json({ error: 'David unavailable.' }); return; }
      res.json(result.data);
    })().catch(() => { if (!res.headersSent) res.status(503).json({ error: 'Unavailable' }); });
  });

  // Confirmation is signed for this exact account, entry, and a short expiry.
  const purgeToken = (account: string, identifier: string, expires: string) =>
    createHmac('sha256', secret).update(JSON.stringify(['purge', account, identifier, expires])).digest('hex');
  app.post('/admin/david/webhook-blocklist/purge', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    void (async () => {
      const account = req.body?.account;
      const identifier = formField(req.body, 'identifier', 128);
      if ((account !== 'personal' && account !== 'david') || !identifier || formTooLong(req.body, 'identifier', 128)) throw new Error('Choose an account and entry.');
      const entries = account === 'personal' ? store.webhookBlocklist.list().entries : (await peer.blocklist());
      const rows = Array.isArray(entries) ? entries : entries.ok ? entries.data.entries : [];
      const entry = rows.find(row => row.jid === identifier);
      if (!entry) throw new Error('Blocklist entry unavailable.');
      if (!req.body?.confirmation) {
        const expires = String(Date.now() + 300_000);
        send(res, 200, 'Confirm purge', `<h1>Confirm stored-message purge</h1><p>Account: ${escapeHtml(account)}. Entry: ${escapeHtml(identifier)}.</p><p>This permanently removes ${entry.stored_count ?? 0} inbound message rows and ${entry.event_count ?? 0} Secretary event rows from this account. New matching rows present at confirmation are included. WhatsApp itself and outbound messages are unchanged.</p><form method="post" action="/admin/david/webhook-blocklist/purge"><input type="hidden" name="account" value="${account}"><input type="hidden" name="identifier" value="${escapeHtml(identifier)}"><input type="hidden" name="expires" value="${expires}"><input type="hidden" name="token" value="${purgeToken(account, identifier, expires)}"><button name="confirmation" value="PURGE">Permanently purge</button></form><a href="/admin/david">Cancel</a>`, true, viewFor(req, '/admin/david'));
        return;
      }
      const expires = formField(req.body, 'expires', 20);
      const token = formField(req.body, 'token', 64);
      if (formTooLong(req.body, 'expires', 20) || formTooLong(req.body, 'token', 64) || req.body.confirmation !== 'PURGE' || !Number.isFinite(Number(expires)) || Number(expires) < Date.now() || Number(expires) > Date.now() + 300_000 || !safeEqual(token, purgeToken(account, identifier, expires))) throw new Error('Valid purge confirmation is required.');
      if (account === 'personal') store.webhookBlocklist.purge(identifier, 'PURGE');
      else {
        const result = await peer.purgeBlocklist(identifier, 'PURGE');
        if (!result.ok) throw new Error(result.detail || `David: ${result.reason}`);
      }
      guard(res);
      res.redirect(302, '/admin/david');
    })().catch(() => send(res, 400, 'Purge unavailable', '<h1>Purge failed</h1><p>A valid account, entry and confirmation are required. Reload the Assistant page to try again.</p>', true, viewFor(req, '/admin/david')));
  });

  app.post('/admin/david/webhook-blocklist/:operation', express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => {
    void (async () => {
      const account = req.body?.account;
      if (account !== 'personal' && account !== 'david') throw new Error('Choose an account.');
      const identifier = formField(req.body, 'identifier', 128);
      const input = { identifier, name: formField(req.body, 'name', 80), note: formField(req.body, 'note', 300), approved_by: formField(req.body, 'approved_by', 80), reason: formField(req.body, 'reason', 300) };
      for (const [key, max] of [['identifier',128], ['name',80], ['note',300], ['approved_by',80], ['reason',300]] as const) {
        if (formTooLong(req.body, key, max)) throw new Error(`${key} is too long.`);
      }
      if (req.params.operation !== 'add' && req.params.operation !== 'remove') throw new Error('Invalid operation.');
      if (account === 'personal') {
        const lookup = (jid: string) => store.phoneForJid(jid);
        if (req.params.operation === 'add') store.webhookBlocklist.add(input, lookup);
        else store.webhookBlocklist.remove(identifier, lookup);
      } else {
        const result = req.params.operation === 'add' ? await peer.addBlocklist(input) : await peer.removeBlocklist(identifier);
        if (!result.ok) throw new Error(result.detail || `David: ${result.reason}`);
      }
      guard(res);
      res.redirect(302, '/admin/david');
    })().catch(error => send(res, 400, 'Webhook blocklist', `<h1>Could not update webhook blocklist</h1><p>${escapeHtml(error instanceof Error ? error.message : 'Unavailable')}</p>`, true, viewFor(req, '/admin/david')));
  });

  app.post('/admin/david/approved-contacts', express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => {
    const view = viewFor(req, '/admin/david');
    view.account = 'david';
    const identifier = formField(req.body, 'identifier', 128);
    const displayName = formField(req.body, 'display_name', 80);
    const note = formField(req.body, 'note', 300);
    if (!identifier || !note || formTooLong(req.body, 'identifier', 128) || formTooLong(req.body, 'display_name', 80) || formTooLong(req.body, 'note', 300)) {
      void finish(res, view, 'David', () => assistantBody('<p class="err">Enter a phone, JID, or LID, and a note of at most 300 characters.</p>'));
      return;
    }
    void (async () => {
      const saved = await peer.addApproved({ identifier, displayName, note });
      if (!saved.ok) {
        send(res, 200, 'David', await assistantBody(peerErrorHtml(saved)), true, view);
        return;
      }
      guard(res);
      res.redirect(302, '/admin/david?approved=1');
    })().catch(() => {
      if (!res.headersSent) send(res, 500, 'David', '<h1>Could not save the approved contact.</h1>', true, view);
    });
  });

  app.post('/admin/david/approved-contacts/remove', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    const view = viewFor(req, '/admin/david');
    view.account = 'david';
    const identifier = formField(req.body, 'identifier', 128);
    if (!identifier) {
      void finish(res, view, 'David', () => assistantBody('<p class="err">Choose a contact to remove.</p>'));
      return;
    }
    void (async () => {
      const saved = await peer.removeApproved(identifier);
      if (!saved.ok) {
        send(res, 200, 'David', await assistantBody(peerErrorHtml(saved)), true, view);
        return;
      }
      guard(res);
      res.redirect(302, '/admin/david?removed=1');
    })().catch(() => {
      if (!res.headersSent) send(res, 500, 'David', '<h1>Could not remove the approved contact.</h1>', true, view);
    });
  });

  app.post('/admin/david/approved-cap', express.urlencoded({ extended: false, limit: '1kb' }), (req, res) => {
    const view = viewFor(req, '/admin/david');
    view.account = 'david';
    const raw = formField(req.body, 'cold_per_day', 3);
    const value = /^\d{1,3}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      void finish(res, view, 'David', () => assistantBody('<p class="err">Cold sends per day must be an integer from 0 to 100.</p>'));
      return;
    }
    void (async () => {
      const saved = await peer.saveApprovedCap(value);
      if (!saved.ok) {
        send(res, 200, 'David', await assistantBody(peerErrorHtml(saved)), true, view);
        return;
      }
      guard(res);
      res.redirect(302, '/admin/david?cap=1');
    })().catch(() => {
      if (!res.headersSent) send(res, 500, 'David', '<h1>Could not save the cold-send cap.</h1>', true, view);
    });
  });

  async function finish(res: Response, view: View, title: string, work: () => Promise<string>): Promise<void> {
    try {
      send(res, 200, title, await work(), true, view);
    } catch {
      if (!res.headersSent) send(res, 500, title, '<h1>Could not read the store.</h1>', true, view);
    }
  }

  function localActivity(limit: number): TaggedActivity[] {
    return store.recentActivity(limit).map((row) => tagActivity('personal', row));
  }

  function localChats(): TaggedChat[] {
    return store.listChats(200).map((chat) => ({ account: 'personal', ...chat }));
  }

  function localStats(): TaggedStats[] {
    return store.messageStats(14).map((group) => ({ account: 'personal', ...group }));
  }

  function localCalls(): TaggedCall[] {
    return store.listMcpCalls(100).map((call) => ({ account: 'personal', ...call }));
  }

  async function overviewBody(view: View): Promise<string> {
    const localCounts = store.overviewCounts();
    const local = localActivity(8);
    if (view.account === 'personal') {
      return `<h1>${escapeHtml(role)}</h1><p>${localCounts.chats} chats, ${localCounts.messages} messages. This page only reads the local store.</p>${recentTable(local, false)}`;
    }
    const remote = await peer.overview();
    if (view.account === 'david') {
      if (!remote.ok) return `<h1>david</h1>${davidNote(remote.reason)}`;
      const rows = remote.data.activity.map((row) => tagActivity('david', row));
      return `<h1>david</h1><p>David: ${remote.data.chats} chats, ${remote.data.messages} messages. Read from the David service. Sending is unavailable. Stored blocklisted messages can be purged after confirmation on the Assistant page.</p>${assistantLine(remote.data.assistant)}${recentTable(rows, true)}`;
    }
    const note = remote.ok ? '' : davidNote(remote.reason);
    const davidLine = remote.ok ? `<p>David: ${remote.data.chats} chats, ${remote.data.messages} messages.</p>` : '';
    const rows = mergeByTime(
      [...local, ...(remote.ok ? remote.data.activity.map((row) => tagActivity('david', row)) : [])],
      8,
      (row) => row.timestamp,
    );
    return `<h1>all accounts</h1>${note}<p>Personal: ${localCounts.chats} chats, ${localCounts.messages} messages.</p>${davidLine}${remote.ok ? assistantLine(remote.data.assistant) : ''}<p class="muted">Personal is this process. David is fetched read-only. Sending is unavailable. Stored blocklisted messages can be purged after confirmation on the Assistant page.</p>${recentTable(rows, true)}`;
  }

  async function chatsBody(view: View): Promise<string> {
    if (view.account === 'personal') return `<h1>Chats</h1>${chatsTable(localChats(), false)}`;
    const remote = await peer.chats();
    if (view.account === 'david') {
      if (!remote.ok) return `<h1>Chats</h1>${davidNote(remote.reason)}`;
      return `<h1>Chats</h1>${chatsTable(remote.data.map((chat) => ({ account: 'david', ...chat })), true)}`;
    }
    const note = remote.ok ? '' : davidNote(remote.reason);
    const rows = mergeByTime(
      [...localChats(), ...(remote.ok ? remote.data.map((chat) => ({ account: 'david' as const, ...chat })) : [])],
      400,
      (row) => row.conversationTimestamp ?? null,
    );
    return `<h1>Chats</h1>${note}${chatsTable(rows, true)}`;
  }

  async function messagesBody(view: View, jid: string, offset: number, query: string): Promise<string> {
    if (view.account === 'all') {
      const personal = await oneChat('personal', jid, offset, query);
      const remote = await peer.messages(jid, offset, query);
      const david = remote.ok
        ? `<h2>David</h2>${chatSection('david', jid, offset, query, remote.data)}`
        : `<h2>David</h2>${davidNote(remote.reason)}`;
      return `<h1>${escapeHtml(jid)}</h1>${personal}${david}`;
    }
    if (view.account === 'david') {
      const remote = await peer.messages(jid, offset, query);
      if (!remote.ok) return `<h1>${escapeHtml(jid)}</h1>${davidNote(remote.reason)}`;
      return chatSection('david', jid, offset, query, remote.data, true);
    }
    return chatSection('personal', jid, offset, query, personalMessages(jid, offset, query), true);
  }

  async function oneChat(account: AccountId, jid: string, offset: number, query: string): Promise<string> {
    return `<h2>${accountLabel(account)}</h2>${chatSection(account, jid, offset, query, personalMessages(jid, offset, query), false)}`;
  }

  async function activityBody(view: View): Promise<string> {
    const local = localActivity(40);
    if (view.account === 'personal') return `<h1>Recent activity</h1>${activityTable(local, false)}`;
    const remote = await peer.activity();
    if (view.account === 'david') {
      if (!remote.ok) return `<h1>Recent activity</h1>${davidNote(remote.reason)}`;
      return `<h1>Recent activity</h1>${activityTable(remote.data.map((row) => tagActivity('david', row)), true)}`;
    }
    const note = remote.ok ? '' : davidNote(remote.reason);
    const rows = mergeByTime(
      [...local, ...(remote.ok ? remote.data.map((row) => tagActivity('david', row)) : [])],
      40,
      (row) => row.timestamp,
    );
    return `<h1>Recent activity</h1>${note}${activityTable(rows, true)}`;
  }

  async function statsBody(view: View): Promise<string> {
    const intro = '<h1>Messages per chat and day</h1><p class="muted">Last 14 days, UTC. Counts only.</p>';
    if (view.account === 'personal') return `${intro}${statsTable(localStats(), false)}`;
    const remote = await peer.stats();
    if (view.account === 'david') {
      if (!remote.ok) return `${intro}${davidNote(remote.reason)}`;
      return `${intro}${statsTable(remote.data.map((group) => ({ account: 'david', ...group })), true)}`;
    }
    const note = remote.ok ? '' : davidNote(remote.reason);
    const rows = [...localStats(), ...(remote.ok ? remote.data.map((group) => ({ account: 'david' as const, ...group })) : [])]
      .sort((a, b) => b.total - a.total);
    return `${intro}${note}${statsTable(rows, true)}`;
  }

  async function requestsBody(view: View): Promise<string> {
    const intro = '<h1>Recent MCP calls</h1><p class="muted">Argument values are lengths or numbers. Message text is not stored here.</p>';
    if (view.account === 'personal') return `${intro}${callsTable(localCalls(), false)}`;
    const remote = await peer.requests();
    if (view.account === 'david') {
      if (!remote.ok) return `${intro}${davidNote(remote.reason)}`;
      return `${intro}${callsTable(remote.data.map((call) => ({ account: 'david', ...call })), true)}`;
    }
    const note = remote.ok ? '' : davidNote(remote.reason);
    const rows = mergeByTime(
      [...localCalls(), ...(remote.ok ? remote.data.map((call) => ({ account: 'david' as const, ...call })) : [])],
      100,
      (row) => row.at,
    );
    return `${intro}${note}${callsTable(rows, true)}`;
  }

  async function assistantBody(notice = ''): Promise<string> {
    const remote = await peer.context();
    const remoteBlocklist = await peer.blocklist();
    const blockHtml = '<h2>Webhook blocklist</h2><p>Drops new inbound messages before storage and forwarding, including group messages and history sync. Existing rows remain until explicitly purged. WhatsApp receive, read and send behavior stays the same.</p>' + blocklistSection('personal', store.webhookBlocklist.list()) + (remoteBlocklist.ok ? blocklistSection('david', remoteBlocklist.data) : davidNote(remoteBlocklist.reason));
    const intro = '<h1>David assistant</h1><p class="muted">Escalations, code-agent callbacks, the Secretary outbox, the paced send queue, the code allowlist, and deflections David already stores. Nothing here can send, resolve an escalation, or change the code allowlist. Style settings, approved contacts, and the cold-send cap are saved on David.</p>';
    if (!remote.ok) return `${intro}${notice}${blockHtml}${davidNote(remote.reason)}`;
    const style = await peer.style();
    const styleHtml = style.ok ? styleForm(style.data) : davidNote(style.reason);
    const approved = await peer.approved();
    const approvedHtml = approved.ok ? approvedSection(approved.data) : davidNote(approved.reason);
    return `${intro}${notice}${blockHtml}${approvedHtml}${styleHtml}${contextHtml(remote.data)}`;
  }

  function personalMessages(jid: string, offset: number, query: string): AdminMessages {
    if (query) {
      const pageResult = store.searchMessages(query, { chat: jid, limit: PAGE_SIZE, offset });
      return {
        searching: true,
        messages: [],
        hits: pageResult.messages.map((message) => ({ timestamp: message.timestamp, snippet: message.snippet })),
        ...(pageResult.nextOffset != null ? { nextOffset: pageResult.nextOffset } : {}),
      };
    }
    const pageResult = store.listMessages(jid, PAGE_SIZE, offset);
    return {
      searching: false,
      ...(pageResult.name ? { name: pageResult.name } : {}),
      messages: pageResult.messages.map((message) => ({
        timestamp: message.timestamp ?? null,
        fromMe: message.fromMe ?? null,
        text: message.text ?? '',
      })),
      hits: [],
      ...(pageResult.nextOffset != null ? { nextOffset: pageResult.nextOffset } : {}),
    };
  }
}

function assistantLine(summary: AssistantSummary | null): string {
  if (!summary) return '';
  const group = summary.aibmGroupJid ? escapeHtml(summary.aibmGroupJid) : 'no group configured';
  return `<p>Assistant: ${summary.openEscalations} open escalations, ${summary.codeInFlight} code requests in flight, quiet hours ${escapeHtml(summary.quiet || 'off')}, group ${group}. <a href="/admin/david">Full log</a></p>`;
}

function recentTable(rows: TaggedActivity[], showAccount: boolean): string {
  const head = `<tr><th>When</th>${showAccount ? '<th>Account</th>' : ''}<th>Chat</th><th>Snippet</th></tr>`;
  const body = rows.map((row) => `<tr><td>${escapeHtml(formatTime(row.timestamp))}</td>${accountCells(row.account, showAccount)}<td>${escapeHtml(row.name || row.jid)}</td><td>${escapeHtml(row.snippet)}</td></tr>`).join('');
  const span = showAccount ? 4 : 3;
  return `<h2>Recent</h2><table>${head}${body || `<tr><td colspan="${span}">No saved messages.</td></tr>`}</table>`;
}

function chatsTable(rows: TaggedChat[], showAccount: boolean): string {
  const head = `<tr>${showAccount ? '<th>Account</th>' : ''}<th>Name</th><th>JID</th><th>Unread</th><th>Last activity</th></tr>`;
  const body = rows.map((chat) => `<tr>${accountCells(chat.account, showAccount)}<td>${escapeHtml(chat.name || '')}</td><td>${chatLink(chat.account, chat.id, chat.id)}</td><td>${chat.unreadCount ?? 0}</td><td>${escapeHtml(formatTime(chat.conversationTimestamp))}</td></tr>`).join('');
  const span = showAccount ? 5 : 4;
  return `<table>${head}${body || `<tr><td colspan="${span}">No saved chats.</td></tr>`}</table>`;
}

function activityTable(rows: TaggedActivity[], showAccount: boolean): string {
  const head = `<tr><th>When</th>${showAccount ? '<th>Account</th>' : ''}<th>Chat</th><th></th><th>Snippet</th></tr>`;
  const body = rows.map((row) => `<tr><td>${escapeHtml(formatTime(row.timestamp))}</td>${accountCells(row.account, showAccount)}<td>${chatLink(row.account, row.jid, row.name || row.jid)}</td><td>${row.fromMe ? 'out' : 'in'}</td><td>${escapeHtml(row.snippet)}</td></tr>`).join('');
  const span = showAccount ? 5 : 4;
  return `<table>${head}${body || `<tr><td colspan="${span}">No saved messages.</td></tr>`}</table>`;
}

function statsTable(groups: TaggedStats[], showAccount: boolean): string {
  const head = `<tr>${showAccount ? '<th>Account</th>' : ''}<th>Name</th><th>JID</th><th>Total</th><th>Days</th></tr>`;
  const body = groups.map((group) => `<tr>${accountCells(group.account, showAccount)}<td>${escapeHtml(group.name || group.jid)}</td><td>${escapeHtml(group.jid)}</td><td>${group.total}</td><td>${group.days.map((day) => `${escapeHtml(day.date)}: ${day.messages}`).join('<br>')}</td></tr>`).join('');
  const span = showAccount ? 5 : 4;
  return `<table>${head}${body || `<tr><td colspan="${span}">No messages in this window.</td></tr>`}</table>`;
}

function callsTable(calls: TaggedCall[], showAccount: boolean): string {
  const head = `<tr><th>When</th>${showAccount ? '<th>Account</th>' : ''}<th>Tool</th><th>Action</th><th>Args</th><th>ms</th><th>Result</th></tr>`;
  const body = calls.map((call) => `<tr><td>${escapeHtml(formatTime(call.at))}</td>${accountCells(call.account, showAccount)}<td>${escapeHtml(call.tool)}</td><td>${escapeHtml(call.action || '')}</td><td>${escapeHtml(call.argsSummary)}</td><td>${call.durationMs}</td><td>${call.ok ? 'ok' : 'error'}</td></tr>`).join('');
  const span = showAccount ? 7 : 6;
  return `<table>${head}${body || `<tr><td colspan="${span}">No calls yet.</td></tr>`}</table>`;
}

function chatSection(account: AccountId, jid: string, offset: number, query: string, pageResult: AdminMessages, titled = false): string {
  const heading = titled ? `<h1>${escapeHtml(jid)}</h1>${pageResult.name ? `<p class="muted">${escapeHtml(pageResult.name)}</p>` : ''}` : '';
  const hiddenAccount = account === 'personal' ? '' : `<input type="hidden" name="account" value="${account}">`;
  const form = `<form method="get" action="/admin/messages"><input type="hidden" name="jid" value="${escapeHtml(jid)}">${hiddenAccount}<input name="q" value="${escapeHtml(query)}" maxlength="80" placeholder="Search this chat"><button type="submit">Search</button></form>`;
  const keep = { jid, ...(query ? { q: query } : {}) };
  const newer = offset > 0
    ? `<p><a href="${escapeHtml(withAccount('/admin/messages', account, { ...keep, offset: String(Math.max(0, offset - PAGE_SIZE)) }))}">Newer</a></p>`
    : '';
  const older = pageResult.nextOffset != null
    ? `<p><a href="${escapeHtml(withAccount('/admin/messages', account, { ...keep, offset: String(pageResult.nextOffset) }))}">Older</a></p>`
    : '';
  if (pageResult.searching) return `${heading}${form}${searchTable(pageResult.hits)}${newer}${older}`;
  return `${heading}${form}${messageTable(pageResult.messages)}${newer}${older}`;
}

function messageTable(messages: AdminMessage[]): string {
  const rows = [...messages].reverse().map((message) => `<tr><td>${escapeHtml(formatTime(message.timestamp))}</td><td>${message.fromMe ? 'out' : 'in'}</td><td>${escapeHtml(message.text)}</td></tr>`).join('');
  return `<table><tr><th>When</th><th></th><th>Text</th></tr>${rows || '<tr><td colspan="3">No messages.</td></tr>'}</table>`;
}

function searchTable(hits: AdminSearchHit[]): string {
  const rows = hits.map((hit) => `<tr><td>${escapeHtml(formatTime(hit.timestamp))}</td><td>${escapeHtml(hit.snippet)}</td></tr>`).join('');
  return `<table><tr><th>When</th><th>Text</th></tr>${rows || '<tr><td colspan="2">No messages.</td></tr>'}</table>`;
}

function davidNotices(req: Request): string {
  const lines = [
    req.query.saved === '1' ? 'Style saved on David.' : '',
    req.query.approved === '1' ? 'Approved contact saved on David.' : '',
    req.query.removed === '1' ? 'Approved contact removed.' : '',
    req.query.cap === '1' ? 'Cold-send cap saved.' : '',
  ].filter(Boolean);
  return lines.map((line) => `<p>${line}</p>`).join('');
}

function formField(body: unknown, key: string, max: number): string {
  if (!body || typeof body !== 'object') return '';
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? '' : trimmed;
}

function formTooLong(body: unknown, key: string, max: number): boolean {
  if (!body || typeof body !== 'object') return false;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim().length > max;
}

function peerErrorHtml(result: { reason: PeerFailureReason; detail?: string }): string {
  if (result.detail && result.detail !== 'invalid') return `<p class="err">${escapeHtml(result.detail)}</p>`;
  return davidNote(result.reason);
}

function approvedSection(data: AdminApproved): string {
  const rows = data.contacts.map((contact) => {
    const lid = contact.lid ? `<br><span class="muted">${escapeHtml(contact.lid)}</span>` : '';
    return `<tr><td>${escapeHtml(contact.displayName)}</td><td>${escapeHtml(contact.phone)}</td><td>${escapeHtml(contact.jid)}${lid}</td><td>${escapeHtml(contact.note)}</td><td>${escapeHtml(contact.addedBy)}</td><td>${escapeHtml(formatIso(contact.addedAt))}</td><td><form method="post" action="/admin/david/approved-contacts/remove"><input type="hidden" name="identifier" value="${escapeHtml(contact.jid)}"><button type="submit">Remove</button></form></td></tr>`;
  }).join('');
  return `<h2>Approved contacts</h2><p class="muted">David can send a first message to these contacts. A cold send is that first message to someone who has never written to David. Today: ${data.coldSentToday} of ${data.coldPerDay}. Read receipts, typing delay, rate limits, and stripping ¡ and ¿ still apply. Pass a phone number, a @s.whatsapp.net JID, or a @lid JID. David stores the phone JID.</p><form class="stack" method="post" action="/admin/david/approved-cap"><label>Cold sends per day<br><input name="cold_per_day" type="number" min="0" max="100" value="${data.coldPerDay}" required></label><button type="submit">Save cap</button></form><table><tr><th>Name</th><th>Phone</th><th>JID</th><th>Note</th><th>Added by</th><th>Added</th><th></th></tr>${rows || '<tr><td colspan="7">No approved contacts.</td></tr>'}</table><form class="stack" method="post" action="/admin/david/approved-contacts"><label>Phone, WhatsApp JID, or LID<br><input name="identifier" maxlength="128" required></label><br><label>Name<br><input name="display_name" maxlength="80"></label><br><label>Note<br><input name="note" maxlength="300" required></label><br><button type="submit">Add contact</button></form>`;
}

function styleForm(style: AdminStyle): string {
  const lines = style.lines.map((line) => {
    const hint = line.placeholders ? ` <span class="muted">Placeholders: ${escapeHtml(line.placeholders)}</span>` : '';
    return `<label class="stack"><span>${escapeHtml(line.label)}${hint}</span><br>English<br><textarea name="en_${escapeHtml(line.id)}" maxlength="${style.lineMax}">${escapeHtml(line.en)}</textarea><br>Spanish<br><textarea name="es_${escapeHtml(line.id)}" maxlength="${style.lineMax}">${escapeHtml(line.es)}</textarea></label>`;
  }).join('');
  const strip = style.strip ? ' checked' : '';
  return `<h2>Style</h2><p class="muted">The guide is sent with every Secretary batch. Canned lines are read when David sends that reply. A blank line keeps the built-in text. Spanish lines must not use ¡ or ¿; David also strips those marks on the way out when the toggle is on.</p><form class="stack" method="post" action="/admin/david/style"><label>Style guide<br><textarea name="guide" maxlength="${style.guideMax}">${escapeHtml(style.guide)}</textarea></label><p><label><input type="checkbox" name="strip" value="1"${strip}> Strip ¡ and ¿ from messages David sends</label></p>${lines}<button type="submit">Save style</button></form>`;
}

function contextHtml(data: AdminContext): string {
  const group = data.aibmGroupJid
    ? `${escapeHtml(data.aibmGroupJid)}. This value is ignored and is not a gate.`
    : 'not set, and ignored.';
  return `<h2>Status</h2><p>Quiet hours: ${escapeHtml(data.quiet || 'off')}</p><p>AIBM_GROUP_JID: ${group} Group events are messages that address David, or every group message when DAVID_GROUP_ALL is on.</p><p>Open escalations: ${data.openEscalations}. Code requests in flight: ${data.codeInFlight}. Deflections: ${data.deflections}.</p>${paceSection(data.pace)}${outboxTable(data)}${escalationTable(data.escalations)}${codeTable(data.codeRequests)}${allowlistTable(data.allowlist)}${deflectionTable(data.deflectionLog)}`;
}

function paceSection(pace: AdminPace | null | undefined): string {
  if (!pace) return '<h2>Send queue</h2><p class="muted">The paced sender did not report a snapshot.</p>';
  return `<h2>Send queue</h2><p>Waiting: ${pace.queued}. Sent in the last minute: ${pace.sentLastMinute}. Sent in the last hour: ${pace.sentLastHour}.</p><p class="muted">In memory only. A restart clears the queue. Message text is not listed here.</p>`;
}

function outboxTable(data: AdminContext): string {
  const rows = data.outbox ?? [];
  const unsent = data.unsentOutbox ?? 0;
  const body = rows.map((row) => {
    const sent = row.sentAt == null ? 'waiting' : escapeHtml(formatMs(row.sentAt));
    return `<tr><td>${escapeHtml(formatMs(row.enqueuedAt))}</td><td>${sent}</td><td>${escapeHtml(row.type)}</td><td>${escapeHtml(row.hint ?? '')}</td><td>${escapeHtml(row.chatId)}</td><td>${escapeHtml(row.text)}</td></tr>`;
  }).join('');
  return `<h2>Secretary outbox</h2><p class="muted">${unsent} unsent. Each row is one inbound event waiting for the Secretary batch. Prior-message context is not shown.</p><table><tr><th>Queued</th><th>Sent</th><th>Type</th><th>Hint</th><th>Chat</th><th>Text</th></tr>${body || '<tr><td colspan="6">No outbox events.</td></tr>'}</table>`;
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  return formatTime(ms / 1000);
}

function escalationTable(rows: AdminEscalation[]): string {
  const body = rows.map((row) => {
    const decision = [row.decision, row.resolvedVia].filter(Boolean).join(' via ');
    const extra = row.note ? `<br><span class="muted">${escapeHtml(row.note)}</span>` : '';
    const excerpt = row.excerpt ? `<br><span class="muted">${escapeHtml(row.excerpt)}</span>` : '';
    return `<tr><td>${escapeHtml(formatIso(row.issuedAt))}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.type)}</td><td>${escapeHtml(row.chatId)}</td><td>${escapeHtml(row.summary)}${excerpt}</td><td>${escapeHtml(decision)}${extra}</td><td>${escapeHtml(formatIso(row.secretaryPostedAt))}</td><td>${escapeHtml(formatIso(row.ownerDmAt))}</td></tr>`;
  }).join('');
  return `<h2>Escalations</h2><table><tr><th>When</th><th>Status</th><th>Type</th><th>Chat</th><th>Summary</th><th>Decision</th><th>Secretary</th><th>Owner DM</th></tr>${body || '<tr><td colspan="8">No escalations.</td></tr>'}</table>`;
}

function codeTable(rows: AdminCodeRequest[]): string {
  const body = rows.map((row) => {
    const result = row.prUrl ? httpsHref(row.prUrl) : escapeHtml(row.summary ?? '');
    return `<tr><td>${escapeHtml(formatIso(row.updatedAt))}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.repo)}</td><td>${escapeHtml(row.ask)}</td><td>${result}</td></tr>`;
  }).join('');
  return `<h2>Code requests</h2><p class="muted">Status changes when the code agent calls David back. The PR link is the callback result.</p><table><tr><th>Updated</th><th>Status</th><th>Repo</th><th>Ask</th><th>Result</th></tr>${body || '<tr><td colspan="5">No code requests.</td></tr>'}</table>`;
}

function allowlistTable(rows: Array<{ phone: string; repos: string[] }>): string {
  const body = rows.map((row) => `<tr><td>${escapeHtml(row.phone)}</td><td>${escapeHtml(row.repos.join(', '))}</td></tr>`).join('');
  return `<h2>Allowlist</h2><p class="muted">Current grants. David does not keep a separate history of grant and revoke decisions.</p><table><tr><th>Phone</th><th>Repos</th></tr>${body || '<tr><td colspan="2">No allowlist rows.</td></tr>'}</table>`;
}

function deflectionTable(rows: AdminContext['deflectionLog']): string {
  const body = rows.map((row) => `<tr><td>${escapeHtml(formatIso(row.at))}</td><td>${escapeHtml(row.chatId)}</td><td>${escapeHtml(row.requesterPhone)}</td><td>${escapeHtml(row.summary)}</td></tr>`).join('');
  return `<h2>Deflections</h2><table><tr><th>When</th><th>Chat</th><th>Phone</th><th>Summary</th></tr>${body || '<tr><td colspan="4">No deflections.</td></tr>'}</table>`;
}

function blocklistSection(account: AccountId, data: BlocklistView): string {
  const hidden = `<input type="hidden" name="account" value="${account}">`;
  const rows = data.entries.map(row => `<tr>${[row.name, row.phone, row.jid, row.lid ?? '', row.note, row.added_by, row.reason, row.added_at, String(row.stored_count ?? 0), String(row.event_count ?? 0)].map(v => `<td>${escapeHtml(v)}</td>`).join('')}<td><form method="post" action="/admin/david/webhook-blocklist/remove">${hidden}<input type="hidden" name="identifier" value="${escapeHtml(row.jid)}"><button>Remove</button></form><form method="post" action="/admin/david/webhook-blocklist/purge">${hidden}<input type="hidden" name="identifier" value="${escapeHtml(row.jid)}"><button>Review purge</button></form></td></tr>`).join('');
  return `<h3>${account}</h3><p>Dropped messages: ${data.dropped}. Skipped events (including drops): ${data.skipped}</p><table><tr><th>Name</th><th>Phone</th><th>JID</th><th>LID</th><th>Note</th><th>Added by</th><th>Reason</th><th>Added</th><th>Stored messages</th><th>Stored events</th><th></th></tr>${rows}</table><form class="stack" method="post" action="/admin/david/webhook-blocklist/add">${hidden}<label>Phone, PN JID or LID <input name="identifier" maxlength="128" required></label><label>Name <input name="name" maxlength="80"></label><label>Note <input name="note" maxlength="300"></label><label>Approved by <input name="approved_by" maxlength="80" required></label><label>Reason <input name="reason" maxlength="300" required></label><button>Add to ${account} webhook blocklist</button></form>`;
}
