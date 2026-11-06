/**
 * Personal answers David's LID lookup. The bearer is DAVID_READ_SECRET.
 * The Host must be `personal` or loopback. A public hostname is refused, and
 * so is any request that arrived through Cloudflare or another proxy.
 */
import type { Express, Response } from 'express';
import { safeEqual, strongSecret } from './admin-secret.js';
import { parseRecipient, pnFromBaileys, pnFromStore } from './david/resolve.js';
import { rejectProxiedInternal } from './internal-guard.js';

function sendJson(res: Response, status: number, body: unknown): void {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.status(status).json(body);
}

function bearer(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length).trim();
}

/** Compose DNS name `personal`, or loopback. A public name and `david` are refused. */
export function internalHostname(name: string | undefined): boolean {
  const host = (name ?? '').trim().toLowerCase();
  return host === 'personal' || host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function mountLidPn(app: Express, options: {
  secret: string;
  role: string;
  lookup: (lid: string) => Promise<string | null>;
}): void {
  const { secret, role, lookup } = options;
  if (!strongSecret(secret)) {
    console.log(`[whatsapp-bridge:${role}] LID lookup disabled. Set DAVID_READ_SECRET so David can ask this service for a phone number.`);
    return;
  }
  console.log(`[whatsapp-bridge:${role}] LID lookup enabled at /internal/lid-pn`);

  app.use('/internal/lid-pn', rejectProxiedInternal);
  app.get('/internal/lid-pn', (req, res) => {
    if (!internalHostname(req.hostname)) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    const given = bearer(req.header('authorization'));
    if (given.length === 0 || given.length > 256 || !safeEqual(given, secret)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    const raw = typeof req.query.lid === 'string' ? req.query.lid : '';
    const parsed = parseRecipient(raw);
    if (!parsed.ok || parsed.kind !== 'lid') {
      sendJson(res, 400, { error: 'lid must be a WhatsApp LID (user@lid).' });
      return;
    }
    void lookup(parsed.lid).then((pn) => {
      if (!pn) {
        sendJson(res, 404, { error: 'Unknown LID' });
        return;
      }
      const phone = pn.split('@')[0] ?? '';
      sendJson(res, 200, { pn, phone });
    }).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'Unavailable' });
    });
  });
}

export async function lookupLidOnSession(store: { phoneForJid?: (jid: string) => string }, sock: unknown, lid: string): Promise<string | null> {
  const fromSocket = await pnFromBaileys(sock, lid);
  if (fromSocket) return fromSocket;
  return pnFromStore(store, lid);
}
