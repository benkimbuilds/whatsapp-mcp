/**
 * Load a file for whatsapp_send_media from base64, an https URL, or a path
 * under MEDIA_SEND_DIR, detect its type, and build the Baileys content.
 * Nothing here sends; callers keep their own allowlist, blocklist, and pacing.
 */
import type { AnyMessageContent } from '@whiskeysockets/baileys';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { realpath, stat, open } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';

export type OutboundKind = 'image' | 'video' | 'audio' | 'document';

export type OutboundMedia = {
  kind: OutboundKind;
  buffer: Buffer;
  mimetype: string;
  filename: string;
};

export type MediaSource = {
  base64?: string;
  url?: string;
  path?: string;
  mimetype?: string;
  filename?: string;
  kind?: OutboundKind;
};

export type LoadOptions = {
  maxBytes: number;
  /** MEDIA_SEND_DIR. When empty, `path` is refused. */
  sendDir?: string;
  /** Test hook. Defaults to an https GET that refuses private addresses. */
  fetchUrl?: (url: URL, maxBytes: number) => Promise<{ buffer: Buffer; mimetype?: string }>;
};

export class MediaSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaSendError';
  }
}

const URL_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp', webm: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', aac: 'audio/aac',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const MIME_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_MIME).reverse().map(([ext, mime]) => [mime, ext]),
);

/** WhatsApp renders these inline. Anything else is sent as a document. */
const INLINE: Record<Exclude<OutboundKind, 'document'>, Set<string>> = {
  image: new Set(['image/jpeg', 'image/png', 'image/webp']),
  video: new Set(['video/mp4', 'video/3gpp']),
  audio: new Set(['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/aac', 'audio/amr']),
};

/** Magic-byte sniff for the common types. Returns undefined when unsure. */
export function sniffMime(buffer: Buffer): string | undefined {
  const head = (n: number) => buffer.subarray(0, n);
  const ascii = (start: number, end: number) => buffer.subarray(start, end).toString('latin1');
  if (buffer.length >= 3 && head(3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.length >= 8 && head(8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 3) === 'ID3' || (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0 && (buffer[1]! & 0x06) !== 0)) return 'audio/mpeg';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand.startsWith('3g')) return 'video/3gpp';
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'M4A ') return 'audio/mp4';
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic';
    return 'video/mp4';
  }
  if (buffer.length >= 4 && head(4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  return undefined;
}

function extOf(name: string | undefined): string {
  const ext = path.extname(name ?? '').slice(1).toLowerCase();
  return ext;
}

function cleanMime(value: string | undefined | null): string | undefined {
  const mime = value?.split(';')[0]?.trim().toLowerCase();
  return mime && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : undefined;
}

/** A safe display filename: no directories, no control characters, at most 120 characters. */
export function safeFilename(name: string | undefined, mimetype: string): string {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '')
    .trim()
    .slice(0, 120);
  if (base && base !== '.' && base !== '..') {
    return extOf(base) ? base : `${base}.${MIME_EXT[mimetype] ?? 'bin'}`;
  }
  return `file.${MIME_EXT[mimetype] ?? 'bin'}`;
}

/** Sniffed type wins; then the caller's mimetype; then the file extension. */
export function detectMime(buffer: Buffer, declared?: string, filename?: string): string {
  return sniffMime(buffer) ?? cleanMime(declared) ?? EXT_MIME[extOf(filename)] ?? 'application/octet-stream';
}

/** image/video/audio when WhatsApp can show it inline, else document. A requested kind is honored only if it fits. */
export function chooseKind(mimetype: string, requested?: OutboundKind): OutboundKind {
  if (requested === 'document') return 'document';
  const natural = (Object.keys(INLINE) as Array<keyof typeof INLINE>).find((kind) => INLINE[kind].has(mimetype));
  if (requested && requested !== natural) {
    throw new MediaSendError(`A ${mimetype} file cannot be sent as ${requested}. Omit kind, or use kind "document".`);
  }
  return natural ?? 'document';
}

export function tooLarge(size: number, maxBytes: number): string {
  return `The file is ${size} bytes, over the ${maxBytes}-byte limit (MEDIA_MAX_BYTES).`;
}

