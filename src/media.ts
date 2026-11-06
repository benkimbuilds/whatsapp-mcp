/**
 * Media metadata and download for messages already saved by the bridge.
 * The file bytes are not written to SQLite. The media key is, so a later
 * download still works after the in-memory Baileys cache drops the message.
 */
import {
  downloadContentFromMessage,
  extractMessageContent,
  getContentType,
  type WAMessage,
  type proto,
} from '@whiskeysockets/baileys';

/** Default plaintext cap for a download or a send: 16 MiB. */
export const MEDIA_DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
/** Hard ceiling for MEDIA_MAX_BYTES. WhatsApp itself refuses most media above this. */
export const MEDIA_CEILING_BYTES = 100 * 1024 * 1024;

/** Parse MEDIA_MAX_BYTES: bytes, or a number with a K/M suffix. Invalid values use the default. */
export function mediaMaxBytesFrom(raw: string | undefined): number {
  const match = raw?.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)(?:i?[bB])?$/);
  if (!match) return MEDIA_DEFAULT_MAX_BYTES;
  const unit = match[2]?.toLowerCase() === 'm' ? 1024 * 1024 : match[2]?.toLowerCase() === 'k' ? 1024 : 1;
  const bytes = Math.floor(Number(match[1]) * unit);
  if (!Number.isFinite(bytes) || bytes < 1024) return MEDIA_DEFAULT_MAX_BYTES;
  return Math.min(bytes, MEDIA_CEILING_BYTES);
}

/**
 * Plaintext cap for whatsapp_download_media and whatsapp_send_media, from
 * MEDIA_MAX_BYTES (default 16 MiB, max 100 MiB). Base64 in an MCP result or
 * argument is about a third larger than this.
 */
export const MEDIA_MAX_BYTES = mediaMaxBytesFrom(process.env.MEDIA_MAX_BYTES);
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000;
export const MEDIA_REUPLOAD_TIMEOUT_MS = 20_000;

export const MISSING_MEDIA_KEY =
  'The media key for this message was not saved, so it cannot be downloaded. Re-upload needs that key, and this bridge cannot ask WhatsApp for the file without it. If WhatsApp delivers the message again, the key is stored and a later download can succeed.';

export const EXPIRED_MEDIA_OFFLINE =
  'The saved media link has expired or is missing, and the bridge could not ask WhatsApp to re-upload it. Retry when the session is open.';

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

export type PreparedMedia = {
  kind: MediaKind;
  mimetype: string;
  filename: string;
  size: number | null;
  mediaKey: Uint8Array | null;
  directPath: string | null;
  url: string | null;
};

const MEDIA_FIELDS: Record<string, MediaKind> = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};

const DEFAULT_MIME: Record<MediaKind, string> = {
  image: 'image/jpeg',
  video: 'video/mp4',
  audio: 'audio/ogg',
  document: 'application/octet-stream',
  sticker: 'image/webp',
};

export class MediaDownloadError extends Error {
  readonly code: 'missing_key' | 'too_large' | 'expired' | 'reupload_failed' | 'unavailable' | 'timeout';

  constructor(code: MediaDownloadError['code'], message: string) {
    super(message);
    this.name = 'MediaDownloadError';
    this.code = code;
  }
}

export function mediaTooLargeMessage(size: number, maxBytes: number): string {
  return `This file is ${size} bytes, above the ${maxBytes} byte download limit. It was not downloaded.`;
}

export function looksLikeMediaPlaceholder(text: string | null | undefined): boolean {
  if (!text) return false;
  return /^\[(image|video|audio|voice|document|sticker|imageMessage|videoMessage|audioMessage|documentMessage|stickerMessage|documentWithCaptionMessage)(\]|\s)/.test(text);
}

type MediaBody = {
  mimetype?: string | null;
  fileName?: string | null;
  fileLength?: unknown;
  mediaKey?: Uint8Array | string | null;
  directPath?: string | null;
  url?: string | null;
  ptt?: boolean | null;
  caption?: string | null;
};

export function describeMedia(message: proto.IMessage | null | undefined): PreparedMedia | null {
  const content = extractMessageContent(message ?? undefined);
  if (!content) return null;
  for (const [field, kind] of Object.entries(MEDIA_FIELDS)) {
    const media = (content as Record<string, unknown>)[field];
    if (!media || typeof media !== 'object') continue;
    const body = media as MediaBody;
    const mimetype = cleanMime(body.mimetype, DEFAULT_MIME[kind]);
    const original = typeof body.fileName === 'string' ? body.fileName : undefined;
    const filename = safeFilename(original, generatedFilename(kind, mimetype, Boolean(body.ptt)));
    return {
      kind,
      mimetype,
      filename,
      size: fileLength(body.fileLength),
      mediaKey: mediaKeyBytes(body.mediaKey),
      directPath: cleanDirectPath(body.directPath),
      url: cleanMediaUrl(body.url),
    };
  }
  return null;
}

