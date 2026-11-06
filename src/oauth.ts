import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express, { type Express, type Request, type Response } from 'express';

const CURSOR_REDIRECTS = new Set([
  'cursor://anysphere.cursor-mcp/oauth/callback',
  'https://www.cursor.com/agents/mcp/oauth/callback',
  'http://localhost:8787/callback',
]);
const CODE_TTL = 10 * 60;
const ACCESS_TTL = 24 * 60 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60;
const now = () => Math.floor(Date.now() / 1000);
const secret = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const value = (input: unknown) => typeof input === 'string' ? input : '';

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui;max-width:28rem;margin:10vh auto;padding:1rem;color:#17202a}input,button,.action{font:inherit;width:100%;box-sizing:border-box;padding:.7rem;margin:.4rem 0 1rem}button,.action{display:block;text-align:center;background:#17202a;color:white;border:0;border-radius:.4rem;cursor:pointer;text-decoration:none}.muted{color:#56616b;font-size:.9rem}</style>${body}</html>`;
}
function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function browserResponse(res: Response): void {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
}
function oauthError(res: Response, status: number, error: string): void {
  res.status(status).set('Cache-Control', 'no-store').json({ error });
}
function validPassword(password: string, encoded: string): boolean {
  const parts = encoded.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt' || !/^[0-9a-f]{32}$/.test(parts[1]) || !/^[0-9a-f]{64}$/.test(parts[2])) return false;
  const expected = Buffer.from(parts[2], 'hex');
  const actual = scryptSync(password, Buffer.from(parts[1], 'hex'), 32);
  return timingSafeEqual(actual, expected);
}

type Client = { id: string; name: string; redirects: string };
type Pending = { id: string; client_id: string; redirect_uri: string; state: string; challenge: string; expires: number; login_ok: number; failures: number; approved_code: string | null };
type Code = { client_id: string; redirect_uri: string; challenge: string; expires: number };
type Grant = { client_id: string; access_expires: number; refresh_expires: number };

export class OAuthBridge {
  readonly publicUrl: string;
  readonly issuer: string;
  readonly email: string;
  private readonly allowDelete: boolean;
  private readonly passwordHash: string;
  private readonly db: DatabaseSync;

