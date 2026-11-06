/**
 * Cloudflare Tunnel reaches both containers with Host: localhost, so the host
 * allow-list does not keep /internal/* private. A proxied request carries one
 * of these headers. Docker-network calls (personal → david, david → personal)
 * do not.
 */
import type { NextFunction, Request, Response } from 'express';

const PROXY_HEADERS = ['cf-ray', 'cf-connecting-ip', 'cf-ipcountry', 'x-forwarded-for'] as const;

export function hasForwardingHeader(header: (name: string) => string | undefined): boolean {
  return PROXY_HEADERS.some((name) => {
    const value = header(name);
    return typeof value === 'string' && value.trim().length > 0;
  });
}

/** 404 before auth, so a public probe does not learn that the route exists. */
export function rejectProxiedInternal(req: Request, res: Response, next: NextFunction): void {
  if (!hasForwardingHeader((name) => req.header(name))) {
    next();
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.status(404).json({ error: 'Not found' });
}
