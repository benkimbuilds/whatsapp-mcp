/**
 * whatsapp-bridge — one Baileys session exposed as a Streamable HTTP MCP server.
 * Run personal and assistant as their own processes. David is a third process
 * with the same image, its own env file, and an in-bridge assistant brain.
 */
import 'dotenv/config';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import express from 'express';
import { mountAdmin } from './admin.js';
import { createDavidPeer, normalizeDavidAdminUrl } from './admin-peer.js';
import { strongSecret } from './admin-secret.js';
import { requireBearer } from './auth.js';
import { bridgeAccount } from './account.js';
import { isDavidMode, loadDavidConfig } from './david/config.js';
import { DavidRuntime } from './david/runtime.js';
import { mountDavidRead } from './david-read.js';
import { rejectProxiedInternal } from './internal-guard.js';
import { lookupLidOnSession, mountLidPn } from './lid-pn.js';
import { createBridgeMcpHandler } from './mcp-http.js';
import { OAuthBridge } from './oauth.js';
import { createMcpServer } from './mcp-tools.js';
import { createWhatsAppSession, type SessionHooks } from './whatsapp.js';
import { createWebhook, loadWebhookSettings } from './webhook.js';

function requireToken(): string {
  const token = process.env.MCP_BEARER_TOKEN?.trim() ?? '';
  if (!token || token === 'change-me-to-a-long-random-secret' || token.length < 16) {
    console.error(
      'MCP_BEARER_TOKEN must be a unique secret of at least 16 characters (openssl rand -hex 32). The example placeholder is rejected.',
    );
    process.exit(1);
  }
  return token;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  console.error(`${name} must be true or false (got ${JSON.stringify(raw)}).`);
  process.exit(1);
}

function sessionRole(): string {
  const role = (process.env.SESSION_ROLE || 'default').trim();
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(role)) {
    console.error('SESSION_ROLE must be 1–32 characters: letters, digits, underscore, or hyphen.');
    process.exit(1);
  }
  return role;
}

const token = requireToken();
const role = sessionRole();
// Sending remains opt-in for standalone deployments.
const allowSend = envBool('ALLOW_SEND', false);
const allowDelete = envBool('ALLOW_DELETE', false);

const davidConfig = isDavidMode() ? loadDavidConfig(process.env) : undefined;
if (davidConfig && !davidConfig.ownerPhone) {
  console.error(
    'OWNER_PHONE is required when SESSION_ROLE=david or DAVID_MODE is on. Use digits only, including the country code. There is no default.',
  );
  process.exit(1);
}