export async function loadOutboundMedia(source: MediaSource, options: LoadOptions): Promise<OutboundMedia> {
  const given = [source.base64, source.url, source.path].filter((value) => typeof value === 'string' && value.length > 0);
  if (given.length !== 1) throw new MediaSendError('Pass exactly one of base64, url, or path.');
  let buffer: Buffer;
  let declared = source.mimetype;
  let nameHint = source.filename;
  if (source.base64) {
    let data = source.base64.trim();
    const dataUri = data.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,/i);
    if (dataUri) {
      declared ??= dataUri[1];
      data = data.slice(dataUri[0].length);
    }
    data = data.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(data)) throw new MediaSendError('base64 is not valid base64.');
    if (Math.floor((data.length * 3) / 4) - 2 > options.maxBytes) throw new MediaSendError(tooLarge(Math.floor((data.length * 3) / 4), options.maxBytes));
    buffer = Buffer.from(data, 'base64');
  } else if (source.url) {
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      throw new MediaSendError('url is not a valid URL.');
    }
    if (url.protocol !== 'https:') throw new MediaSendError('url must use https.');
    if (url.username || url.password) throw new MediaSendError('url must not contain credentials.');
    const fetched = await (options.fetchUrl ?? fetchHttps)(url, options.maxBytes);
    buffer = fetched.buffer;
    declared ??= fetched.mimetype;
    nameHint ??= decodeURIComponent(path.posix.basename(url.pathname)) || undefined;
  } else {
    buffer = await readUnderDir(source.path!, options.sendDir, options.maxBytes);
    nameHint ??= path.basename(source.path!);
  }
  if (buffer.length === 0) throw new MediaSendError('The file is empty.');
  if (buffer.length > options.maxBytes) throw new MediaSendError(tooLarge(buffer.length, options.maxBytes));
  const mimetype = detectMime(buffer, declared, nameHint);
  const kind = chooseKind(mimetype, source.kind);
  return { kind, buffer, mimetype, filename: safeFilename(nameHint, mimetype) };
}

/** Baileys content for one outbound file. Audio has no caption on WhatsApp. */
export function mediaContent(media: OutboundMedia, caption: string): AnyMessageContent {
  const text = caption.trim();
  if (media.kind === 'image') return { image: media.buffer, mimetype: media.mimetype, ...(text ? { caption: text } : {}) };
  if (media.kind === 'video') return { video: media.buffer, mimetype: media.mimetype, ...(text ? { caption: text } : {}) };
  if (media.kind === 'audio') {
    if (text) throw new MediaSendError('WhatsApp audio cannot carry a caption. Send the caption as text, or use kind "document".');
    return { audio: media.buffer, mimetype: media.mimetype };
  }
  return { document: media.buffer, mimetype: media.mimetype, fileName: media.filename, ...(text ? { caption: text } : {}) };
}

async function readUnderDir(requested: string, sendDir: string | undefined, maxBytes: number): Promise<Buffer> {
  if (!sendDir?.trim()) throw new MediaSendError('Sending a local path is disabled. Set MEDIA_SEND_DIR on this session, or pass base64 or an https url.');
  let root: string;
  let target: string;
  try {
    root = await realpath(sendDir);
    target = await realpath(path.resolve(root, requested));
  } catch {
    throw new MediaSendError('File not found under MEDIA_SEND_DIR.');
  }
  if (target !== root && !target.startsWith(root + path.sep)) throw new MediaSendError('path must be inside MEDIA_SEND_DIR.');
  const info = await stat(target);
  if (!info.isFile()) throw new MediaSendError('path is not a regular file.');
  if (info.size > maxBytes) throw new MediaSendError(tooLarge(info.size, maxBytes));
  const handle = await open(target, 'r');
  try {
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** True for loopback, private, link-local, CGNAT, multicast, and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
  }
  return true;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** DNS lookup used by the socket itself, so the checked address is the connected address. */
function publicLookup(hostname: string, options: object, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((item) => isPrivateAddress(item.address))) {
      return callback(Object.assign(new Error('url resolves to a private address.'), { code: 'EPRIVATE' }), []);
    }
    if ((options as { all?: boolean }).all) return callback(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
}

function fetchHttps(url: URL, maxBytes: number, redirects = 0): Promise<{ buffer: Buffer; mimetype?: string }> {
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
    return Promise.reject(new MediaSendError('url points to a private address.'));
  }
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: 'GET', lookup: publicLookup as never, timeout: URL_TIMEOUT_MS, headers: { 'User-Agent': 'whatsapp-bridge' } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new MediaSendError('url redirected too many times.'));
        let next: URL;
        try {
          next = new URL(res.headers.location, url);
        } catch {
          return reject(new MediaSendError('url redirected to an invalid location.'));
        }
        if (next.protocol !== 'https:') return reject(new MediaSendError('url redirected away from https.'));
        return fetchHttps(next, maxBytes, redirects + 1).then(resolve, reject);
      }
      if (status !== 200) {
        res.resume();
        return reject(new MediaSendError(`url returned HTTP ${status}.`));
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        return reject(new MediaSendError(tooLarge(declared, maxBytes)));
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          res.destroy();
          reject(new MediaSendError(tooLarge(total, maxBytes)));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), mimetype: cleanMime(res.headers['content-type']) }));
      res.on('error', () => reject(new MediaSendError('Could not download the url.')));
    });
    req.on('timeout', () => req.destroy(new MediaSendError('url timed out.')));
    req.on('error', (error) => reject(error instanceof MediaSendError ? error
      : new MediaSendError((error as NodeJS.ErrnoException).code === 'EPRIVATE' ? 'url resolves to a private address.' : 'Could not download the url.')));
    req.end();
  });
}