/** A WAMessage Baileys can download or ask the phone to re-upload. */
export function buildDownloadMessage(input: {
  jid: string;
  id: string;
  fromMe: boolean | null;
  participant: string | null;
  media: PreparedMedia;
}): WAMessage {
  const field = Object.entries(MEDIA_FIELDS).find(([, kind]) => kind === input.media.kind)?.[0] ?? 'documentMessage';
  const body: MediaBody = {
    mimetype: input.media.mimetype,
    fileName: input.media.filename,
    ...(input.media.size != null ? { fileLength: input.media.size } : {}),
    ...(input.media.mediaKey ? { mediaKey: input.media.mediaKey } : {}),
    ...(input.media.directPath ? { directPath: input.media.directPath } : {}),
    ...(input.media.url ? { url: input.media.url } : {}),
  };
  return {
    key: {
      remoteJid: input.jid,
      id: input.id,
      ...(input.fromMe != null ? { fromMe: input.fromMe } : {}),
      ...(input.participant ? { participant: input.participant } : {}),
    },
    message: { [field]: body },
  } as WAMessage;
}

export async function downloadBaileysMedia(message: WAMessage): Promise<AsyncIterable<Uint8Array>> {
  const content = extractMessageContent(message.message ?? undefined);
  const contentType = content ? getContentType(content) : undefined;
  const kind = contentType ? MEDIA_FIELDS[contentType] : undefined;
  const media = contentType && content ? (content as Record<string, unknown>)[contentType] : undefined;
  if (!kind || !media || typeof media !== 'object') {
    throw new MediaDownloadError('unavailable', 'This message has no attached document, image, audio, video, or sticker.');
  }
  const body = media as MediaBody;
  // Pass directPath alone when we have it so Baileys uses mmg.whatsapp.net.
  // A url host from the message is only used when it is already a WhatsApp host.
  const directPath = cleanDirectPath(body.directPath);
  const downloadable = {
    mediaKey: mediaKeyBytes(body.mediaKey),
    directPath,
    url: directPath ? null : cleanMediaUrl(body.url),
  };
  return downloadContentFromMessage(downloadable, kind);
}

export async function downloadPreparedMedia(input: {
  message: WAMessage;
  maxBytes: number;
  download: (message: WAMessage) => Promise<Uint8Array | AsyncIterable<Uint8Array>>;
  reupload?: (message: WAMessage) => Promise<WAMessage>;
  timeoutMs?: number;
  reuploadTimeoutMs?: number;
}): Promise<{
  buffer: Buffer;
  filename: string;
  mimetype: string;
  kind: MediaKind;
  url: string | null;
  directPath: string | null;
  reuploaded: boolean;
}> {
  const described = describeMedia(input.message.message);
  if (!described) {
    throw new MediaDownloadError('unavailable', 'This message has no attached document, image, audio, video, or sticker.');
  }
  if (!described.mediaKey) throw new MediaDownloadError('missing_key', MISSING_MEDIA_KEY);
  if (described.size != null && described.size > input.maxBytes) {
    throw new MediaDownloadError('too_large', mediaTooLargeMessage(described.size, input.maxBytes));
  }

  let current = input.message;
  let reuploaded = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const payload = await withTimeout(
        input.download(current),
        input.timeoutMs ?? MEDIA_DOWNLOAD_TIMEOUT_MS,
        () => new MediaDownloadError('timeout', 'The media download timed out.'),
      );
      const buffer = await readLimited(payload, input.maxBytes);
      const after = describeMedia(current.message) ?? described;
      return {
        buffer,
        filename: after.filename,
        mimetype: after.mimetype,
        kind: after.kind,
        url: after.url,
        directPath: after.directPath,
        reuploaded,
      };
    } catch (error) {
      if (error instanceof MediaDownloadError && error.code !== 'unavailable') throw error;
      const retry = canReupload(error);
      if (reuploaded) {
        throw new MediaDownloadError('unavailable', 'The media link was refreshed, but the file still could not be downloaded.');
      }
      if (!retry || !input.reupload) {
        if (retry) throw new MediaDownloadError('expired', EXPIRED_MEDIA_OFFLINE);
        throw new MediaDownloadError('unavailable', 'The media could not be downloaded.');
      }
      try {
        current = await withTimeout(
          input.reupload(current),
          input.reuploadTimeoutMs ?? MEDIA_REUPLOAD_TIMEOUT_MS,
          () => new MediaDownloadError('reupload_failed', 'WhatsApp did not finish re-uploading this media in time. Retry when the phone that has the file is online.'),
        );
        reuploaded = true;
      } catch (reuploadError) {
        if (reuploadError instanceof MediaDownloadError) throw reuploadError;
        const detail = safeLibraryMessage(reuploadError);
        throw new MediaDownloadError(
          'reupload_failed',
          detail
            ? `WhatsApp could not re-upload this media (${detail}). The file may be gone from the sending phone, or the media key has expired.`
            : 'WhatsApp could not re-upload this media. The file may be gone from the sending phone, or the media key has expired.',
        );
      }
    }
  }
  throw new MediaDownloadError('unavailable', 'The media could not be downloaded.');
}

