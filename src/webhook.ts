/**
 * Push new incoming WhatsApp messages to an external URL.
 * The first message after a send opens one fixed window. Off unless WEBHOOK_URL is set.
 */

const HOUR_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 1_000;
const TEXT_LIMIT = 200;
const BATCH_LIMIT = 100;

export type WebhookMessage = {
  chatJid: string;
  chatName: string;
  senderName: string;
  timestamp: string;
  text: string;
};

export type WebhookStatus = {
  enabled: boolean;
  lastSentAt: string | null;
  sentBatches: number;
  sentMessages: number;
  dropped: number;
  failedBatches: number;
  lastError: string | null;
};

export type WebhookSettings = {
  url: string;
  key: string;
  keyHeader: string;
  keyPrefix: string;
  groupJids: ReadonlySet<string>;
  batchMs: number;
  maxPerHour: number;
  session: string;
  chatName: (jid: string) => string;
};

type Delay = (ms: number, fn: () => void) => { cancel(): void };

type Attempt =
  | { ok: true; status: number }
  | { ok: false; retry: boolean; error: string };

export type WebhookAccount = {
  account: string;
  accountJid: string | null;
  accountPhone: string | null;
};

export type WebhookDeps = {
  blocked?: (senderJid: string) => boolean;
  fetch?: typeof fetch;
  now?: () => number;
  delay?: Delay;
  log?: (line: string) => void;
  /** Read at send time so a reconnect can update the paired number. */
  account?: () => WebhookAccount;
};

type IncomingLike = {
  key?: {
    remoteJid?: string | null;
    fromMe?: boolean | null;
    id?: string | null;
    participant?: string | null;
  } | null;
  messageTimestamp?: unknown;
  pushName?: string | null;
  message?: object | null;
};

const disabledStatus = (): WebhookStatus => ({
  enabled: false,
  lastSentAt: null,
  sentBatches: 0,
  sentMessages: 0,
  dropped: 0,
  failedBatches: 0,
  lastError: null,
});

function tag(session: string): string {
  return `[whatsapp-bridge:${session}]`;
}

function headerName(raw: string | undefined): string | null {
  const name = raw === undefined || raw.trim() === '' ? 'Authorization' : raw.trim();
  return /^[A-Za-z0-9-]{1,64}$/.test(name) ? name : null;
}

function wholeNumber(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > 86_400) return fallback;
  return value;
}

/** Real-time Baileys upserts only. `append` is history and reconnect backfill. */
export function acceptsRealtimeUpsert(type: string | undefined): boolean {
  return type === 'notify';
}

export function loadWebhookSettings(
  env: NodeJS.ProcessEnv,
  session: string,
  chatName: (jid: string) => string,
): WebhookSettings | null {
  const url = env.WEBHOOK_URL?.trim() ?? '';
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.error(`${tag(session)} webhook disabled: WEBHOOK_URL is not a URL`);
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    console.error(`${tag(session)} webhook disabled: WEBHOOK_URL must be http or https`);
    return null;
  }
  if (parsed.username || parsed.password) {
    console.error(`${tag(session)} webhook disabled: WEBHOOK_URL must not include credentials`);
    return null;
  }
  const key = env.WEBHOOK_KEY ?? '';
  const prefix = env.WEBHOOK_KEY_PREFIX === undefined ? 'Bearer ' : env.WEBHOOK_KEY_PREFIX;
  if (/[\r\n]/.test(key) || /[\r\n]/.test(prefix)) {
    console.error(`${tag(session)} webhook disabled: webhook header value is not a single line`);
    return null;
  }
  const keyHeader = headerName(env.WEBHOOK_KEY_HEADER);
  if (!keyHeader) {
    console.error(`${tag(session)} webhook disabled: WEBHOOK_KEY_HEADER is not a header name`);
    return null;
  }
  const groupJids = new Set(
    (env.WEBHOOK_GROUP_JIDS ?? '').split(',').map((jid) => jid.trim()).filter((jid) => jid.endsWith('@g.us')),
  );
  return {
    url: parsed.toString(),
    key,
    keyHeader,
    keyPrefix: prefix,
    groupJids,
    batchMs: wholeNumber(env.WEBHOOK_BATCH_SECONDS, 600, 0) * 1000,
    maxPerHour: wholeNumber(env.WEBHOOK_MAX_PER_HOUR, 6, 0),
    session,
    chatName,
  };
}

