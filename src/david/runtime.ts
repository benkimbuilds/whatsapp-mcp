/**
 * In-bridge brain for the david session.
 * Inbound messages become Secretary events. David does not auto-reply.
 * Owner commands and the code callback send only through the paced sender.
 * Personal does not construct this.
 */
import { assertPhoneStaysDirect } from '../recipient.js';
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { bridgeAccount, type BridgeAccount } from '../account.js';
import type { AnyMessageContent, WAMessage } from '@whiskeysockets/baileys';
import { mediaContent, type OutboundMedia } from '../media-send.js';
import { replyQuote } from '../quote.js';
import type { StoredMessage } from '../store.js';
import type { DavidConfig } from './config.js';
import { codeCallbackUrl } from './config.js';
import {
  accountJids,
  addressedToDavid,
  isIgnorableChat,
  parseInbound,
  phoneFromJid,
  type Inbound,
} from './inbound.js';
import {
  actionableText,
  classify,
  eventHint,
  extractRepo,
  normalizePhone,
  normalizeRepo,
  shortOwnerDecision,
  type OwnerCommand,
} from './intent.js';
import { postJson } from './payloads.js';
import {
  addApprovedContact,
  approvedMcpView,
  COLD_PER_DAY_KEY,
  localDay,
  readColdPerDay,
  removeApprovedContact,
} from './approved.js';
import { lookupPersonalPn } from './lid-client.js';
import { PacedSender, type AllowDecision, type PaceResult, type PaceStatus } from './pacing.js';
import {
  defaultLanguage,
  languageSignal,
  type Lang,
} from './persona.js';
import {
  normalizePn,
  parseRecipient,
  pnFromBaileys,
  pnFromStore,
  unresolvedLid,
} from './resolve.js';
import {
  lineSettingKey,
  renderCanned,
  stripEnabled,
  stripInvertedPunctuation,
  styleGuideText,
  type CannedId,
} from './style.js';
import { DavidStore, type EscalationRow } from './store.js';

export type DavidBrain = {
  /** Unused for sending. Kept so an older hook cannot make David reply on its own. */
  complete?(input: { text: string; lang: Lang }): Promise<string | null | undefined>;
};

type ContactLike = { lid?: string | null; phoneNumber?: string | null };

type ContextRow = {
  id: string;
  fromMe: boolean;
  participant: string;
  text: string;
  timestamp: number | null;
};

export type DavidHistory = {
  upsertMessage(message: never): void;
  getStoredMessage?(jid: string, id: string): StoredMessage | null;
  setInboundBlocklist?: import('../store.js').MemoryStore['setInboundBlocklist'];
  contacts: Map<string, ContactLike>;
  phoneForJid?(jid: string): string;
  chatTitle?(jid: string): string;
  recentChatContext?(jid: string, limit: number, excludeId?: string): ContextRow[];
  heardFrom?(jid: string, phone?: string): boolean;
  knownGroup?(jid: string): boolean;
  knownPhoneJid?(jid: string): boolean;
  linkJids?(left: string | null | undefined, right: string | null | undefined): void;
  phoneForJid?(jid: string): string;
};

type Sock = {
  sendMessage(
    jid: string,
    content: AnyMessageContent,
    options?: { quoted?: WAMessage },
  ): Promise<{ key?: { id?: string | null } } | undefined>;
  readMessages?(keys: Array<{ remoteJid: string; id: string; fromMe?: boolean }>): Promise<unknown>;
  sendPresenceUpdate?(type: 'composing' | 'paused', jid: string): Promise<unknown>;
  onWhatsApp?(...phones: string[]): Promise<Array<{ jid: string; exists: boolean }> | undefined>;
};

export type DavidWa = {
  getStatus(): { state: string; pairedJid?: string; pairedNumber?: string };
  getSocket(): Sock | null;
  getStore(): DavidHistory;
  getAccount(): { id?: string; lid?: string; phoneNumber?: string };
};

type SendOutcome = boolean | { ok: boolean; messageId?: string };

export type DavidDeps = {
  now?: () => Date;
  fetch?: typeof fetch;
  send?: (jid: string, text: string, options?: { replyTo?: string | null; media?: OutboundMedia | null }) => Promise<SendOutcome>;
  delay?: (ms: number) => Promise<void>;
  random?: () => number;
  markRead?: (jid: string, id: string) => Promise<void>;
  presence?: (jid: string, state: 'composing' | 'paused') => Promise<void>;
  log?: (line: string) => void;
  brain?: DavidBrain;
  /** Personal container LID lookup. Tried only after this session's own mapping misses. */
  personalLid?: { url: string; secret: string; fetch?: typeof fetch };
  /**
   * When false, this process does not send WhatsApp messages (owner commands,
   * callbacks, or the paced queue). Unset keeps the historical test default.
   * index.ts always passes the ALLOW_SEND env value.
   */
  allowSend?: boolean;
};