  constructor(config: { publicUrl: string; email: string; passwordHash: string; dbPath: string; allowDelete?: boolean }) {
    const url = new URL(config.publicUrl);
    if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.search || url.hash) throw new Error('OAUTH_PUBLIC_URL must be an HTTPS /mcp URL');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.email)) throw new Error('OAUTH_EMAIL must be an email address');
    if (!/^scrypt:[0-9a-f]{32}:[0-9a-f]{64}$/.test(config.passwordHash)) throw new Error('OAUTH_PASSWORD_HASH must be a scrypt hash');
    this.publicUrl = url.toString();
    this.issuer = url.origin;
    this.email = config.email.toLowerCase();
    this.allowDelete = Boolean(config.allowDelete);
    this.passwordHash = config.passwordHash;
    mkdirSync(path.dirname(config.dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(config.dbPath);
    chmodSync(config.dbPath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirects TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_pending (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, state TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL, login_ok INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, approved_code TEXT);
      CREATE TABLE IF NOT EXISTS oauth_codes (hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_grants (access_hash TEXT PRIMARY KEY, refresh_hash TEXT UNIQUE NOT NULL, client_id TEXT NOT NULL, access_expires INTEGER NOT NULL, refresh_expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_failures (ip TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS oauth_failures_ip ON oauth_failures (ip, at);
      CREATE TABLE IF NOT EXISTS oauth_registrations (ip TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS oauth_registrations_ip ON oauth_registrations (ip, at);
      CREATE TABLE IF NOT EXISTS oauth_authorize_requests (ip TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS oauth_authorize_requests_ip ON oauth_authorize_requests (ip, at);
      CREATE TABLE IF NOT EXISTS oauth_permissions (key TEXT PRIMARY KEY);
    `);
    const pendingColumns = this.db.prepare('PRAGMA table_info(oauth_pending)').all() as Array<{ name: string }>;
    if (!pendingColumns.some((column) => column.name === 'approved_code')) {
      this.db.exec('ALTER TABLE oauth_pending ADD COLUMN approved_code TEXT');
    }
    // Only the first transition into ALLOW_DELETE invalidates grants. A new
    // read-only tool stays inside the existing `mcp` scope and must not clear
    // oauth_grants, codes, or pending authorizations. Saving a draft is not a
    // send. Sending one uses the existing ALLOW_SEND gate and must not clear
    // grants either.
    const deleteConsent = this.db.prepare("SELECT key FROM oauth_permissions WHERE key = 'delete_enabled'").get();
    if (this.allowDelete && !deleteConsent) {
      // A former read/send grant or in-flight code must not acquire deletion.
      this.db.exec(`
        BEGIN;
        DELETE FROM oauth_grants;
        DELETE FROM oauth_codes;
        DELETE FROM oauth_pending;
        INSERT INTO oauth_permissions (key) VALUES ('delete_enabled');
        COMMIT;
      `);
    } else if (!this.allowDelete && deleteConsent) {
      this.db.prepare("DELETE FROM oauth_permissions WHERE key = 'delete_enabled'").run();
    }
  }

  close(): void { this.db.close(); }
  resourceMetadataUrl(): string { return `${this.issuer}/.well-known/oauth-protected-resource/mcp`; }
  challenge(invalid = false): string { return `Bearer ${invalid ? 'error="invalid_token", ' : ''}resource_metadata="${this.resourceMetadataUrl()}"`; }

  verifyAccessToken(token: string): boolean {
    const row = this.db.prepare('SELECT access_expires FROM oauth_grants WHERE access_hash = ?').get(digest(token)) as { access_expires: number } | undefined;
    return Boolean(row && row.access_expires > now());
  }

  mount(app: Express): void {
    const metadata = {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp'],
    };
    const resource = { resource: this.publicUrl, authorization_servers: [this.issuer], scopes_supported: ['mcp'], bearer_methods_supported: ['header'] };
    app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(metadata));
    app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.json(resource));
    app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(resource));

    app.post('/oauth/register', express.json({ limit: '8kb' }), (req, res) => {
      const redirects = req.body?.redirect_uris;
      if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 5 || redirects.some((uri) => typeof uri !== 'string' || !CURSOR_REDIRECTS.has(uri))) {
        oauthError(res, 400, 'invalid_redirect_uri'); return;
      }
      const ip = value(req.header('cf-connecting-ip') || req.ip).slice(0, 64);
      const recent = this.db.prepare('SELECT COUNT(*) AS n FROM oauth_registrations WHERE ip = ? AND at > ?').get(ip, now() - 3600) as { n: number };
      const totalClients = this.db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number };
      if (recent.n >= 10 || totalClients.n >= 200) { oauthError(res, 429, 'too_many_requests'); return; }
      const name = typeof req.body?.client_name === 'string' ? req.body.client_name.slice(0, 128) : 'Grok Bot';
      const id = secret();
      this.db.prepare('INSERT INTO oauth_clients VALUES (?, ?, ?)').run(id, name, JSON.stringify(redirects));
      this.db.prepare('INSERT INTO oauth_registrations VALUES (?, ?)').run(ip, now());
      res.status(201).json({ client_id: id, client_id_issued_at: now(), client_name: name, redirect_uris: redirects, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    });

    app.get('/oauth/authorize', (req, res) => {
      browserResponse(res);
      const clientId = value(req.query.client_id);
      const redirectUri = value(req.query.redirect_uri);
      const state = value(req.query.state);
      const challenge = value(req.query.code_challenge);
      const client = this.db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(clientId) as Client | undefined;
      if (req.query.response_type !== 'code' || req.query.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || !state || state.length > 1024 || req.query.scope && req.query.scope !== 'mcp' || req.query.resource && req.query.resource !== this.publicUrl || !client || !JSON.parse(client.redirects).includes(redirectUri)) {
        res.status(400).send(page('Invalid request', '<h1>Invalid authorization request</h1>')); return;
      }
      this.prune();
      const ip = value(req.header('cf-connecting-ip') || req.ip).slice(0, 64);
      const recent = this.db.prepare('SELECT COUNT(*) AS n FROM oauth_authorize_requests WHERE ip = ? AND at > ?').get(ip, now() - 600) as { n: number };
      const pendingCount = this.db.prepare('SELECT COUNT(*) AS n FROM oauth_pending').get() as { n: number };
      if (recent.n >= 20 || pendingCount.n >= 200) { res.status(429).send(page('Too many requests', '<h1>Try again later</h1>')); return; }
      const id = secret();
      this.db.prepare('INSERT INTO oauth_pending (id, client_id, redirect_uri, state, challenge, expires) VALUES (?, ?, ?, ?, ?, ?)').run(id, clientId, redirectUri, state, challenge, now() + CODE_TTL);
      this.db.prepare('INSERT INTO oauth_authorize_requests VALUES (?, ?)').run(ip, now());
      res.send(this.loginPage(id));
    });

    app.post('/oauth/authorize', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
      browserResponse(res);
      const id = value(req.body?.request_id);
      const pending = this.db.prepare('SELECT * FROM oauth_pending WHERE id = ? AND expires > ?').get(id, now()) as Pending | undefined;
      if (!pending) { res.status(400).send(page('Expired request', '<h1>Authorization request expired</h1>')); return; }
      if (req.body?.decision === 'deny') {
        if (pending.approved_code) { res.status(400).send(page('Already approved', '<h1>Authorization was already approved</h1>')); return; }
        this.db.prepare('DELETE FROM oauth_pending WHERE id = ?').run(id);
        const redirect = new URL(pending.redirect_uri);
        redirect.searchParams.set('error', 'access_denied'); redirect.searchParams.set('state', pending.state);
        res.send(this.continuationPage(redirect.toString(), false)); return;
      }
      if (req.body?.decision === 'login') {
        const ip = value(req.header('cf-connecting-ip') || req.ip).slice(0, 64);
        const failures = this.db.prepare('SELECT COUNT(*) AS n FROM oauth_failures WHERE ip = ? AND at > ?').get(ip, now() - 3600) as { n: number };
        if (pending.login_ok) { res.send(this.consentPage(id, pending.client_id)); return; }
        if (pending.failures >= 5 || failures.n >= 20) { res.status(429).send(page('Too many attempts', '<h1>Try again later</h1>')); return; }
        const email = value(req.body?.email).toLowerCase();
        const password = value(req.body?.password);
        const passwordMatches = password.length <= 1024 && validPassword(password, this.passwordHash);
        if (email !== this.email || !passwordMatches) {
          this.db.prepare('UPDATE oauth_pending SET failures = failures + 1 WHERE id = ?').run(id);
          this.db.prepare('INSERT INTO oauth_failures VALUES (?, ?)').run(ip, now());
          res.status(401).send(this.loginPage(id, true)); return;
        }
        this.db.prepare('UPDATE oauth_pending SET login_ok = 1 WHERE id = ?').run(id);
        res.send(this.consentPage(id, pending.client_id)); return;
      }
      if (req.body?.decision !== 'approve' || !pending.login_ok) { res.status(400).send(page('Invalid request', '<h1>Invalid approval</h1>')); return; }
      const code = pending.approved_code ?? secret();
      if (!pending.approved_code) {
        this.db.prepare('UPDATE oauth_pending SET approved_code = ? WHERE id = ?').run(code, id);
        this.db.prepare('INSERT INTO oauth_codes VALUES (?, ?, ?, ?, ?)').run(digest(code), pending.client_id, pending.redirect_uri, pending.challenge, now() + CODE_TTL);
      }
      const redirect = new URL(pending.redirect_uri);
      redirect.searchParams.set('code', code); redirect.searchParams.set('state', pending.state); redirect.searchParams.set('iss', this.issuer);
      res.send(this.continuationPage(redirect.toString(), true));
    });

    app.post('/oauth/token', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
      res.set('Cache-Control', 'no-store');
      const clientId = value(req.body?.client_id);
      const client = this.db.prepare('SELECT id FROM oauth_clients WHERE id = ?').get(clientId) as { id: string } | undefined;
      if (!client || req.body?.resource && req.body.resource !== this.publicUrl) { oauthError(res, 400, 'invalid_client'); return; }
      if (req.body?.grant_type === 'authorization_code') {
        const code = value(req.body.code);
        const row = this.db.prepare('DELETE FROM oauth_codes WHERE hash = ? RETURNING *').get(digest(code)) as Code | undefined;
        const verifier = value(req.body.code_verifier);
        const computed = createHash('sha256').update(verifier).digest('base64url');
        if (!row || row.expires <= now() || row.client_id !== clientId || row.redirect_uri !== req.body.redirect_uri || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || computed !== row.challenge) { oauthError(res, 400, 'invalid_grant'); return; }
        this.issueTokens(res, clientId); return;
      }
      if (req.body?.grant_type === 'refresh_token') {
        const token = value(req.body.refresh_token);
        const row = this.db.prepare('DELETE FROM oauth_grants WHERE refresh_hash = ? RETURNING *').get(digest(token)) as Grant | undefined;
        if (!row || row.client_id !== clientId || row.refresh_expires <= now()) { oauthError(res, 400, 'invalid_grant'); return; }
        this.issueTokens(res, clientId); return;
      }
      oauthError(res, 400, 'unsupported_grant_type');
    });

    app.post('/oauth/revoke', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
      const clientId = value(req.body?.client_id);
      const hash = digest(value(req.body?.token));
      this.db.prepare('DELETE FROM oauth_grants WHERE client_id = ? AND (access_hash = ? OR refresh_hash = ?)').run(clientId, hash, hash);
      res.status(200).end();
    });
  }

  private loginPage(id: string, failed = false): string {
    return page('Sign in to WhatsApp bridge', `<h1>Sign in to WhatsApp bridge</h1><p class="muted">Authorize Grok Bot to access your WhatsApp chats.</p>${failed ? '<p>Incorrect email or password.</p>' : ''}<form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${id}"><input type="hidden" name="decision" value="login"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form>`);
  }
  private consentPage(id: string, clientId: string): string {
    const client = this.db.prepare('SELECT name FROM oauth_clients WHERE id = ?').get(clientId) as { name: string };
    const access = this.allowDelete
      ? 'read your saved WhatsApp chats and group participant counts, send messages from your number, and delete your sent messages for everyone'
      : 'read your saved WhatsApp chats and group participant counts, and send messages from your number';
    return page('Approve WhatsApp access', `<h1>Approve access?</h1><p>The client calling itself <strong>${escapeHtml(client.name)}</strong> will be able to ${access}.</p><p class="muted">Client names are self-reported. Approve only if you just started this connection in Grok Bot. Client ID: ${escapeHtml(clientId.slice(-12))}</p><form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${id}"><button name="decision" value="approve" type="submit">Approve access</button><button name="decision" value="deny" type="submit">Deny</button></form>`);
  }
  private continuationPage(callbackUrl: string, approved: boolean): string {
    return page(approved ? 'WhatsApp access approved' : 'WhatsApp access denied', `<h1>${approved ? 'Access approved' : 'Access denied'}</h1><p>${approved ? 'One more step is needed to finish connecting Grok Bot.' : 'Return to Grok Bot to finish.'}</p><a class="action" href="${escapeHtml(callbackUrl)}">Continue to Grok Bot</a><p class="muted">This link expires in 10 minutes. If it does not open, start authentication again in Grok Bot.</p>`);
  }
  private issueTokens(res: Response, clientId: string): void {
    const access = secret(); const refresh = secret();
    this.db.prepare('INSERT INTO oauth_grants VALUES (?, ?, ?, ?, ?)').run(digest(access), digest(refresh), clientId, now() + ACCESS_TTL, now() + REFRESH_TTL);
    res.json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: 'mcp' });
  }
  private prune(): void {
    this.db.prepare('DELETE FROM oauth_pending WHERE expires <= ?').run(now());
    this.db.prepare('DELETE FROM oauth_codes WHERE expires <= ?').run(now());
    this.db.prepare('DELETE FROM oauth_grants WHERE refresh_expires <= ?').run(now());
    this.db.prepare('DELETE FROM oauth_failures WHERE at <= ?').run(now() - 3600);
    this.db.prepare('DELETE FROM oauth_registrations WHERE at <= ?').run(now() - 3600);
    this.db.prepare('DELETE FROM oauth_authorize_requests WHERE at <= ?').run(now() - 600);
  }
}