function textOf(message: object | null | undefined): string | null {
  if (!message) return null;
  const fields = message as Record<string, unknown>;
  if (fields.protocolMessage || fields.reactionMessage) return null;
  const conversation = fields.conversation;
  if (typeof conversation === 'string') return conversation;
  const extended = fields.extendedTextMessage as { text?: unknown } | undefined;
  if (typeof extended?.text === 'string') return extended.text;
  const image = fields.imageMessage as { caption?: unknown } | undefined;
  if (image) return typeof image.caption === 'string' && image.caption.trim() ? `[image] ${image.caption}` : '[image]';
  const video = fields.videoMessage as { caption?: unknown } | undefined;
  if (video) return typeof video.caption === 'string' && video.caption.trim() ? `[video] ${video.caption}` : '[video]';
  const audio = fields.audioMessage as { ptt?: unknown } | undefined;
  if (audio) return audio.ptt ? '[voice]' : '[audio]';
  const document = fields.documentMessage as { caption?: unknown; fileName?: unknown } | undefined;
  if (document) {
    const caption = typeof document.caption === 'string' && document.caption.trim()
      ? document.caption
      : typeof document.fileName === 'string' ? document.fileName : '';
    return caption ? `[document] ${caption}` : '[document]';
  }
  if (fields.stickerMessage) return '[sticker]';
  return null;
}

function senderName(message: IncomingLike): string {
  const push = message.pushName?.trim();
  if (push) return push.slice(0, 80);
  const jid = message.key?.participant || message.key?.remoteJid || '';
  return jid.split('@')[0]?.split(':')[0] ?? '';
}

function timestampIso(value: unknown, nowMs: number): string {
  let seconds = nowMs / 1000;
  if (typeof value === 'number' && Number.isFinite(value)) seconds = value > 10_000_000_000 ? value / 1000 : value;
  else if (typeof value === 'bigint') seconds = Number(value);
  else if (value && typeof value === 'object' && 'toNumber' in value && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    const converted = (value as { toNumber: () => number }).toNumber();
    if (Number.isFinite(converted)) seconds = converted > 10_000_000_000 ? converted / 1000 : converted;
  }
  return new Date(seconds * 1000).toISOString();
}

/** DM not sent by this account, or an allowlisted group. Empty, protocol, and reaction messages are skipped. */
export function selectIncoming(message: IncomingLike, groupJids: ReadonlySet<string>, chatName: string, nowMs: number): WebhookMessage | null {
  const jid = message.key?.remoteJid ?? '';
  if (!jid || message.key?.fromMe) return null;
  if (jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return null;
  const direct = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
  const allowedGroup = jid.endsWith('@g.us') && groupJids.has(jid);
  if (!direct && !allowedGroup) return null;
  const raw = textOf(message.message);
  if (!raw) return null;
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, TEXT_LIMIT);
  if (!text) return null;
  return {
    chatJid: jid,
    chatName,
    senderName: senderName(message),
    timestamp: timestampIso(message.messageTimestamp, nowMs),
    text,
  };
}

export type Webhook = {
  push(message: IncomingLike): void;
  status(): WebhookStatus;
};