type ResolveInput = {
  request_id: string;
  decision: 'approve' | 'deny' | 'edit';
  note?: string;
  edited_action?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DavidRuntime {
  readonly store: DavidStore;
  private readonly paced: PacedSender;
  private readonly seen = new Set<string>();
  private readonly heard = new Set<string>();
  private readonly lastInbound = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private windowTimer: ReturnType<typeof setTimeout> | undefined;
  private windowDeadline: number | null = null;
  private flushing: Promise<void> | null = null;
  private ticking = false;
  private loggedSecretaryMissing = false;

  constructor(
    private readonly config: DavidConfig,
    private readonly wa: DavidWa,
    dbPath: string,
    private readonly deps: DavidDeps = {},
  ) {
    this.store = new DavidStore(dbPath, config.ownerPhone);
    wa.getStore().setInboundBlocklist?.(this.store.webhookBlocklist, {
      count: entry => this.store.blockedEvents(entry, jid => wa.getStore().phoneForJid?.(jid) ?? '').length,
      purge: entry => this.store.purgeBlockedEvents(entry, jid => wa.getStore().phoneForJid?.(jid) ?? ''),
    });
    this.paced = new PacedSender({
      typingMinMs: config.typingMinMs,
      typingMaxMs: config.typingMaxMs,
      typingMsPerChar: config.typingMsPerChar,
      chatGapMs: config.chatGapMs,
      sendPerMinute: config.sendPerMinute,
      sendPerHour: config.sendPerHour,
      sendMaxWaitMs: config.sendMaxWaitMs,
    }, {
      now: () => this.now().getTime(),
      delay: (ms) => this.delay(ms),
      random: () => (this.deps.random ? this.deps.random() : Math.random()),
      allowed: (jid) => this.allowJid(jid),
      recordCold: (cold) => this.recordCold(cold),
      markRead: (jid, id) => this.markRead(jid, id),
      presence: (jid, state) => this.presence(jid, state),
      send: (jid, text, replyTo, media) => this.deliver(jid, text, replyTo, media),
    });
    if (config.sweUrl) {
      this.log('SWE_CODE_AGENT_WEBHOOK_URL is deprecated and ignored; code requests go out as secretary events');
    }
  }

  /** Queued and recently sent counts. Does not include message text. */
  paceStatus(): PaceStatus {
    return this.paced.status();
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, 15_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = undefined;
    await this.flushOutbox(true);
  }

  handleNotify(message: unknown): void {
    try {
      const inbound = parseInbound(message);
      if (!inbound) return;
      void this.handleInbound(inbound).catch(() => this.log('inbound failed'));
    } catch {
      this.log('inbound failed');
    }
  }

  async handleInbound(message: Inbound): Promise<void> {
    if (message.fromMe || message.stub) return;
    if (this.skipForwarding(message.senderJid, phoneFromJid(message.altJid) || this.senderPhone(message), true)) return;
    if (message.id && this.seen.has(message.id)) return;
    this.remember(message.id);
    if (isIgnorableChat(message.chatJid)) return;
    const text = actionableText(message.text);
    if (!text) return;

    const group = message.chatJid.endsWith('@g.us');
    if (group && !this.config.groupAll) {
      let accounts: string[] = [];
      try {
        accounts = accountJids(this.wa.getAccount());
      } catch {
        accounts = [];
      }
      if (!addressedToDavid(text, message.mentions ?? [], accounts, message.replyParticipant ?? '')) {
        this.log(`event=ignored reason=not_addressed chat=${message.chatJid} message=${message.id || '-'}`);
        return;
      }
    }

    const phone = this.senderPhone(message);
    this.noteHeard(message, phone);
    const ownerDm = !group && this.config.ownerPhone.length > 0 && phone === this.config.ownerPhone;
    const intent = classify(text, { isOwnerDm: ownerDm });
    const identity = this.identity();
    const context = this.contextFor(message, identity);
    const language = this.languageFor(message, phone, text, context);
    let hint = eventHint(intent);
    let code: Record<string, unknown> | null = null;
    if (intent.kind === 'code') {
      const repo = intent.repo ?? extractRepo(text);
      if (repo && phone && this.store.canCode(phone, repo)) {
        const issuedAt = this.now().toISOString();
        const row = this.store.createCode({
          requesterPhone: phone,
          repo,
          ask: text,
          chatId: message.chatJid,
          issuedAt,
          lang: language,
          messageId: message.id || null,
        });
        code = {
          request_id: row.requestId,
          repo: row.repo,
          callback_url: codeCallbackUrl(this.config.callbackPublicBase),
          ask: text.slice(0, 2000),
        };
        hint = 'code';
      } else if (repo) {
        hint = 'code_denied';
      } else {
        hint = 'code';
      }
    }

    const account = snakeAccount(identity);
    const event: Record<string, unknown> = {
      type: 'inbound_message',
      ...account,
      chat_jid: message.chatJid,
      chat_name: this.chatName(message),
      is_group: group,
      sender_jid: message.senderJid,
      sender_phone: phone,
      sender_name: message.pushName || '',
      message_id: message.id || '',
      text,
      timestamp: isoFrom(message.timestampMs, this.now()),
      reply: message.replyToId
        ? { message_id: message.replyToId, participant: message.replyParticipant || '', text: message.quotedText || '' }
        : null,
      language,
      hint,
      context,
    };
    if (hint === 'code' || hint === 'code_denied') event.code = code;

    const messageId = message.id || `anon-${message.timestampMs || this.now().getTime()}`;
    const queued = this.enqueue(event, message.chatJid, messageId);
    this.log(`event=queued hint=${hint ?? 'none'} chat=${message.chatJid} message=${message.id || '-'}`);

    if (intent.kind === 'command') await this.runCommand(message, intent.command);
    else if (ownerDm && intent.kind === 'chat') {
      const decision = shortOwnerDecision(text);
      if (decision) await this.resolveAwaitingFromOwner(message.chatJid, decision);
    }
    await queued;
  }

  /** MCP and any other explicit send. Same queue as owner commands and the callback. */
  sendOutbound(input: { jid: string; text: string; replyTo?: string | null; media?: OutboundMedia | null }): Promise<PaceResult> {
    const blocked = this.sendingDisabled();
    if (blocked) return Promise.resolve(blocked);
    const replyTo = input.replyTo?.trim() || null;
    return this.paced.send({
      jid: input.jid,
      text: input.text,
      replyTo,
      ...(input.media ? { media: input.media } : {}),
      readId: replyTo || this.lastInbound.get(input.jid) || null,
    }).then((result) => {
      if (!result.ok) this.log(`send=refused reason=${result.error} chat=${input.jid}`);
      return result;
    });
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const oldest = this.store.oldestUnsentAt();
      if (oldest == null) return;
      const due = this.config.escalationBatchMs <= 0 || this.now().getTime() >= oldest + this.config.escalationBatchMs;
      if (due) await this.flushOutbox(false);
      else this.armWindow(oldest);
    } finally {
      this.ticking = false;
    }
  }

  /** MCP admin surface. The bearer token on this session is the owner's admin credential. */
  actions() {
    return {
      resolveEscalation: (input: ResolveInput) => this.resolve(input, 'mcp'),
      allowlistList: async () => ({
        ok: true,
        owner_phone: this.config.ownerPhone,
        entries: this.store.listAllowlist(),
      }),
      allowlistGrant: async (input: { phone: string; repo: string }) => this.grant(input.phone, input.repo),
      allowlistRevoke: async (input: { phone: string; repo?: string }) => this.revoke(input.phone, input.repo),
      codeStatus: async (input: { request_id: string }) => this.codeStatus(input.request_id),
      approvedList: async () => approvedMcpView(this.store, this.now(), this.config.timezone),
      approvedAdd: (input: { identifier: string; display_name?: string; approved_by: string; reason: string }) => this.approvedAdd(input),
      approvedRemove: async (input: { identifier: string }): Promise<Record<string, unknown>> => removeApprovedContact({
        store: this.store,
        identifier: input.identifier,
        actor: 'mcp',
        now: this.now(),
        timeZone: this.config.timezone,
        log: (line) => this.log(line),
      }),
    };
  }

  /** Phone JID for a send or a draft. Throws a message the tool can return. */
  async resolveOutboundJid(raw: string, purpose: 'send' | 'draft'): Promise<string> {
    const resolved = await this.resolveDirect(raw, purpose);
    if (!resolved.ok) throw new Error(resolved.error);
    return assertPhoneStaysDirect(raw, resolved.jid);
  }

  resolveForAllowlist(raw: string): Promise<{ ok: true; contact: { jid: string; phone: string; lid: string | null } } | { ok: false; error: string }> {
    return this.resolveDirect(raw, 'allowlist').then((resolved) => {
      if (!resolved.ok) return resolved;
      if (!resolved.phone) return { ok: false, error: 'Approved contacts are direct chats, not groups.' };
      return { ok: true, contact: { jid: resolved.jid, phone: resolved.phone, lid: resolved.lid } };
    });
  }

  private approvedAdd(input: { identifier: string; display_name?: string; approved_by: string; reason: string }): Promise<Record<string, unknown>> {
    return addApprovedContact({
      store: this.store,
      identifier: input.identifier,
      displayName: input.display_name ?? '',
      note: input.reason,
      addedBy: input.approved_by,
      now: this.now(),
      timeZone: this.config.timezone,
      resolve: (identifier) => this.resolveForAllowlist(identifier),
      log: (line) => this.log(line),
    }).then((result) => {
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        contact: {
          jid: result.contact.jid,
          phone: result.contact.phone,
          display_name: result.contact.displayName,
          note: result.contact.note,
          added_by: result.contact.addedBy,
          added_at: result.contact.addedAt,
          lid: result.contact.lid,
        },
      };
    });
  }

  async handleCallback(authorization: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const secret = this.config.callbackSecret;
    if (!secret) return { status: 503, body: { error: 'callback_disabled' } };
    if (!bearerMatches(authorization, secret)) return { status: 401, body: { error: 'unauthorized' } };
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, body: { error: 'invalid_body' } };
    const record = body as { request_id?: unknown; status?: unknown; pr_url?: unknown; summary?: unknown };
    const requestId = typeof record.request_id === 'string' ? record.request_id.trim() : '';
    if (!UUID_RE.test(requestId)) return { status: 400, body: { error: 'invalid_request_id' } };
    const row = this.store.getCode(requestId);
    if (!row) return { status: 404, body: { error: 'not_found' } };
    const prUrl = typeof record.pr_url === 'string' ? httpsUrl(record.pr_url) : null;
    const rawStatus = typeof record.status === 'string' ? record.status : '';
    const status = rawStatus || (prUrl ? 'done' : '');
    if (status !== 'ack' && status !== 'done' && status !== 'failed') return { status: 400, body: { error: 'invalid_status' } };
    const summary = typeof record.summary === 'string' ? record.summary.replace(/\s+/g, ' ').trim().slice(0, 300) : null;
    if (row.status === 'done') {
      if (status === 'done' && row.prUrl && prUrl === row.prUrl) {
        return { status: 200, body: { ok: true, duplicate: true, request_id: requestId, status: 'done' } };
      }
      return { status: 409, body: { ok: false, status: 409, error: 'already_done', request_id: requestId, pr_url: row.prUrl } };
    }
    const at = this.now().toISOString();
    if (status === 'ack') {
      if (row.status === 'pending') this.store.markCode(requestId, 'acked', null, summary, at);
      return { status: 200, body: { ok: true, request_id: requestId, status: 'acked' } };
    }
    if (status === 'failed') {
      if (row.status !== 'failed') {
        this.store.markCode(requestId, 'failed', null, summary, at);
        await this.tell(row.chatId, this.canned('code_failed_notice', row.lang), row.messageId);
      }
      return { status: 200, body: { ok: true, request_id: requestId, status: 'failed' } };
    }
    if (!prUrl) return { status: 400, body: { error: 'pr_url is required' } };
    this.store.markCode(requestId, 'done', prUrl, summary, at);
    const extra = summary?.replace(/\s+/g, ' ').trim().slice(0, 160) ?? '';
    const reply = extra
      ? this.canned('pull_request', row.lang, { url: prUrl, summary: extra })
      : this.canned('pull_request_plain', row.lang, { url: prUrl });
    await this.tell(row.chatId, reply, row.messageId);
    return { status: 200, body: { ok: true, request_id: requestId, status: 'done', pr_url: prUrl } };
  }

  async handleCallbackHttp(req: Request, res: Response): Promise<void> {
    const result = await this.handleCallback(req.header('authorization') ?? '', req.body);
    res.status(result.status).json(result.body);
  }

  private async resolve(input: ResolveInput, via: 'mcp' | 'whatsapp', notifyJid?: string): Promise<Record<string, unknown>> {
    const existing = this.store.getEscalation(input.request_id);
    if (!existing) return { ok: false, status: 404, error: 'not_found', request_id: input.request_id };
    if (existing.status === 'resolved') return alreadyResolved(existing);
    if (input.decision === 'edit' && !input.edited_action?.trim()) {
      return { ok: false, status: 400, error: 'edited_action is required when decision is edit' };
    }
    const updated = this.store.resolveEscalation(input.request_id, {
      decision: input.decision,
      note: input.note?.trim() || null,
      editedAction: input.edited_action?.trim() || null,
      via,
      at: this.now().toISOString(),
    });
    if (!updated) {
      const again = this.store.getEscalation(input.request_id);
      return again ? alreadyResolved(again) : { ok: false, status: 404, error: 'not_found', request_id: input.request_id };
    }
    if (via === 'whatsapp' && notifyJid) {
      await this.tell(notifyJid, ownerDecisionLine(input.decision, updated.requestId));
    }
    return { ok: true, status: 200, request_id: updated.requestId, decision: updated.decision, resolved_via: via };
  }

  private grant(phoneRaw: string, repoRaw: string): Record<string, unknown> {
    const phone = normalizePhone(phoneRaw);
    const repo = normalizeRepo(repoRaw);
    if (!phone) return { ok: false, status: 400, error: 'phone must be 8 to 15 digits' };
    if (!repo) return { ok: false, status: 400, error: 'repo must be * or owner/name' };
    this.store.grant(phone, repo);
    return { ok: true, phone, repo, repos: this.store.reposFor(phone) };
  }

  private revoke(phoneRaw: string, repoRaw?: string): Record<string, unknown> {
    const phone = normalizePhone(phoneRaw);
    if (!phone) return { ok: false, status: 400, error: 'phone must be 8 to 15 digits' };
    if (phone === this.config.ownerPhone) return { ok: false, status: 403, error: 'owner access cannot be revoked' };
    const repo = repoRaw == null || repoRaw.trim() === '' ? null : normalizeRepo(repoRaw);
    if (repoRaw && !repo) return { ok: false, status: 400, error: 'repo must be * or owner/name' };
    const removed = this.store.revoke(phone, repo);
    return { ok: true, phone, repo, removed, repos: this.store.reposFor(phone) };
  }

  private codeStatus(requestId: string): Record<string, unknown> {
    const row = this.store.getCode(requestId);
    if (!row) return { ok: false, status: 404, error: 'not_found', request_id: requestId };
    return {
      ok: true,
      request_id: row.requestId,
      status: row.status,
      repo: row.repo,
      pr_url: row.prUrl,
      requester_phone: row.requesterPhone,
      chat_id: row.chatId,
      issued_at: row.issuedAt,
      updated_at: row.updatedAt,
    };
  }

  private async runCommand(message: Inbound, command: OwnerCommand): Promise<void> {
    const chatJid = message.chatJid;
    const replyTo = message.id || null;
    if (command.name === 'status') {
      const quiet = this.store.getSetting('quiet') ?? 'off';
      const open = this.store.countEscalations(['open', 'awaiting_owner']);
      const code = this.store.countCode(['pending', 'acked']);
      await this.tell(chatJid, `Open escalations: ${open}. Code requests in flight: ${code}. Quiet hours: ${quiet}.`, replyTo);
      return;
    }
    if (command.name === 'quiet_show') {
      await this.tell(chatJid, `Quiet hours: ${this.store.getSetting('quiet') ?? 'off'}.`, replyTo);
      return;
    }
    if (command.name === 'quiet_invalid') {
      await this.tell(chatJid, 'Use /quiet off or /quiet 22:00-08:00.', replyTo);
      return;
    }
    if (command.name === 'quiet_set') {
      this.store.setSetting('quiet', command.window ?? 'off');
      await this.tell(chatJid, `Quiet hours: ${command.window ?? 'off'}.`, replyTo);
      return;
    }
    if (command.name === 'allowlist_list') {
      const lines = this.store.listAllowlist().slice(0, 30).map((entry) => `${entry.phone} ${entry.repos.join(',')}`);
      await this.tell(chatJid, ['Allowlist:', ...lines].join('\n').slice(0, 3500), replyTo);
      return;
    }
    if (command.name === 'allowlist_usage') {
      await this.tell(chatJid, 'Use /allowlist, /allowlist grant <phone> <owner/name>, or /allowlist revoke <phone> [owner/name].', replyTo);
      return;
    }
    if (command.name === 'allowlist_grant') {
      const result = this.grant(command.phone, command.repo);
      await this.tell(chatJid, result.ok ? `Granted ${result.phone} ${result.repo}.` : String(result.error), replyTo);
      return;
    }
    if (command.name === 'allowlist_revoke') {
      const result = this.revoke(command.phone, command.repo ?? undefined);
      await this.tell(chatJid, result.ok ? `Revoked ${result.removed} row(s) for ${result.phone}.` : String(result.error), replyTo);
      return;
    }
    if (command.name === 'approve' || command.name === 'deny') {
      await this.resolveCommand(chatJid, command.name, command.requestId, replyTo);
      return;
    }
    if (command.name === 'edit') {
      const result = await this.resolve({
        request_id: command.requestId,
        decision: 'edit',
        edited_action: command.text,
      }, 'whatsapp', chatJid);
      if (result.status === 404) await this.tell(chatJid, 'No escalation with that id.', replyTo);
      else if (result.status === 409) await this.tell(chatJid, 'That escalation is already resolved.', replyTo);
    }
  }

  private async resolveCommand(chatJid: string, decision: 'approve' | 'deny', requestId: string | null, replyTo: string | null): Promise<void> {
    const id = requestId ?? this.onlyOpenId();
    if (!id) {
      const open = this.store.listEscalations(['open', 'awaiting_owner']);
      await this.tell(chatJid, open.length === 0
        ? 'No open escalation.'
        : 'More than one is open. Reply /approve <request_id> or /deny <request_id>.', replyTo);
      return;
    }
    const result = await this.resolve({ request_id: id, decision }, 'whatsapp', chatJid);
    if (result.status === 404) await this.tell(chatJid, 'No escalation with that id.', replyTo);
    else if (result.status === 409) await this.tell(chatJid, 'That escalation is already resolved.', replyTo);
  }

  private async resolveAwaitingFromOwner(chatJid: string, decision: 'approve' | 'deny'): Promise<boolean> {
    const waiting = this.store.listEscalations(['awaiting_owner']);
    if (waiting.length === 0) return false;
    if (waiting.length > 1) {
      await this.tell(chatJid, 'More than one is waiting. Reply /approve <request_id> or /deny <request_id>.');
      return true;
    }
    const only = waiting[0];
    if (!only) return false;
    await this.resolve({ request_id: only.requestId, decision }, 'whatsapp', chatJid);
    return true;
  }

  private onlyOpenId(): string | null {
    const open = this.store.listEscalations(['open', 'awaiting_owner']);
    return open.length === 1 ? open[0]?.requestId ?? null : null;
  }

  private skipForwarding(senderJid: string, phone: string, drop = false): boolean {
    const operation = drop ? 'drop' : 'skip';
    return this.store.webhookBlocklist[operation](senderJid, jid => this.wa.getStore().phoneForJid?.(jid) ?? '')
      || (!!phone && this.store.webhookBlocklist[operation](phone));
  }

  private async enqueue(event: unknown, chatId: string, messageId: string): Promise<void> {
    const inserted = this.store.enqueueOutbox({
      chatId,
      messageId,
      body: event,
      enqueuedAt: this.now().getTime(),
    });
    if (!inserted) return;
    if (this.config.escalationBatchMs <= 0) {
      await this.flushOutbox(true);
      return;
    }
    const oldest = this.store.oldestUnsentAt();
    if (oldest == null) return;
    if (this.now().getTime() >= oldest + this.config.escalationBatchMs) {
      await this.flushOutbox(false);
      return;
    }
    this.armWindow(oldest);
  }

  private async flushOutbox(force: boolean): Promise<void> {
    if (this.flushing) await this.flushing;
    if (this.flushing) return;
    let again = false;
    const job = (async () => {
      again = await this.flushOnce(force);
    })();
    this.flushing = job;
    try {
      await job;
    } finally {
      if (this.flushing === job) this.flushing = null;
    }
    if (again) await this.flushOutbox(this.config.escalationBatchMs <= 0);
  }

  /** True when another due batch is still unsent after a successful post. */
  private async flushOnce(force: boolean): Promise<boolean> {
    const oldest = this.store.oldestUnsentAt();
    if (oldest == null) {
      this.clearWindow();
      return false;
    }
    const due = force || this.config.escalationBatchMs <= 0 || this.now().getTime() >= oldest + this.config.escalationBatchMs;
    if (!due) return false;
    const rows = this.store.unsentEvents(100);
    if (rows.length === 0) return false;
    const allowed = rows.filter(row => {
      const event = row.body as { sender_jid?: string; sender_phone?: string };
      const blocked = this.skipForwarding(event.sender_jid || '', event.sender_phone || '');
      if (blocked) this.store.markOutboxSent([row.id], this.now().getTime());
      return !blocked;
    });
    if (!allowed.length) {
      this.clearWindow();
      return this.store.oldestUnsentAt() != null;
    }
    const identity = snakeAccount(this.identity());
    const body = { ...identity, style: this.styleGuide(), events: allowed.map((row) => row.body) };
    const at = this.now().getTime();
    let ok = false;
    if (!this.config.secretaryUrl) {
      if (!this.loggedSecretaryMissing) {
        this.log('secretary webhook unset; events stored locally');
        this.loggedSecretaryMissing = true;
      }
      ok = true;
    } else {
      const result = await postJson(this.config.secretaryUrl, this.config.secretaryKey, body, this.deps.fetch ?? fetch);
      this.log(`secretary post events=${allowed.length} ok=${result.ok} status=${result.status}`);
      ok = result.ok;
    }
    if (ok) this.store.markOutboxSent(rows.map((row) => row.id), at);
    this.clearWindow();
    const next = this.store.oldestUnsentAt();
    if (!ok || next == null) return false;
    if (this.config.escalationBatchMs <= 0 || this.now().getTime() >= next + this.config.escalationBatchMs) return true;
    this.armWindow(next);
    return false;
  }

  private armWindow(oldest: number): void {
    if (this.config.escalationBatchMs <= 0) return;
    const deadline = oldest + this.config.escalationBatchMs;
    if (this.windowTimer && this.windowDeadline === deadline) return;
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowDeadline = deadline;
    const wait = Math.max(0, deadline - this.now().getTime());
    this.windowTimer = setTimeout(() => { void this.flushOutbox(false); }, wait);
    this.windowTimer.unref?.();
  }

  private clearWindow(): void {
    this.windowDeadline = null;
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = undefined;
  }

  private sendingDisabled(): PaceResult | null {
    if (this.deps.allowSend !== false) return null;
    this.log('outbound refused: ALLOW_SEND=false');
    return { ok: false, error: 'send_failed' };
  }

  private async tell(jid: string, text: string, replyTo?: string | null): Promise<boolean> {
    if (this.sendingDisabled()) return false;
    const result = await this.paced.send({
      jid,
      text,
      replyTo: replyTo ?? null,
      readId: replyTo || this.lastInbound.get(jid) || null,
    });
    if (!result.ok) this.log(`send=refused reason=${result.error} chat=${jid}`);
    return result.ok;
  }

  private senderPhone(message: Inbound): string {
    const direct = phoneFromJid(message.senderJid) || phoneFromJid(message.altJid || '');
    if (direct) return direct;
    try {
      const store = this.wa.getStore();
      const linked = store.phoneForJid?.(message.senderJid) || (message.altJid ? store.phoneForJid?.(message.altJid) : '') || '';
      if (linked) return linked;
    } catch {
      // History lookup is optional for fakes.
    }
    if (!message.senderJid.toLowerCase().endsWith('@lid')) return '';
    const user = message.senderJid.split('@')[0] ?? '';
    try {
      for (const contact of this.wa.getStore().contacts.values()) {
        const lid = String(contact.lid ?? '');
        if (lid !== message.senderJid && !lid.startsWith(`${user}@`) && lid !== user) continue;
        const fromContact = phoneFromJid(String(contact.phoneNumber ?? ''));
        if (fromContact) return fromContact;
        const digits = String(contact.phoneNumber ?? '').replace(/\D/g, '');
        if (/^\d{8,15}$/.test(digits)) return digits;
      }
    } catch {
      return '';
    }
    return '';
  }

  private noteHeard(message: Inbound, phone: string): void {
    this.heard.add(message.chatJid.toLowerCase());
    this.heard.add(message.senderJid.toLowerCase());
    if (message.altJid) this.heard.add(message.altJid.toLowerCase());
    if (phone) this.heard.add(phone);
    if (message.id) this.lastInbound.set(message.chatJid, message.id);
  }

  private allowJid(jid: string): AllowDecision {
    const bare = jid.split(':')[0]?.trim().toLowerCase() ?? '';
    if (!bare) return { allow: false, error: 'cold_contact' };
    if (bare.endsWith('@g.us')) {
      if (this.heard.has(bare)) return { allow: true, cold: null };
      try {
        return this.wa.getStore().knownGroup?.(jid) ? { allow: true, cold: null } : { allow: false, error: 'cold_contact' };
      } catch {
        return { allow: false, error: 'cold_contact' };
      }
    }
    const phone = phoneFromJid(bare);
    const heard = this.heard.has(bare) || (phone !== '' && this.heard.has(phone)) || this.heardInStore(jid, phone);
    if (heard) return { allow: true, cold: null };
    const approved = this.store.findApproved(bare);
    if (approved) {
      const cap = readColdPerDay(this.store.getSetting(COLD_PER_DAY_KEY));
      const used = this.store.countColdSends(localDay(this.now(), this.config.timezone));
      if (used >= cap) return { allow: false, error: 'cold_cap' };
      return { allow: true, cold: { jid: approved.jid, phone: approved.phone } };
    }
    if (phone && this.store.reposFor(phone).length > 0) return { allow: true, cold: null };
    return { allow: false, error: 'cold_contact' };
  }

  private heardInStore(jid: string, phone: string): boolean {
    try {
      return Boolean(this.wa.getStore().heardFrom?.(jid, phone));
    } catch {
      return false;
    }
  }

  private recordCold(cold: { jid: string; phone: string }): void {
    const now = this.now();
    this.store.recordColdSend({
      jid: cold.jid,
      phone: cold.phone,
      at: now.toISOString(),
      day: localDay(now, this.config.timezone),
    });
    this.log(`approved=cold_send jid=${cold.jid} phone=${cold.phone}`);
  }

  private async resolveDirect(raw: string, purpose: 'send' | 'draft' | 'allowlist'): Promise<
    { ok: true; jid: string; phone: string; lid: string | null } | { ok: false; error: string }
  > {
    const parsed = parseRecipient(raw);
    if (!parsed.ok) return parsed;
    if (parsed.kind === 'group') {
      if (purpose === 'allowlist') return { ok: false, error: 'Approved contacts are direct chats, not groups.' };
      return { ok: true, jid: parsed.jid, phone: '', lid: null };
    }
    let phoneJid = parsed.kind === 'pn' ? parsed.jid : '';
    const lid = parsed.kind === 'lid' ? parsed.lid : null;
    let mapped = false;
    if (parsed.kind === 'lid') {
      const local = await this.localPnForLid(parsed.lid);
      const remote = local ? null : await this.remotePnForLid(parsed.lid);
      const pn = local ?? remote;
      if (!pn) return { ok: false, error: unresolvedLid(parsed.lid) };
      phoneJid = pn;
      mapped = true;
    }
    if (!this.needsWhatsAppLookup(phoneJid, mapped, purpose)) {
      this.rememberLink(phoneJid, lid);
      return { ok: true, jid: phoneJid, phone: phoneFromJid(phoneJid), lid };
    }
    const phone = phoneFromJid(phoneJid);
    const saved = phone ? this.store.lookupWhatsApp(phone, this.now()) : null;
    // A cached answer that is not a phone JID is never trusted.
    const cached = saved && (!saved.exists || normalizePn(saved.jid)) ? saved : null;
    if (cached) {
      if (!cached.exists) return { ok: false, error: 'That number is not on WhatsApp.' };
      this.rememberLink(cached.jid, lid);
      return { ok: true, jid: cached.jid, phone: phoneFromJid(cached.jid), lid };
    }
    const checked = await this.checkOnWhatsApp(phoneJid);
    if (!checked.ok) {
      if (checked.error === 'That number is not on WhatsApp.' && phone) {
        this.store.saveWhatsAppLookup(phone, phoneJid, false, this.now().toISOString());
      }
      return checked;
    }
    this.store.saveWhatsAppLookup(phoneFromJid(checked.jid), checked.jid, true, this.now().toISOString());
    this.rememberLink(checked.jid, lid);
    return { ok: true, jid: checked.jid, phone: phoneFromJid(checked.jid), lid };
  }

  /** onWhatsApp is only for a never-seen number on allowlist add or a first cold send. */
  private needsWhatsAppLookup(phoneJid: string, mapped: boolean, purpose: 'send' | 'draft' | 'allowlist'): boolean {
    if (purpose === 'draft' || mapped) return false;
    if (this.knownPhone(phoneJid)) return false;
    if (purpose === 'allowlist') return true;
    return purpose === 'send' && Boolean(this.store.findApproved(phoneJid));
  }

  private knownPhone(phoneJid: string): boolean {
    try {
      return Boolean(this.wa.getStore().knownPhoneJid?.(phoneJid));
    } catch {
      return false;
    }
  }

  private async localPnForLid(lid: string): Promise<string | null> {
    const fromSocket = await pnFromBaileys(this.wa.getSocket(), lid);
    if (fromSocket) return fromSocket;
    return pnFromStore(this.wa.getStore(), lid);
  }

  private async remotePnForLid(lid: string): Promise<string | null> {
    const peer = this.deps.personalLid;
    if (!peer?.url || !peer.secret) return null;
    return lookupPersonalPn({
      baseUrl: peer.url,
      secret: peer.secret,
      lid,
      fetchImpl: peer.fetch,
    });
  }

  private async checkOnWhatsApp(phoneJid: string): Promise<{ ok: true; jid: string } | { ok: false; error: string }> {
    const sock = this.wa.getSocket();
    if (!sock?.onWhatsApp || this.wa.getStatus().state !== 'open') {
      return { ok: false, error: 'WhatsApp is not connected, so this number cannot be checked.' };
    }
    try {
      const results = await sock.onWhatsApp(phoneJid);
      const hit = results?.[0];
      if (!hit?.exists) return { ok: false, error: 'That number is not on WhatsApp.' };
      return { ok: true, jid: normalizePn(hit.jid) ?? phoneJid };
    } catch {
      return { ok: false, error: 'WhatsApp could not check this number.' };
    }
  }

  private rememberLink(pn: string, lid: string | null): void {
    if (!pn || !lid) return;
    try {
      this.wa.getStore().linkJids?.(pn, lid);
    } catch {
      // History is optional for fakes.
    }
  }

  private identity(): BridgeAccount {
    const source: { id?: string; lid?: string; phoneNumber?: string; pairedJid?: string; pairedNumber?: string } = {};
    try {
      const status = this.wa.getStatus();
      source.pairedJid = status.pairedJid;
      source.pairedNumber = status.pairedNumber;
    } catch {
      // Status is optional.
    }
    try {
      Object.assign(source, this.wa.getAccount());
    } catch {
      // Account is optional for fakes.
    }
    return bridgeAccount(this.config.role || 'david', source);
  }

  private chatName(message: Inbound): string {
    try {
      const title = this.wa.getStore().chatTitle?.(message.chatJid) ?? '';
      if (title) return title.slice(0, 120);
    } catch {
      // No history name.
    }
    if (!message.chatJid.endsWith('@g.us')) return (message.pushName || '').slice(0, 80);
    return '';
  }

  private contextFor(message: Inbound, account: BridgeAccount): Array<Record<string, unknown>> {
    let rows: ContextRow[] = [];
    try {
      rows = this.wa.getStore().recentChatContext?.(message.chatJid, this.config.contextMessages || 10, message.id) ?? [];
    } catch {
      rows = [];
    }
    return rows.map((row) => {
      const senderJid = row.fromMe
        ? (account.accountJid ?? '')
        : (row.participant || (message.chatJid.endsWith('@g.us') ? '' : message.chatJid));
      let senderPhone = phoneFromJid(senderJid);
      if (!senderPhone) {
        try {
          senderPhone = this.wa.getStore().phoneForJid?.(senderJid) || '';
        } catch {
          senderPhone = '';
        }
      }
      const item: Record<string, unknown> = {
        message_id: row.id,
        from_me: row.fromMe,
        sender_jid: senderJid,
        sender_phone: senderPhone,
        text: row.text,
        timestamp: isoFrom(storeMillis(row.timestamp), this.now()),
      };
      if (row.fromMe) item.sent_by_account = account.account;
      return item;
    });
  }

  private languageFor(
    message: Inbound,
    phone: string,
    text: string,
    context: Array<Record<string, unknown>>,
  ): Lang {
    const key = `${message.chatJid}\n${phone || message.senderJid}`;
    const signal = languageSignal(text);
    if (signal) {
      this.store.setChatLang(key, signal, this.now().toISOString());
      return signal;
    }
    const stored = this.store.getChatLang(key);
    if (stored) return stored;
    const owner = this.config.ownerPhone;
    const currentIsOwner = Boolean(owner) && phone === owner;
    for (const item of context) {
      if (item.from_me === true) continue;
      const senderPhone = typeof item.sender_phone === 'string' ? item.sender_phone : '';
      if (!currentIsOwner && owner && senderPhone === owner) continue;
      const sample = typeof item.text === 'string' ? item.text : '';
      const found = languageSignal(sample);
      if (found) {
        this.store.setChatLang(key, found, this.now().toISOString());
        return found;
      }
    }
    return defaultLanguage(phone);
  }

  private async markRead(jid: string, id: string): Promise<void> {
    if (this.deps.markRead) {
      await this.deps.markRead(jid, id);
      return;
    }
    const sock = this.wa.getSocket();
    if (!sock?.readMessages) return;
    await sock.readMessages([{ remoteJid: jid, id, fromMe: false }]);
  }

  private async presence(jid: string, state: 'composing' | 'paused'): Promise<void> {
    if (this.deps.presence) {
      await this.deps.presence(jid, state);
      return;
    }
    const sock = this.wa.getSocket();
    if (!sock?.sendPresenceUpdate) return;
    await sock.sendPresenceUpdate(state, jid);
  }

  private async deliver(jid: string, text: string, replyTo?: string | null, media?: OutboundMedia | null): Promise<{ ok: boolean; messageId?: string }> {
    if (this.deps.allowSend === false) {
      this.log('outbound refused: ALLOW_SEND=false');
      return { ok: false };
    }
    const outbound = this.outboundText(text);
    if (this.deps.send) {
      const result = await this.deps.send(jid, outbound, { replyTo: replyTo ?? null, ...(media ? { media } : {}) });
      if (typeof result === 'boolean') return { ok: result, messageId: result ? '1' : undefined };
      return { ok: result.ok, messageId: result.messageId };
    }
    const sock = this.wa.getSocket();
    if (!sock || this.wa.getStatus().state !== 'open') return { ok: false };
    try {
      // Quote the saved original so WhatsApp shows its text and real sender.
      // Unknown ids send without a quote instead of a blank "You" quote.
      const { quoted } = replyQuote(this.wa.getStore(), jid, replyTo);
      const content: AnyMessageContent = media ? mediaContent(media, outbound) : { text: outbound };
      const sent = await sock.sendMessage(jid, content, quoted ? { quoted } : undefined);
      if (sent) {
        try {
          this.wa.getStore().upsertMessage(sent as never);
        } catch {
          // The send was accepted. History is best-effort.
        }
      }
      return { ok: Boolean(sent?.key?.id), messageId: sent?.key?.id ?? undefined };
    } catch {
      this.log('outbound failed');
      return { ok: false };
    }
  }

  private styleGuide(): string {
    return styleGuideText(this.store.getSetting('style.guide'));
  }

  private canned(id: CannedId, lang: Lang, vars: Record<string, string> = {}): string {
    return renderCanned(id, lang, this.store.getSetting(lineSettingKey(id, lang)), vars);
  }

  /** Last step before WhatsApp. Personal never calls this. */
  private outboundText(text: string): string {
    if (!stripEnabled(this.store.getSetting('style.strip'))) return text;
    return stripInvertedPunctuation(text);
  }

  private delay(ms: number): Promise<void> {
    if (this.deps.delay) return this.deps.delay(ms);
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  private remember(id: string): void {
    if (!id) return;
    this.seen.add(id);
    if (this.seen.size <= 500) return;
    const first = this.seen.values().next().value;
    if (first) this.seen.delete(first);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private log(line: string): void {
    let safe = line;
    const secrets = [this.config.secretaryKey, this.config.sweKey, this.config.callbackSecret, this.deps.personalLid?.secret ?? ''];
    for (const secret of secrets) {
      if (secret.length >= 4) safe = safe.split(secret).join('[redacted]');
    }
    (this.deps.log ?? ((entry: string) => console.log(entry)))(`[whatsapp-bridge:david] ${safe}`);
  }
}

function snakeAccount(account: BridgeAccount): { account: string; account_jid: string | null; account_phone: string | null } {
  return {
    account: account.account,
    account_jid: account.accountJid,
    account_phone: account.accountPhone,
  };
}

function isoFrom(ms: number, fallback: Date): string {
  const value = Number.isFinite(ms) && ms > 0 ? ms : fallback.getTime();
  return new Date(value).toISOString();
}

function storeMillis(timestamp: number | null): number {
  if (timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0) return 0;
  return timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
}

function ownerDecisionLine(decision: 'approve' | 'deny' | 'edit', requestId: string): string {
  if (decision === 'approve') return `Approved ${requestId}.`;
  if (decision === 'deny') return `Denied ${requestId}.`;
  return `Saved the edit for ${requestId}.`;
}

function alreadyResolved(row: EscalationRow): Record<string, unknown> {
  return {
    ok: false,
    status: 409,
    error: 'already_resolved',
    request_id: row.requestId,
    decision: row.decision,
    resolved_via: row.resolvedVia,
    note: row.note,
    edited_action: row.editedAction,
  };
}

function bearerMatches(header: string, secret: string): boolean {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  const token = match?.[1] ?? '';
  const left = Buffer.from(token);
  const right = Buffer.from(secret);
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function httpsUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
