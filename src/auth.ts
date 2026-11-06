import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Accept the original static token and, when enabled, short-lived OAuth tokens. */
export function requireBearer(expectedToken: string, oauth?: { verifyAccessToken(token: string): boolean; challenge(invalid?: boolean): string }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? req.header('Authorization');
    if (!header || !header.startsWith('Bearer ')) {
      if (oauth) res.set('WWW-Authenticate', oauth.challenge());
      res.status(401).json({ error: 'Missing Authorization: Bearer token' });
      return;
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token || (!safeEqual(token, expectedToken) && !oauth?.verifyAccessToken(token))) {
      if (oauth) res.set('WWW-Authenticate', oauth.challenge(true));
      res.status(401).json({ error: 'Invalid bearer token' });
      return;
    }
    next();
  };
}
