import assert from 'node:assert/strict';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { OAuthBridge } from '../dist/oauth.js';
import { requireBearer } from '../dist/auth.js';

const dir = await mkdtemp(path.join(tmpdir(), 'whatsapp-oauth-'));
const salt = randomBytes(16);
const passwordHash = `scrypt:${salt.toString('hex')}:${scryptSync('correct test password', salt, 32).toString('hex')}`;
const resource = 'https://wa-personal.example.com/mcp';
const redirect = 'http://localhost:8787/callback';
const dbPath = path.join(dir, 'oauth.sqlite');
const previous = new DatabaseSync(dbPath);
previous.exec('CREATE TABLE oauth_pending (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, state TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL, login_ok INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0)');
previous.close();
const oauth = new OAuthBridge({ publicUrl: resource, email: 'owner@example.com', passwordHash, dbPath, allowDelete: true });
const app = express();
oauth.mount(app);
app.get('/mcp', requireBearer('static test token', oauth), (_req, res) => res.json({ ok: true }));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const form = (body) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), redirect: 'manual' });

try {
  const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(metadata.resource, resource);
  assert.deepEqual(metadata.authorization_servers, ['https://wa-personal.example.com']);
  const unauth = await fetch(`${base}/mcp`);
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate'), /resource_metadata/);
  assert.equal((await fetch(`${base}/mcp`, { headers: { authorization: 'Bearer static test token' } })).status, 200);

  const badRegister = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://attacker.example/callback'] }) });
  assert.equal(badRegister.status, 400);
  const registration = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Grok Bot', redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback', 'https://www.cursor.com/agents/mcp/oauth/callback', redirect] }) });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(`${base}/oauth/authorize`);
  Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, state: 'csrf-test', code_challenge: challenge, code_challenge_method: 'S256', resource }).forEach(([key, val]) => authorize.searchParams.set(key, val));
  const spoof = new URL(authorize);
  spoof.searchParams.set('redirect_uri', 'https://attacker.example/callback');
  assert.equal((await fetch(spoof)).status, 400);
  const login = await (await fetch(authorize)).text();
  const requestId = login.match(/name="request_id" value="([^"]+)"/)?.[1];
  assert.ok(requestId);
  assert.equal((await fetch(`${base}/oauth/authorize`, form({ request_id: requestId, decision: 'login', email: 'owner@example.com', password: 'wrong' }))).status, 401);
  const signedIn = await fetch(`${base}/oauth/authorize`, form({ request_id: requestId, decision: 'login', email: 'owner@example.com', password: 'correct test password' }));
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.headers.get('content-security-policy'), /form-action 'self'/);
  assert.match(await signedIn.text(), /read your saved WhatsApp chats and group participant counts, send messages from your number, and delete your sent messages for everyone/);
  const approved = await fetch(`${base}/oauth/authorize`, form({ request_id: requestId, decision: 'approve' }));
  assert.equal(approved.status, 200);
  const approvedHtml = await approved.text();
  assert.match(approvedHtml, /Continue to Grok Bot/);
  const callback = new URL(approvedHtml.match(/<a class="action" href="([^"]+)"/)?.[1].replaceAll('&amp;', '&'));
  assert.equal(callback.searchParams.get('state'), 'csrf-test');
  assert.equal(callback.searchParams.get('iss'), 'https://wa-personal.example.com');
  const approvedAgain = await fetch(`${base}/oauth/authorize`, form({ request_id: requestId, decision: 'approve' }));
  assert.equal(approvedAgain.status, 200);
  const againHtml = await approvedAgain.text();
  assert.equal(new URL(againHtml.match(/<a class="action" href="([^"]+)"/)?.[1].replaceAll('&amp;', '&')).searchParams.get('code'), callback.searchParams.get('code'));

  const tokenRequest = { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: redirect, code: callback.searchParams.get('code'), code_verifier: verifier, resource };
  const issued = await fetch(`${base}/oauth/token`, form(tokenRequest));
  assert.equal(issued.status, 200);
  const tokens = await issued.json();
  assert.equal((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).status, 200);
  assert.equal((await fetch(`${base}/oauth/token`, form(tokenRequest))).status, 400);
  const refreshed = await fetch(`${base}/oauth/token`, form({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource }));
  assert.equal(refreshed.status, 200);
  const nextTokens = await refreshed.json();
  assert.equal((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).status, 401);
  assert.equal((await fetch(`${base}/oauth/token`, form({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token }))).status, 400);
  await fetch(`${base}/oauth/revoke`, form({ client_id: client.client_id, token: nextTokens.refresh_token }));
  assert.equal((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${nextTokens.access_token}` } })).status, 401);

  const permissionsPath = path.join(dir, 'permissions.sqlite');
  const beforeDelete = new OAuthBridge({ publicUrl: resource, email: 'owner@example.com', passwordHash, dbPath: permissionsPath, allowDelete: false });
  beforeDelete.close();
  const grantDb = new DatabaseSync(permissionsPath);
  const oldAccess = 'old-read-send-token';
  grantDb.prepare('INSERT INTO oauth_grants VALUES (?, ?, ?, ?, ?)').run(
    createHash('sha256').update(oldAccess).digest('hex'),
    createHash('sha256').update('old-refresh').digest('hex'),
    client.client_id, Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000) + 7200,
  );
  grantDb.prepare('INSERT INTO oauth_codes VALUES (?, ?, ?, ?, ?)').run(
    createHash('sha256').update('old-code').digest('hex'), client.client_id, redirect, challenge, Math.floor(Date.now() / 1000) + 600,
  );
  grantDb.prepare('INSERT INTO oauth_pending (id, client_id, redirect_uri, state, challenge, expires, login_ok) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'old-pending', client.client_id, redirect, 'old-state', challenge, Math.floor(Date.now() / 1000) + 600, 1,
  );
  grantDb.close();
  const afterDelete = new OAuthBridge({ publicUrl: resource, email: 'owner@example.com', passwordHash, dbPath: permissionsPath, allowDelete: true });
  assert.equal(afterDelete.verifyAccessToken(oldAccess), false);
  afterDelete.close();
  const newGrantDb = new DatabaseSync(permissionsPath);
  assert.equal(newGrantDb.prepare('SELECT COUNT(*) AS n FROM oauth_codes').get().n, 0);
  assert.equal(newGrantDb.prepare('SELECT COUNT(*) AS n FROM oauth_pending').get().n, 0);
  const newAccess = 'new-delete-approved-token';
  newGrantDb.prepare('INSERT INTO oauth_grants VALUES (?, ?, ?, ?, ?)').run(
    createHash('sha256').update(newAccess).digest('hex'),
    createHash('sha256').update('new-refresh').digest('hex'),
    client.client_id, Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000) + 7200,
  );
  newGrantDb.close();
  const restarted = new OAuthBridge({ publicUrl: resource, email: 'owner@example.com', passwordHash, dbPath: permissionsPath, allowDelete: true });
  assert.equal(restarted.verifyAccessToken(newAccess), true);
  restarted.close();
  console.log('PASS: OAuth discovery, restricted DCR, login and consent, PKCE exchange, bearer access, refresh rotation, revoke, replay rejection');
} finally {
  await new Promise((resolve) => server.close(resolve));
  oauth.close();
  await rm(dir, { recursive: true, force: true });
}
