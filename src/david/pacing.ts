/** One serialized outbound path for David. Personal sends do not use this. */
import type { OutboundMedia } from '../media-send.js';

export type PaceConfig = {
  typingMinMs: number;
  typingMaxMs: number;
  typingMsPerChar: number;
  chatGapMs: number;
  sendPerMinute: number;
  sendPerHour: number;
  sendMaxWaitMs: number;
};

export type PaceRequest = {
  jid: string;
  text: string;
  replyTo?: string | null;
  readId?: string | null;
  /** A file to send with `text` as its caption. Same allow rules and pacing as text. */
  media?: OutboundMedia | null;
};

export type PaceResult = { ok: true; messageId?: string } | { ok: false; error: 'cold_contact' | 'cold_cap' | 'rate_limited' | 'not_open' | 'send_failed' };

export type ColdTarget = { jid: string; phone: string };

export type AllowDecision =
  | { allow: true; cold: ColdTarget | null }
  | { allow: false; error: 'cold_contact' | 'cold_cap' };

export type PaceDeps = {
  now: () => number;
  delay: (ms: number) => Promise<void>;
  random: () => number;
  allowed: (jid: string) => AllowDecision | Promise<AllowDecision>;
  /** Called only after WhatsApp accepts a cold send. */
  recordCold?: (cold: ColdTarget) => void | Promise<void>;
  markRead: (jid: string, id: string) => Promise<void>;
  presence: (jid: string, state: 'composing' | 'paused') => Promise<void>;
  send: (jid: string, text: string, replyTo?: string | null, media?: OutboundMedia | null) => Promise<{ ok: boolean; messageId?: string }>;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Clamp to the configured window. Random 0 leaves a short message at the minimum. */
export function typingDelayMs(text: string, config: PaceConfig, random: () => number): number {
  const min = Math.max(0, config.typingMinMs);
  const max = Math.max(min, config.typingMaxMs);
  const roll = Math.min(1, Math.max(0, random()));
  const proportional = min + text.length * Math.max(0, config.typingMsPerChar);
  const jitter = roll * Math.min(2_000, Math.max(0, max - min));
  const raw = proportional + jitter;
  if (raw < min) return min;
  if (raw > max) return max;
  return raw;
}

function waitForCap(stamps: number[], cap: number, windowMs: number, now: number): number {
  const recent = stamps.filter((stamp) => now - stamp < windowMs);
  if (recent.length < cap) return 0;
  const oldest = recent[0] ?? now;
  return Math.max(0, oldest + windowMs - now);
}

export type PaceStatus = {
  queued: number;
  sentLastMinute: number;
  sentLastHour: number;
};

export class PacedSender {
  private chain: Promise<void> = Promise.resolve();
  private readonly lastByChat = new Map<string, number>();
  private readonly sentAt: number[] = [];
  /** Sends accepted and not yet finished. Does not store message text. */
  private depth = 0;
  /** Added when a test delay does not move the injected clock. */
  private extra = 0;

  constructor(private readonly config: PaceConfig, private readonly deps: PaceDeps) {}

  send(request: PaceRequest): Promise<PaceResult> {
    this.depth += 1;
    const run = this.chain.then(() => this.deliver(request));
    this.chain = run.then(() => undefined, () => undefined);
    return run.finally(() => {
      this.depth -= 1;
    });
  }

  /** In-memory snapshot. A restart clears it. Message text is not included. */
  status(): PaceStatus {
    const now = this.clock();
    return {
      queued: this.depth,
      sentLastMinute: this.sentAt.filter((stamp) => now - stamp < MINUTE_MS).length,
      sentLastHour: this.sentAt.filter((stamp) => now - stamp < HOUR_MS).length,
    };
  }

  private clock(): number {
    return this.deps.now() + this.extra;
  }

  private async wait(ms: number): Promise<void> {
    if (ms <= 0) return;
    const start = this.deps.now();
    await this.deps.delay(ms);
    const moved = this.deps.now() - start;
    if (moved + 5 < ms) this.extra += ms - Math.max(0, moved);
  }

  private neededWait(jid: string): number {
    const now = this.clock();
    const last = this.lastByChat.get(jid) ?? 0;
    const gap = Math.max(0, last + this.config.chatGapMs - now);
    const minute = waitForCap(this.sentAt, this.config.sendPerMinute, MINUTE_MS, now);
    const hour = waitForCap(this.sentAt, this.config.sendPerHour, HOUR_MS, now);
    return Math.max(gap, minute, hour);
  }

  private async deliver(request: PaceRequest): Promise<PaceResult> {
    const decision = await this.deps.allowed(request.jid);
    if (!decision.allow) return { ok: false, error: decision.error };
    let waited = 0;
    for (let guard = 0; guard < 8; guard += 1) {
      const wait = this.neededWait(request.jid);
      if (wait <= 0) break;
      if (waited + wait > this.config.sendMaxWaitMs) return { ok: false, error: 'rate_limited' };
      await this.wait(wait);
      waited += wait;
    }
    if (this.neededWait(request.jid) > 0) return { ok: false, error: 'rate_limited' };
    const readId = request.readId || request.replyTo || '';
    if (readId) {
      try {
        await this.deps.markRead(request.jid, readId);
      } catch {
        // A failed read receipt does not block the send.
      }
    }
    try {
      await this.deps.presence(request.jid, 'composing');
    } catch {
      // Presence is best-effort.
    }
    await this.wait(typingDelayMs(request.text, this.config, this.deps.random));
    try {
      await this.deps.presence(request.jid, 'paused');
    } catch {
      // Presence is best-effort.
    }
    const sent = request.media
      ? await this.deps.send(request.jid, request.text, request.replyTo, request.media)
      : await this.deps.send(request.jid, request.text, request.replyTo);
    if (!sent.ok) return { ok: false, error: 'send_failed' };
    if (decision.cold) {
      try {
        await this.deps.recordCold?.(decision.cold);
      } catch {
        // The message was accepted. A log failure must not hide that.
      }
    }
    const at = this.clock();
    this.lastByChat.set(request.jid, at);
    this.sentAt.push(at);
    const cutoff = at - HOUR_MS;
    while (this.sentAt.length > 0 && this.sentAt[0]! < cutoff) this.sentAt.shift();
    return { ok: true, messageId: sent.messageId };
  }
}