const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be an integer from 1 to 65535.');
  process.exit(1);
}
const host = process.env.HOST || '0.0.0.0';
const authDir = process.env.AUTH_DIR || './auth_info_baileys';
const historyDbPath = process.env.HISTORY_DB_PATH || `${authDir}/history.sqlite`;
const allowedHosts = (process.env.ALLOWED_HOSTS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const hooks: SessionHooks = {};
const wa = createWhatsAppSession(authDir, historyDbPath, role, hooks);
const webhook = createWebhook(loadWebhookSettings(process.env, role, (jid) => {
  try {
    return wa.getStore().chatTitle(jid);
  } catch {
    return '';
  }
}), {
  blocked: (jid) => (david?.store.webhookBlocklist ?? wa.getStore().webhookBlocklist).skip(jid, (id) => wa.getStore().phoneForJid(id)),
  account: () => {
    const source: { id?: string; lid?: string; phoneNumber?: string; pairedJid?: string; pairedNumber?: string } = {};
    try {
      const status = wa.getStatus();
      source.pairedJid = status.pairedJid;
      source.pairedNumber = status.pairedNumber;
    } catch {
      // Status is still starting.
    }
    try {
      Object.assign(source, wa.getAccount());
    } catch {
      // Creds may be unread during the first tick.
    }
    return bridgeAccount(role, source);
  },
});
hooks.onNotify = (message) => webhook.push(message);
hooks.webhookStatus = () => webhook.status();
const readSecret = process.env.DAVID_READ_SECRET?.trim() ?? '';
const personalLidUrl = normalizeDavidAdminUrl(process.env.PERSONAL_LID_URL?.trim() ?? '');
const david = davidConfig
  ? new DavidRuntime(davidConfig, wa, `${authDir}/david.sqlite`, {
    allowSend,
    ...(personalLidUrl && strongSecret(readSecret) ? { personalLid: { url: personalLidUrl, secret: readSecret } } : {}),
  })
  : undefined;
if (david) {
  const forwardNotify = hooks.onNotify;
  hooks.onNotify = (message) => {
    forwardNotify?.(message);
    david.handleNotify(message);
  };
}
const oauthUrl = process.env.OAUTH_PUBLIC_URL?.trim();
const oauth = oauthUrl ? new OAuthBridge({
  publicUrl: oauthUrl,
  email: process.env.OAUTH_EMAIL?.trim() ?? '',
  passwordHash: process.env.OAUTH_PASSWORD_HASH?.trim() ?? '',
  dbPath: `${authDir}/oauth.sqlite`,
  allowDelete,
}) : undefined;

if (!david) void wa.getStore().webhookBlocklist;
const davidActions = david?.actions();
const mediaSendDir = process.env.MEDIA_SEND_DIR?.trim() || undefined;
const handler = createBridgeMcpHandler(() => createMcpServer(wa, {
  role,
  allowSend,
  allowDelete,
  ...(mediaSendDir ? { mediaSendDir } : {}),
  webhookBlocklist: david?.store.webhookBlocklist ?? wa.getStore().webhookBlocklist,
  ...(davidActions ? { david: davidActions } : {}),
  ...(david ? {
    pacedSend: (input) => david.sendOutbound(input),
    resolveRecipient: (to: string, purpose: 'send' | 'draft') => david.resolveOutboundJid(to, purpose),
  } : {}),
}));
const node = toNodeHandler(handler);

const appOptions =
  host === '127.0.0.1' || host === 'localhost' || host === '::1'
    ? { host }
    : {
        host,
        allowedHosts: allowedHosts.length
          ? allowedHosts
          : ['localhost', '127.0.0.1', '[::1]'],
      };

// When exposing via tunnel, either bind HOST=127.0.0.1 and let the tunnel hit localhost,
// or set ALLOWED_HOSTS to your public hostname(s).
const app = createMcpExpressApp(appOptions as Parameters<typeof createMcpExpressApp>[0]);
// Tunnel traffic uses Host: localhost plus Cloudflare headers. Hide every
// /internal route from that path. Docker DNS calls send neither header.
app.use('/internal', rejectProxiedInternal);
oauth?.mount(app);
const davidPeer = createDavidPeer({
  secret: readSecret,
  baseUrl: process.env.DAVID_ADMIN_URL?.trim() || 'http://david:8788',
});
if (role === 'personal' && davidPeer.configured) {
  console.log(`[whatsapp-bridge:${role}] Admin will read David at ${davidPeer.baseUrl}`);
} else if (role === 'personal' && readSecret) {
  console.log(`[whatsapp-bridge:${role}] David admin peer disabled. Check DAVID_READ_SECRET and DAVID_ADMIN_URL.`);
}
mountAdmin(app, {
  secret: process.env.ADMIN_SECRET?.trim() ?? '',
  store: wa.getStore(),
  role,
  ...(role === 'personal' ? { peer: davidPeer } : {}),
});
if (role === 'personal') {
  mountLidPn(app, {
    secret: readSecret,
    role,
    lookup: (lid) => lookupLidOnSession(wa.getStore(), wa.getSocket(), lid),
  });
}
if (david && davidConfig) {
  mountDavidRead(app, {
    secret: readSecret,
    store: wa.getStore(),
    davidStore: david.store,
    aibmGroupJid: davidConfig.aibmGroupJid,
    role,
    pace: () => david.paceStatus(),
    timezone: davidConfig.timezone,
    resolveContact: (identifier) => david.resolveForAllowlist(identifier),
  });
}

app.get('/healthz', (_req, res) => {
  const whatsapp = wa.getStatus();
  res.json({
    ok: true,
    whatsappConnected: whatsapp.state === 'open',
    service: 'whatsapp-bridge',
    session: role,
    allowSend,
    allowDelete,
    whatsapp: { state: whatsapp.state, hasCreds: whatsapp.hasCreds },
  });
});

app.all('/mcp', requireBearer(token, oauth), (req, res) => {
  void node(req, res, req.body);
});

if (david) {
  app.post('/david/cursor-callback', express.json({ limit: '32kb' }), (req, res) => {
    void david.handleCallbackHttp(req, res);
  });
}

await wa.start();
david?.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[whatsapp-bridge:${role}] ${signal}; flushing david events`);
  try {
    await david?.stop();
  } catch {
    // Exit even if the last post failed. Unsent rows stay in david.sqlite.
  }
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

app.listen(port, host, () => {
  console.log(`[whatsapp-bridge:${role}] Streamable HTTP on http://${host}:${port}/mcp`);
  console.log(`[whatsapp-bridge:${role}] Health check: http://${host}:${port}/healthz`);
  console.log(`[whatsapp-bridge:${role}] AUTH_DIR=${authDir} HISTORY_DB_PATH=${historyDbPath} ALLOW_SEND=${allowSend} ALLOW_DELETE=${allowDelete}`);
  console.log(`[whatsapp-bridge:${role}] Auth: Authorization: Bearer <MCP_BEARER_TOKEN>`);
  const webhookState = webhook.status();
  console.log(`[whatsapp-bridge:${role}] webhook ${webhookState.enabled ? 'on' : 'off'}`);
  if (david) console.log(`[whatsapp-bridge:${role}] david in-bridge brain on`);
});
