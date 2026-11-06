/**
 * David asks the personal container for a LID's phone when its own
 * Baileys mapping has none. The URL must be http on localhost or one
 * Compose DNS label, same rule as the admin peer, so the read secret
 * cannot be sent to a public host.
 */
import { normalizeDavidAdminUrl } from '../admin-peer.js';
import { normalizePn } from './resolve.js';

const TIMEOUT_MS = 2000;

export async function lookupPersonalPn(options: {
  baseUrl: string;
  secret: string;
  lid: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const base = normalizeDavidAdminUrl(options.baseUrl);
  const secret = options.secret.trim();
  if (!base || secret.length < 24) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  let url: URL;
  try {
    url = new URL('/internal/lid-pn', base);
  } catch {
    return null;
  }
  url.searchParams.set('lid', options.lid);
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
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 2000) return null;
    const parsed = JSON.parse(text) as { pn?: unknown };
    return typeof parsed.pn === 'string' ? normalizePn(parsed.pn) : null;
  } catch {
    return null;
  }
}