function canReupload(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 403 || status === 404 || status === 410) return true;
  const message = error instanceof Error ? error.message : '';
  return message.includes('No valid media URL') || message.includes('Failed to fetch stream');
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { status?: unknown; statusCode?: unknown; output?: { statusCode?: unknown } };
  for (const value of [record.status, record.statusCode, record.output?.statusCode]) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return undefined;
}

function safeLibraryMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim() : '';
  if (!message || message.length > 180) return null;
  if (/https?:|mediakey|directpath|enc_p/i.test(message)) return null;
  return message;
}

async function readLimited(source: Uint8Array | AsyncIterable<Uint8Array>, maxBytes: number): Promise<Buffer> {
  if (source instanceof Uint8Array) {
    if (source.byteLength > maxBytes) throw new MediaDownloadError('too_large', mediaTooLargeMessage(source.byteLength, maxBytes));
    return Buffer.from(source);
  }
  const iterator = source[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const buf = Buffer.from(next.value);
      total += buf.length;
      if (total > maxBytes) throw new MediaDownloadError('too_large', mediaTooLargeMessage(total, maxBytes));
      chunks.push(buf);
    }
  } finally {
    await iterator.return?.().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
}

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function fileLength(value: unknown): number | null {
  let number: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) number = value;
  else if (typeof value === 'bigint') number = Number(value);
  else if (value && typeof value === 'object' && 'toNumber' in value && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    const converted = (value as { toNumber: () => number }).toNumber();
    if (Number.isFinite(converted)) number = converted;
  } else if (typeof value === 'string' && /^\d+$/.test(value)) number = Number(value);
  if (number == null || number < 0) return null;
  if (number > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  return Math.floor(number);
}

function mediaKeyBytes(value: unknown): Uint8Array | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const decoded = Buffer.from(value, 'base64');
    return decoded.byteLength > 0 ? decoded : null;
  }
  if (value instanceof Uint8Array) return value.byteLength > 0 ? Buffer.from(value) : null;
  return null;
}

function cleanDirectPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.length > 1024 || trimmed.includes('..') || /\s/.test(trimmed)) return null;
  return trimmed;
}

/** Only HTTPS WhatsApp media hosts. Other URLs are dropped so a message cannot make the bridge fetch arbitrary hosts. */
export function cleanMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
    const host = parsed.hostname.toLowerCase();
    if (host !== 'mmg.whatsapp.net' && !host.endsWith('.whatsapp.net')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function cleanMime(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().toLowerCase().slice(0, 120);
  if (!trimmed || /[\r\n]/.test(trimmed) || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:\s*;.*)?$/.test(trimmed)) return fallback;
  return trimmed;
}

function generatedFilename(kind: MediaKind, mimetype: string, voice: boolean): string {
  if (kind === 'audio' && voice) return `voice.${extensionFor(mimetype, 'ogg')}`;
  const fallback = { image: 'jpg', video: 'mp4', audio: 'ogg', document: 'bin', sticker: 'webp' }[kind];
  return `${kind}.${extensionFor(mimetype, fallback)}`;
}

function extensionFor(mimetype: string, fallback: string): string {
  const known: Record<string, string> = {
    'application/pdf': 'pdf',
    'application/xml': 'xml',
    'text/xml': 'xml',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'video/mp4': 'mp4',
  };
  const base = mimetype.split(';', 1)[0]?.trim() ?? '';
  if (known[base]) return known[base];
  const subtype = base.split('/')[1] ?? '';
  if (/^[a-z0-9][a-z0-9.+-]{0,9}$/.test(subtype)) return subtype === 'jpeg' ? 'jpg' : subtype;
  return fallback;
}

function safeFilename(name: string | undefined, fallback: string): string {
  const base = (name ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '').trim().slice(0, 180);
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned;
}