export function createWebhook(settings: WebhookSettings | null, deps: WebhookDeps = {}): Webhook {
  if (!settings) {
    return { push() {}, status: disabledStatus };
  }
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const delay = deps.delay ?? ((ms, fn) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  });
  const secret = settings.key.length >= 8 ? settings.key : '';
  const log = (line: string) => {
    const safe = secret ? line.split(secret).join('[redacted]') : line;
    (deps.log ?? ((entry) => console.log(entry)))(safe);
  };
  const pending: Array<WebhookMessage & { senderJid: string }> = [];
  const pendingIds = new Set<string>();
  const deliveries: number[] = [];
  let timer: { cancel(): void } | null = null;
  let sending = false;
  let sentBatches = 0;
  let sentMessages = 0;
  let dropped = 0;
  let failedBatches = 0;
  let lastSentAt: string | null = null;
  let lastError: string | null = null;

  const status = (): WebhookStatus => ({
    enabled: true,
    lastSentAt,
    sentBatches,
    sentMessages,
    dropped,
    failedBatches,
    lastError,
  });

  // The first queued message opens one window. Later messages stay in it and do not move the deadline.
  const arm = () => {
    if (timer) return;
    timer = delay(settings.batchMs, () => {
      timer = null;
      void flush();
    });
  };

  const wait = (ms: number) => new Promise<void>((resolve) => {
    delay(ms, resolve);
  });

  const attempt = async (body: string): Promise<Attempt> => {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (settings.key) headers[settings.keyHeader] = `${settings.keyPrefix}${settings.key}`;
      const response = await fetchImpl(settings.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) return { ok: true, status: response.status };
      const retry = response.status >= 500;
      return { ok: false, retry, error: `status=${response.status}` };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      return { ok: false, retry: true, error: timedOut ? 'error=timeout' : 'error=network' };
    }
  };

  const deliver = async (body: string): Promise<Attempt> => {
    const first = await attempt(body);
    if (first.ok || !first.retry) return first;
    await wait(RETRY_DELAY_MS);
    return attempt(body);
  };

  const flush = async () => {
    if (sending || pending.length === 0) return;
    const cutoff = now() - HOUR_MS;
    while (deliveries.length > 0 && deliveries[0]! <= cutoff) deliveries.shift();
    if (deliveries.length >= settings.maxPerHour) {
      const count = pending.length;
      pending.length = 0;
      pendingIds.clear();
      dropped += count;
      log(`${tag(settings.session)} webhook dropped ${count} messages; hourly cap ${settings.maxPerHour} reached`);
      return;
    }
    const overflow = Math.max(0, pending.length - BATCH_LIMIT);
    const batch = pending.splice(0, BATCH_LIMIT).filter(item => !deps.blocked?.(item.senderJid));
    pending.length = 0;
    pendingIds.clear();
    if (overflow > 0) dropped += overflow;
    if (!batch.length) return;
    sending = true;
    deliveries.push(now());
    try {
      let identity: WebhookAccount = { account: settings.session, accountJid: null, accountPhone: null };
      try {
        const lookedUp = deps.account?.();
        if (lookedUp?.account) identity = lookedUp;
      } catch {
        // Keep the session role when the paired account is not readable.
      }
      const result = await deliver(JSON.stringify({
        account: identity.account,
        accountJid: identity.accountJid,
        accountPhone: identity.accountPhone,
        messages: batch.map(({ senderJid: _sender, ...item }) => ({ ...item, fromMe: false })),
        dropped: overflow,
      }));
      if (result.ok) {
        sentBatches += 1;
        sentMessages += batch.length;
        lastSentAt = new Date(now()).toISOString();
        lastError = null;
        log(`${tag(settings.session)} webhook delivered messages=${batch.length} dropped=${overflow} status=${result.status}`);
      } else {
        failedBatches += 1;
        lastError = result.error;
        log(`${tag(settings.session)} webhook failed ${result.error} messages=${batch.length} dropped=${overflow}`);
      }
    } catch {
      failedBatches += 1;
      lastError = 'error=network';
      log(`${tag(settings.session)} webhook failed error=network messages=${batch.length} dropped=${overflow}`);
    } finally {
      sending = false;
      if (pending.length > 0) arm();
    }
  };

  return {
    push(message) {
      try {
        const jid = message.key?.remoteJid ?? '';
        let chatName = '';
        try {
          chatName = jid ? settings.chatName(jid) ?? '' : '';
        } catch {
          chatName = '';
        }
        const item = selectIncoming(message, settings.groupJids, chatName, now());
        if (!item) return;
        const senderJid = jid.endsWith('@g.us') ? message.key?.participant ?? '' : jid;
        if (deps.blocked?.(senderJid)) return;
        const id = message.key?.id;
        if (id && pendingIds.has(id)) return;
        if (id) pendingIds.add(id);
        pending.push({ ...item, senderJid });
        arm();
      } catch {
        log(`${tag(settings.session)} webhook enqueue failed`);
      }
    },
    status,
  };
}
