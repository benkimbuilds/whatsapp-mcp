import type { WebhookBlocklist } from './webhook-blocklist.js';
import type { WAMessage } from '@whiskeysockets/baileys';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  accountIdentity,
  GroupQueryGuard,
  isGroupJid,
  linkAndFilter,
  projectGroup,
  projectGroups,
  publicGroupError,
} from './group-info.js';
import { bridgeAccount, type AccountSource } from './account.js';
import {
  MEDIA_MAX_BYTES,
  MISSING_MEDIA_KEY,
  MediaDownloadError,
  buildDownloadMessage,
  describeMedia,
  downloadBaileysMedia,
  downloadPreparedMedia,
  looksLikeMediaPlaceholder,
  mediaTooLargeMessage,
} from './media.js';
import type { WhatsAppSession } from './whatsapp.js';
import { isSingleEmoji, replyQuote } from './quote.js';
import { assertPhoneStaysDirect, classifyRecipient } from './recipient.js';
import { MediaSendError, loadOutboundMedia, mediaContent, type OutboundKind, type OutboundMedia } from './media-send.js';

export { replyQuote } from './quote.js';

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
  };
}

const BRIDGE_VERSION = '1.0.0';
/** Time this process started. Not a compile timestamp and not stored. */
const BRIDGE_BUILD_TIME = new Date().toISOString();

function errResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true as const,
  };
}

function savedChatJid(chat: string): string {
  const trimmed = chat.trim();
  if (trimmed.includes('@')) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) throw new Error('chat must be a chat JID.');
  return `${digits}@s.whatsapp.net`;
}

export type DavidActionApi = {
  resolveEscalation(input: {
    request_id: string;
    decision: 'approve' | 'deny' | 'edit';
    note?: string;
    edited_action?: string;
  }): Promise<Record<string, unknown>>;
  allowlistList(): Promise<Record<string, unknown>>;
  allowlistGrant(input: { phone: string; repo: string }): Promise<Record<string, unknown>>;
  allowlistRevoke(input: { phone: string; repo?: string }): Promise<Record<string, unknown>>;
  codeStatus(input: { request_id: string }): Promise<Record<string, unknown>>;
  approvedList(): Promise<Record<string, unknown>>;
  approvedAdd(input: { identifier: string; display_name?: string; approved_by: string; reason: string }): Promise<Record<string, unknown>>;
  approvedRemove(input: { identifier: string }): Promise<Record<string, unknown>>;
};

export type BridgeSessionOptions = {
  /** Account-local policy; David passes the list in david.sqlite. */
  webhookBlocklist?: WebhookBlocklist;
  /** personal, assistant, or another short label for this process. */
  role: string;
  /** When false, whatsapp_send_text, whatsapp_send_media, whatsapp_send_draft, and whatsapp_react refuse. Read, list, and draft editing still work. */
  allowSend: boolean;
  /** When false, whatsapp_delete_message (and its older name whatsapp_delete_for_everyone) refuses. */
  allowDelete: boolean;
  /**
   * David session only. Registers david_* actions on whatsapp_action.
   * Omit it on personal and assistant so their action list stays the same.
   */
  david?: DavidActionApi;
  /**
   * David only. Every outbound send goes through this paced queue.
   * Omit it on personal and assistant so their send path stays immediate.
   */
  pacedSend?: (input: { jid: string; text: string; replyTo?: string | null; media?: OutboundMedia | null }) => Promise<{ ok: boolean; messageId?: string; error?: string }>;
  /** MEDIA_SEND_DIR. whatsapp_send_media reads `path` only inside this directory; unset refuses paths. */
  mediaSendDir?: string;
  /**
   * David only. Resolves a phone, a phone JID, or a LID to the phone JID
   * before send and draft. Personal and assistant keep resolveJid.
   */
  resolveRecipient?: (to: string, purpose: 'send' | 'draft') => Promise<string>;
};

function sessionAccount(wa: WhatsAppSession, role: string) {
  const source: AccountSource = {};
  try {
    const status = wa.getStatus();
    source.pairedJid = status.pairedJid;
    source.pairedNumber = status.pairedNumber;
  } catch {
    // A fake session can omit status.
  }
  try {
    if (typeof wa.getAccount === 'function') {
      const account = wa.getAccount();
      if (account && typeof account === 'object') {
        source.id = account.id;
        source.lid = account.lid;
        source.phoneNumber = account.phoneNumber;
      }
    }
  } catch {
    // A fake session can omit the paired account.
  }
  return bridgeAccount(role, source);
}

function tagFromMe<T extends { fromMe?: boolean | null }>(role: string, messages: T[]): Array<T & { sentByAccount?: string }> {
  return messages.map((message) => (message.fromMe === true ? { ...message, sentByAccount: role } : message));
}

function paceError(error: string | undefined): string {
  if (error === 'cold_contact') return 'Refusing to message a number that has not written to this account.';
  if (error === 'cold_cap') return 'Cold-send limit reached for today. This approved contact has not written to this account.';
  if (error === 'rate_limited') return 'Sending is rate limited. Try again shortly.';
  if (error === 'not_open') return 'WhatsApp is not connected. Pair via QR or wait for reconnect.';
  return 'Could not send the message.';
}

const groupGuards = new WeakMap<object, GroupQueryGuard>();

function groupGuard(wa: object): GroupQueryGuard {
  let guard = groupGuards.get(wa);
  if (!guard) {
    guard = new GroupQueryGuard();
    groupGuards.set(wa, guard);
  }
  return guard;
}

type ToolResult = ReturnType<typeof textResult> | ReturnType<typeof errResult>;

type ActionSpec = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  run: (args: unknown) => Promise<ToolResult>;
};

/**
 * One MCP server for a Streamable HTTP session. Tools close over the shared WhatsApp session.
 *
 * `whatsapp_action` is the stable tool. Add a new feature with `defineAction`.
 * Prefer actions for new features: clients can cache `tools/list` until reauth.
 * The tools registered below stay so clients that already listed them keep working.
 */
export function createMcpServer(wa: WhatsAppSession, options: BridgeSessionOptions): McpServer {
  const { role, allowSend, allowDelete } = options;
  const withAccount = (data: Record<string, unknown>) => ({ ...sessionAccount(wa, role), ...data });
  const server = new McpServer({
    name: `whatsapp-bridge-${role}`,
    version: '1.0.0',
  }, {
    capabilities: { tools: { listChanged: true } },
  });
  const catalog: ActionSpec[] = [{
    name: 'list_actions',
    description: 'List every action with its description and JSON input schema. New features are added as actions, not as new MCP tools.',
    inputSchema: z.object({}),
    run: async () => textResult({
      actions: catalog.map((item) => ({
        action: item.name,
        description: item.description,
        inputSchema: z.toJSONSchema(item.inputSchema, { io: 'input', target: 'draft-07' }),
      })),
    }),
  }];

  // New features call defineAction. It does not register an MCP tool.
  function defineAction(name: string, config: { description: string; inputSchema: z.ZodType }, handler: (args: any) => Promise<ToolResult>): void {
    catalog.push({
      name,
      description: config.description,
      inputSchema: config.inputSchema,
      run: async (raw) => {
        const parsed = config.inputSchema.safeParse(raw ?? {});
        if (!parsed.success) return errResult(`Invalid args for ${name}: ${formatIssues(parsed.error)}`);
        return handler(parsed.data);
      },
    });
  }

  // Explicit tools also become actions for clients with a cached tool list.
  function defineTool(name: string, config: { description: string; inputSchema: z.ZodType }, handler: (args: any) => Promise<ToolResult>): void {
    defineAction(name, config, handler);
    server.registerTool(name, config, (args) => traced(wa, name, null, args, () => handler(args)));
  }

  // Explicit tools requested for both connectors; also available through whatsapp_action.
  const blocklist = () => options.webhookBlocklist ?? wa.getStore().webhookBlocklist;
  const phoneLookup = (jid: string) => wa.getStore().phoneForJid(jid);
  for (const operation of ['list', 'add', 'remove'] as const) {
    defineTool(`whatsapp_webhook_blocklist_${operation}`, {
      description: 'Manage this account inbound blocklist. New matching inbound messages are dropped before storage and forwarding. List includes read-only stored message/event counts. Existing rows require dashboard purge; sending is unchanged.',
      inputSchema: operation === 'list' ? z.object({}) : operation === 'remove'
        ? z.object({ identifier: z.string().min(1).max(128) })
        : z.object({ identifier: z.string().min(1).max(128), name: z.string().max(80).optional(), note: z.string().max(300).optional(), approved_by: z.string().trim().min(1).max(80), reason: z.string().trim().min(1).max(300) }),
    }, async (args) => {
      try {
        return textResult(withAccount(operation === 'list' ? blocklist().list() : operation === 'add' ? blocklist().add(args, phoneLookup) : blocklist().remove(args.identifier, phoneLookup)));
      } catch (error) { return errResult(error instanceof Error ? error.message : 'Blocklist unavailable.'); }
    });
  }

  defineTool(
    'whatsapp_status',
    {
      description: 'WhatsApp connection state, session role, whether send is enabled, and paired number (if known).',
      inputSchema: z.object({}),
    },
    async () => {
      return textResult(withAccount({
        service: 'whatsapp-bridge',
        session: role,
        allowSend,
        allowDelete,
        ...wa.getStatus(),
      }));
    },
  );


  defineTool(
    'whatsapp_resolve_recipient',
    {
      description:
        'Resolve a recipient the same way send and draft do, without sending. Pass a bare phone, phone JID, LID, or group@g.us. Returns requestedTo, kind (what you passed), and jid (where a send would go). A bare phone only ever resolves to that person\'s direct chat; a group needs an explicit @g.us JID. Use this to verify a target before whatsapp_send_text.',
      inputSchema: z.object({
        to: z.string().min(1).max(128).describe(options.resolveRecipient
          ? 'E.164 digits, user@s.whatsapp.net, user@lid, or group@g.us. Prefer the phone JID.'
          : 'E.164 phone, digits, or WhatsApp JID'),
      }),
    },
    async ({ to }) => {
      try {
        const kind = classifyRecipient(to).kind;
        const jid = await recipientJid(wa, options, to, 'draft');
        return textResult(withAccount({ ok: true, requestedTo: to, kind, jid }));
      } catch (e) {
        return errResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  defineTool(
    'whatsapp_send_text',
    {
      description: allowSend
        ? (options.resolveRecipient
          ? 'Send a plain text WhatsApp message. `to` may be E.164 digits (country code, optional +), a phone JID (user@s.whatsapp.net), a LID (user@lid), or a group JID. A LID is resolved to the phone JID before the send. Prefer the phone JID when you have it. A bare phone number only ever sends to that person\'s direct chat; a group needs its explicit group@g.us JID. Check `jid` in the result.'
          : 'Send a plain text WhatsApp message. `to` may be E.164 (+521234567890), digits with country code, or a full JID (user@s.whatsapp.net / group@g.us). A bare phone number only ever sends to that person\'s direct chat; a group needs its explicit group@g.us JID.')
        : `Sending is disabled on the "${role}" session (ALLOW_SEND=false). This tool returns an error.`,
      inputSchema: z.object({
        to: z.string().min(1).describe(options.resolveRecipient
          ? 'E.164 digits, user@s.whatsapp.net, user@lid, or group@g.us. Prefer the phone JID.'
          : 'E.164 phone, digits, or WhatsApp JID'),
        text: z.string().min(1).describe('Message body'),
        replyTo: z.string().min(1).max(128).optional().describe('Message id to quote, from whatsapp_read_messages for this chat. The quote shows the original text and sender. If that message is not saved here, the text is sent without a quote and the result says so.'),
      }),
    },
    async ({ to, text, replyTo }) => {
      if (!allowSend) {
        return errResult(
          `Sending is disabled for the "${role}" WhatsApp session (ALLOW_SEND=false). Set ALLOW_SEND=true for this session if this number should send.`,
        );
      }
      const sock = wa.getSocket();
      if (!sock || wa.getStatus().state !== 'open') {
        return errResult('WhatsApp is not connected. Pair via QR or wait for reconnect.');
      }
      try {
        const jid = await recipientJid(wa, options, to, 'send');
        const { quoted, quoteNote } = replyQuote(wa.getStore(), jid, replyTo);
        const quoteResult = replyTo ? { quoted: Boolean(quoted), ...(quoteNote ? { note: quoteNote } : {}) } : {};
        if (options.pacedSend) {
          // David's paced sender builds the same quote from the saved original.
          const paced = await options.pacedSend({ jid, text, replyTo: quoted ? replyTo ?? null : null });
          if (!paced.ok) return errResult(paceError(paced.error));
          return textResult(withAccount({ ok: true, jid, requestedTo: to, messageId: paced.messageId, sentByAccount: role, ...quoteResult }));
        }
        const sent = quoted
          ? await sock.sendMessage(jid, { text }, { quoted })
          : await sock.sendMessage(jid, { text });
        if (sent) wa.getStore().upsertMessage(sent);
        return textResult(withAccount({
          ok: true,
          jid,
          requestedTo: to,
          messageId: sent?.key?.id,
          sentByAccount: role,
          ...quoteResult,
        }));
      } catch (e) {
        return errResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const deleteDescription = allowDelete
    ? 'Delete one message for everyone on WhatsApp. Only a message sent by this WhatsApp account can be deleted: the bridge checks its own saved copy, not the caller. Anything else is refused. This is destructive: use only after the user explicitly asks to delete an exact message. Use the chat JID and message ID from whatsapp_read_messages or whatsapp_send_text. Recipients may already have seen or saved it. The bridge history keeps the row and marks it deleted.'
    : `Deleting messages is disabled on the "${role}" session (ALLOW_DELETE=false). This tool returns an error.`;
  const deleteInput = z.object({
    chat: z.string().min(1).describe('Chat JID or phone number'),
    messageId: z.string().min(1).describe('Exact ID of an outgoing message from whatsapp_read_messages or whatsapp_send_text'),
  });
  const deleteForEveryone = async ({ chat, messageId }: { chat: string; messageId: string }): Promise<ToolResult> => {
    if (!allowDelete) return errResult(`Deleting messages is disabled for the "${role}" session (ALLOW_DELETE=false).`);
    const sock = wa.getSocket();
    if (!sock || wa.getStatus().state !== 'open') {
      return errResult('WhatsApp is not connected. Pair via QR or wait for reconnect.');
    }
    try {
      const jid = await wa.resolveJid(chat);
      const key = wa.getStore().getOwnMessageKey(jid, messageId);
      if (!key) return errResult('Message not found in this chat, already deleted, or not sent from this WhatsApp account. Only this account\'s own messages can be deleted.');
      const revoked = await sock.sendMessage(jid, { delete: key });
      if (!revoked) return errResult('WhatsApp did not accept the deletion request.');
      wa.getStore().markDeleteRequested(jid, messageId);
      return textResult(withAccount({ revokeRequested: true, jid, messageId }));
    } catch (e) {
      return errResult(e instanceof Error ? e.message : String(e));
    }
  };
  defineTool('whatsapp_delete_message', { description: deleteDescription, inputSchema: deleteInput }, deleteForEveryone);
  // Older name kept for clients that already listed it.
  defineTool('whatsapp_delete_for_everyone', { description: deleteDescription, inputSchema: deleteInput }, deleteForEveryone);

  defineTool(
    'whatsapp_react',
    {
      description: allowSend
        ? 'React to one saved message with an emoji, in a direct chat or a group. Pass an empty emoji to remove this account\'s reaction. The message must be saved for this chat (from whatsapp_read_messages); the bridge uses its saved key so the reaction lands on the right sender\'s message. Messages from blocklisted senders are refused.'
        : `Sending is disabled on the "${role}" session (ALLOW_SEND=false). This tool returns an error.`,
      inputSchema: z.object({
        chat: z.string().min(1).max(128).describe('Chat JID (user@s.whatsapp.net, user@lid, group@g.us) or phone number'),
        messageId: z.string().min(1).max(128).describe('Message id from whatsapp_read_messages'),
        emoji: z.string().max(32).describe('One emoji, such as 👍. Empty string removes the reaction.'),
      }),
    },
    async ({ chat, messageId, emoji }) => {
      if (!allowSend) {
        return errResult(`Sending is disabled for the "${role}" WhatsApp session (ALLOW_SEND=false). Reactions are sends.`);
      }
      const text = String(emoji ?? '').trim();
      if (text && !isSingleEmoji(text)) {
        return errResult('emoji must be a single emoji, or an empty string to remove the reaction.');
      }
      const sock = wa.getSocket();
      if (!sock || wa.getStatus().state !== 'open') {
        return errResult('WhatsApp is not connected. Pair via QR or wait for reconnect.');
      }
      try {
        const jid = await wa.resolveJid(chat);
        const store = wa.getStore();
        const stored = store.getStoredMessage(jid, messageId);
        if (!stored) return errResult('Message not found in this chat, or it was deleted. Read the chat with whatsapp_read_messages and use an id from there.');
        if (store.isBlockedMessage(stored.message)) return errResult('That message is from a blocklisted sender. Remove them from the blocklist first.');
        const key = stored.message.key;
        const reactKey = {
          remoteJid: jid,
          id: messageId,
          fromMe: key.fromMe === true,
          ...(key.participant ? { participant: key.participant } : {}),
        };
        const sent = await sock.sendMessage(jid, { react: { text, key: reactKey } });
        if (!sent) return errResult('WhatsApp did not accept the reaction.');
        return textResult(withAccount({ ok: true, jid, messageId, emoji: text, removed: text === '', sentByAccount: role }));
      } catch (e) {
        return errResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  defineTool(
    'whatsapp_send_media',
    {
      description: allowSend
        ? `Send one image, video, audio file, or document, with an optional caption and optional quoted reply. Pass exactly one source: base64 (optionally a data: URI), an https url, or path (a file inside this session's MEDIA_SEND_DIR; refused when it is unset). The type is detected from the file bytes, then mimetype, then the filename extension. JPEG/PNG/WebP go as images, MP4/3GP as videos, MP3/M4A/OGG/AAC as audio, and anything else as a document; set kind "document" to send any file as a document. Files over ${MEDIA_MAX_BYTES} bytes (MEDIA_MAX_BYTES) are refused. Same recipient and pacing rules as whatsapp_send_text.`
        : `Sending is disabled on the "${role}" session (ALLOW_SEND=false). This tool returns an error.`,
      inputSchema: z.object({
        to: z.string().min(1).max(128).describe(options.resolveRecipient
          ? 'E.164 digits, user@s.whatsapp.net, user@lid, or group@g.us. Prefer the phone JID.'
          : 'E.164 phone, digits, or WhatsApp JID'),
        base64: z.string().min(1).optional().describe('File contents as base64 or a data: URI. Use one of base64, url, or path.'),
        url: z.string().url().max(2048).optional().describe('https URL to fetch. Private and local addresses are refused.'),
        path: z.string().min(1).max(512).optional().describe('File path relative to MEDIA_SEND_DIR on the bridge host.'),
        mimetype: z.string().max(128).optional().describe('Used when the bytes do not identify the type.'),
        filename: z.string().max(200).optional().describe('Name shown for a document. Defaults from the url or path.'),
        kind: z.enum(['image', 'video', 'audio', 'document']).optional().describe('Omit to choose from the file type. "document" sends any file as a file.'),
        caption: z.string().max(4096).optional().describe('Caption for an image, video, or document. Audio cannot have one.'),
        replyTo: z.string().min(1).max(128).optional().describe('Message id to quote, from whatsapp_read_messages for this chat. If it is not saved here, the file is sent without a quote and the result says so.'),
      }),
    },
    async ({ to, base64, url, path, mimetype, filename, kind, caption, replyTo }) => {
      if (!allowSend) {
        return errResult(`Sending is disabled for the "${role}" WhatsApp session (ALLOW_SEND=false). Set ALLOW_SEND=true for this session if this number should send.`);
      }
      const sock = wa.getSocket();
      if (!sock || wa.getStatus().state !== 'open') {
        return errResult('WhatsApp is not connected. Pair via QR or wait for reconnect.');
      }
      let media: OutboundMedia;
      const text = caption ?? '';
      try {
        media = await loadOutboundMedia(
          { base64, url, path, mimetype, filename, kind: kind as OutboundKind | undefined },
          { maxBytes: MEDIA_MAX_BYTES, sendDir: options.mediaSendDir },
        );
        mediaContent(media, text);
      } catch (e) {
        return errResult(e instanceof MediaSendError ? e.message : 'Could not read the file.');
      }
      const summary = { kind: media.kind, mimetype: media.mimetype, filename: media.filename, size: media.buffer.length };
      try {
        const jid = await recipientJid(wa, options, to, 'send');
        const { quoted, quoteNote } = replyQuote(wa.getStore(), jid, replyTo);
        const quoteResult = replyTo ? { quoted: Boolean(quoted), ...(quoteNote ? { note: quoteNote } : {}) } : {};
        if (options.pacedSend) {
          const paced = await options.pacedSend({ jid, text, replyTo: quoted ? replyTo ?? null : null, media });
          if (!paced.ok) return errResult(paceError(paced.error));
          return textResult(withAccount({ ok: true, jid, requestedTo: to, messageId: paced.messageId, sentByAccount: role, ...summary, ...quoteResult }));
        }
        const content = mediaContent(media, text);
        const sent = quoted ? await sock.sendMessage(jid, content, { quoted }) : await sock.sendMessage(jid, content);
        if (!sent?.key?.id) return errResult('WhatsApp did not accept the file.');
        try {
          wa.getStore().upsertMessage(sent);
        } catch {
          // The send was accepted. History is best-effort.
        }
        return textResult(withAccount({ ok: true, jid, requestedTo: to, messageId: sent.key.id, sentByAccount: role, ...summary, ...quoteResult }));
      } catch (e) {
        return errResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  defineTool(
    'whatsapp_list_chats',
    {
      description:
        'List chats saved in this session\'s persistent history. A 1:1 chat uses the saved contact name when one is known.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(50).describe('Max chats to return'),
      }),
    },
    async ({ limit }) => {
      return textResult(withAccount({ chats: wa.getStore().listChats(limit ?? 50) }));
    },
  );

  defineTool(
    'whatsapp_read_messages',
    {
      description:
        'Read saved messages for a chat, including after restart or while disconnected. Includes the chat name and, for an incoming message, the sender\'s saved name when one is known. Each message includes hasMedia; media messages also include filename and mimetype. Use whatsapp_download_media for the file. Use nextOffset to page through older messages.',
      inputSchema: z.object({
        chat: z.string().min(1).describe('Chat JID or phone number'),
        limit: z.number().int().min(1).max(200).default(30).describe('Max messages'),
        offset: z.number().int().min(0).default(0).describe('Offset into newest-first history for older pages'),
      }),
    },
    async ({ chat, limit, offset }) => {
      try {
        const jid = wa.getStatus().state === 'open'
          ? await wa.resolveJid(chat)
          : chat.includes('@') ? chat : `${chat.replace(/[^\d]/g, '')}@s.whatsapp.net`;
        const page = wa.getStore().listMessages(jid, limit ?? 30, offset ?? 0);
        if (page.messages.length === 0 && !chat.includes('@')) {
          const fallbackJid = `${chat.replace(/[^\d]/g, '')}@s.whatsapp.net`;
          const fallback = wa.getStore().listMessages(fallbackJid, limit ?? 30, offset ?? 0);
          return textResult(withAccount({ jid: fallbackJid, ...fallback, messages: tagFromMe(role, fallback.messages) }));
        }
        return textResult(withAccount({ jid, ...page, messages: tagFromMe(role, page.messages) }));
      } catch (e) {
        return errResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  defineTool(
    'whatsapp_find_contact',
    {
      description:
        'Find a saved contact by name. Case-insensitive substring match on the name saved in WhatsApp, their notify name, verified business name, or push name from an incoming message. Returns matching chat JIDs and display names. Does not contact WhatsApp, send, or delete. Works while disconnected. Not gated by ALLOW_SEND or ALLOW_DELETE. % and _ in the query are literal.',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(80).describe('Name substring. % and _ are literal, not wildcards.'),
        limit: z.number().int().min(1).max(50).default(20).describe('Page size.'),
        offset: z.number().int().min(0).max(10_000).default(0).describe('Offset into the name-sorted results.'),
      }),
    },
    async ({ query, limit, offset }) => {
      try {
        return textResult(withAccount(wa.getStore().findContacts(query, limit ?? 20, offset ?? 0)));
      } catch (e) {
        const message = e instanceof Error ? e.message : '';
        if (message === 'query must be 1 to 80 characters.') return errResult(message);
        return errResult('Could not search contacts.');
      }
    },
  );

  defineTool(
    'whatsapp_search_messages',
    {
      description:
        'Search text already saved for this account, including a media filename. Optional chat JID and inclusive unix-second since/until filters. Returns a short snippet per hit, newest first, with nextOffset, hasMedia, and filename plus mimetype when the message has media. Does not contact WhatsApp, send, or delete. Works while disconnected. Delete-requested and revoked messages are skipped.',
      inputSchema: z.object({
        query: z.string().trim().min(2).max(80).describe('Substring to find. % and _ are literal, not wildcards.'),
        chat: z.string().min(1).max(128).optional().describe('Limit to one chat JID. Digits are treated as a phone JID.'),
        since: z.number().int().min(0).max(4_000_000_000).optional().describe('Inclusive start, unix seconds.'),
        until: z.number().int().min(0).max(4_000_000_000).optional().describe('Inclusive end, unix seconds.'),
        limit: z.number().int().min(1).max(50).default(20).describe('Page size.'),
        offset: z.number().int().min(0).max(10_000).default(0).describe('Offset into the newest-first results.'),
      }),
    },
    async ({ query, chat, since, until, limit, offset }) => {
      if (since != null && until != null && since > until) {
        return errResult('since must be less than or equal to until.');
      }
      try {
        const page = wa.getStore().searchMessages(query, {
          chat: chat ? savedChatJid(chat) : undefined,
          since,
          until,
          limit: limit ?? 20,
          offset: offset ?? 0,
        });
        return textResult(withAccount({ ...page, messages: tagFromMe(role, page.messages) }));
      } catch (e) {
        return errResult(e instanceof Error ? e.message : 'Could not search saved messages.');
      }
    },
  );

  defineTool(
    'whatsapp_group_activity',
    {
      description:
        'Count saved messages per day and distinct active senders per group over an inclusive unix-second range of at most 92 days. Returns counts only: no message text and no sender identifiers. Omit group to include every group with activity, or pass one group JID. Works while disconnected. Does not send or delete.',
      inputSchema: z.object({
        group: z.string().min(1).max(64).optional().describe('One group JID ending in @g.us. Omit for every active group.'),
        since: z.number().int().min(0).max(4_000_000_000).describe('Inclusive start, unix seconds.'),
        until: z.number().int().min(0).max(4_000_000_000).describe('Inclusive end, unix seconds.'),
      }),
    },
    async ({ group, since, until }) => {
      const requested = group?.trim();
      if (requested && !requested.endsWith('@g.us')) {
        return errResult('group must be a WhatsApp group JID ending in @g.us.');
      }
      try {
        return textResult(withAccount(wa.getStore().groupActivity({ group: requested, since, until })));
      } catch (e) {
        const message = e instanceof Error ? e.message : '';
        if (message === 'since must be less than or equal to until.' || message === 'Date range must be 92 days or less.') {
          return errResult(message);
        }
        return errResult('Could not summarize group activity.');
      }
    },
  );

  defineTool(
    'whatsapp_mentions',
    {
      description:
        'List saved messages that @-mentioned this account or replied to one of its messages since an inclusive unix-second timestamp. Returns the chat, message id, timestamp, a short snippet, and whether it was a mention, a reply, or both. No sender identifiers. Works while disconnected once the paired account is known. Does not send or delete. Messages stored before mention tracking was enabled are included only if WhatsApp syncs them again.',
      inputSchema: z.object({
        since: z.number().int().min(0).max(4_000_000_000).describe('Inclusive start, unix seconds.'),
        chat: z.string().min(1).max(128).optional().describe('Limit to one chat JID.'),
        limit: z.number().int().min(1).max(50).default(20).describe('Page size.'),
        offset: z.number().int().min(0).max(10_000).default(0).describe('Offset into the newest-first results.'),
      }),
    },
    async ({ since, chat, limit, offset }) => {
      try {
        const page = wa.getStore().listMentions(wa.getAccount(), {
          since,
          chat: chat ? savedChatJid(chat) : undefined,
          limit: limit ?? 20,
          offset: offset ?? 0,
        });
        return textResult(withAccount(page));
      } catch (e) {
        const message = e instanceof Error ? e.message : '';
        if (message === 'Paired account is not known yet.' || message === 'chat must be a chat JID.') return errResult(message);
        return errResult('Could not read mentions.');
      }
    },
  );

  defineTool(
    'whatsapp_group_info',
    {
      description:
        'Read participant counts for WhatsApp groups and communities this account belongs to. Returns the group subject, participant count, whether this account is an admin, an admin count, and community parent/child links. Pass a group JID (@g.us) for one group, or omit it and optionally pass a subject substring to list groups. Set all to true to return every matching group in one call. Does not send, delete, or return member phone numbers. Requires an open WhatsApp connection. A repeated call within a minute reuses the last result; a WhatsApp rate limit returns an error instead of retrying.',
      inputSchema: z.object({
        group: z.string().min(1).max(64).optional().describe('One group JID ending in @g.us. Omit to list groups.'),
        name: z.string().min(1).max(80).optional().describe('Case-insensitive subject substring. Ignored when group is set.'),
        all: z.boolean().optional().describe('When true, return every matching group and community instead of a page. Ignores limit.'),
        limit: z.number().int().min(1).max(200).default(50).describe('Max groups to return when listing. Ignored when all is true.'),
      }),
    },
    async ({ group, name, all, limit }) => {
      const status = wa.getStatus();
      const sock = wa.getSocket();
      if (!sock || status.state !== 'open') {
        return errResult('WhatsApp is not connected. Pair via QR or wait for reconnect.');
      }
      const requested = group?.trim();
      if (requested && !isGroupJid(requested)) {
        return errResult('group must be a WhatsApp group JID ending in @g.us. Omit it to list groups, or pass name to filter by subject.');
      }
      const guard = groupGuard(wa);
      const identity = accountIdentity(sock.user, status);
      try {
        let directory = await guard.load(async () => projectGroups(await sock.groupFetchAllParticipating(), identity));
        let target = requested;
        if (requested && !directory.some((item) => item.jid === requested)) {
          const metadata = projectGroup(await guard.fetchOne(() => sock.groupMetadata(requested)), identity);
          if (!metadata) return errResult('Group not found.');
          target = metadata.jid;
          guard.remember(metadata);
          if (!directory.some((item) => item.jid === metadata.jid)) directory = [...directory, metadata];
        }
        const page = linkAndFilter(directory, {
          groupJid: target,
          name: name?.trim(),
          limit: all ? Number.MAX_SAFE_INTEGER : (limit ?? 50),
        });
        if (requested && page.groups.length === 0) return errResult('Group not found.');
        return textResult(withAccount(page));
      } catch (e) {
        return errResult(publicGroupError(e));
      }
    },
  );

  defineTool(
    'whatsapp_create_draft',
    {
      description:
        'Save a draft text message for one chat. Optional sendAt is a unix-second reminder only and never sends the draft. Creating, listing, and cancelling do not contact WhatsApp and work while disconnected, including when ALLOW_SEND is false. Nothing sends until whatsapp_send_draft is called with this draft id.',
      inputSchema: z.object({
        chat: z.string().min(1).max(128).describe(options.resolveRecipient
          ? 'E.164 digits, user@s.whatsapp.net, user@lid, or group@g.us. A LID is stored as the phone JID. Prefer the phone JID.'
          : 'Chat JID. Digits are treated as a phone JID while disconnected.'),
        text: z.string().min(1).max(4096).describe('Draft body. It is stored until cancel or a successful explicit send.'),
        sendAt: z.number().int().min(1_000_000_000).max(4_000_000_000).optional().describe('Optional reminder timestamp, unix seconds. Ignored for sending.'),
      }),
    },
    async ({ chat, text, sendAt }) => {
      const body = text.trim();
      if (!body || body.length > 4096) return errResult('Draft text must be 1 to 4096 characters.');
      try {
        const jid = assertPhoneStaysDirect(chat, options.resolveRecipient
          ? await options.resolveRecipient(chat, 'draft')
          : (wa.getStatus().state === 'open' ? await wa.resolveJid(chat) : savedChatJid(chat)));
        const draft = wa.getStore().createDraft({ jid, text: body, sendAt: sendAt ?? null });
        return textResult(withAccount({ id: draft.id, jid: draft.jid, sendAt: draft.sendAt, createdAt: draft.createdAt }));
      } catch (e) {
        return errResult(draftError(e, body));
      }
    },
  );

  defineTool(
    'whatsapp_list_drafts',
    {
      description:
        'List drafts saved for this session, newest first. Each item includes the chat, text, optional reminder time, and id. Does not send, delete, or contact WhatsApp. Works while disconnected.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(20).describe('Page size.'),
        offset: z.number().int().min(0).max(10_000).default(0).describe('Offset into the newest-first list.'),
      }),
    },
    async ({ limit, offset }) => {
      try {
        return textResult(withAccount(wa.getStore().listDrafts(limit ?? 20, offset ?? 0)));
      } catch {
        return errResult('Could not list drafts.');
      }
    },
  );

  defineTool(
    'whatsapp_cancel_draft',
    {
      description:
        'Delete one saved draft by id, including its text. Does not send it and does not contact WhatsApp. Works while disconnected and when ALLOW_SEND is false.',
      inputSchema: z.object({
        id: z.string().min(32).max(32).describe('Draft id from whatsapp_create_draft or whatsapp_list_drafts.'),
      }),
    },
    async ({ id }) => {
      try {
        const outcome = wa.getStore().cancelDraft(id);
        if (outcome === 'sending') return errResult('This draft is already being sent.');
        if (outcome === 'missing') return errResult('Draft not found.');
        return textResult(withAccount({ cancelled: true, id }));
      } catch {
        return errResult('Could not cancel the draft.');
      }
    },
  );

  defineTool(
    'whatsapp_send_draft',
    {
      description: allowSend
        ? 'Send one saved draft now. This is the only way a draft is sent. Pass the draft id from whatsapp_create_draft. sendAt is not a schedule and is not checked. The draft is removed only after WhatsApp accepts the message. A failed send leaves the draft in place.'
        : `Sending is disabled on the "${role}" session (ALLOW_SEND=false). This tool returns an error and leaves the draft saved.`,
      inputSchema: z.object({
        id: z.string().min(32).max(32).describe('Draft id to send.'),
        replyTo: z.string().min(1).max(128).optional().describe('Message id to quote, from whatsapp_read_messages for this chat. The quote shows the original text and sender. If that message is not saved here, the text is sent without a quote and the result says so.'),
      }),
    },
    async ({ id, replyTo }) => {
      if (!allowSend) {
        return errResult(
          `Sending is disabled for the "${role}" WhatsApp session (ALLOW_SEND=false). Set ALLOW_SEND=true for this session if this number should send.`,
        );
      }
      if (wa.getStatus().state !== 'open') {
        return errResult('WhatsApp is not connected. Pair via QR or wait for reconnect.');
      }
      const sock = wa.getSocket();
      if (!sock) return errResult('WhatsApp is not connected. Pair via QR or wait for reconnect.');
      const claimed = wa.getStore().beginDraftSend(id);
      if (claimed === 'missing') return errResult('Draft not found.');
      if (claimed === 'sending') return errResult('This draft is already being sent.');
      try {
        const jid = options.resolveRecipient ? await options.resolveRecipient(claimed.jid, 'send') : claimed.jid;
        const { quoted, quoteNote } = replyQuote(wa.getStore(), jid, replyTo);
        const quoteResult = replyTo ? { quoted: Boolean(quoted), ...(quoteNote ? { note: quoteNote } : {}) } : {};
        if (options.pacedSend) {
          const paced = await options.pacedSend({ jid, text: claimed.text, replyTo: quoted ? replyTo ?? null : null });
          if (!paced.ok || !paced.messageId) {
            wa.getStore().finishDraftSend(id, false);
            return errResult(paceError(paced.error));
          }
          wa.getStore().finishDraftSend(id, true);
          return textResult(withAccount({ ok: true, id, jid, messageId: paced.messageId, sentByAccount: role, ...quoteResult }));
        }
        const sent = quoted
          ? await sock.sendMessage(jid, { text: claimed.text }, { quoted })
          : await sock.sendMessage(jid, { text: claimed.text });
        if (!sent?.key?.id) {
          wa.getStore().finishDraftSend(id, false);
          return errResult('WhatsApp did not accept the draft.');
        }
        try {
          wa.getStore().upsertMessage(sent);
        } catch {
          // The message was accepted. Dropping the draft avoids a second send.
        }
        wa.getStore().finishDraftSend(id, true);
        return textResult(withAccount({ ok: true, id, jid: sent.key.remoteJid ?? jid, messageId: sent.key.id, sentByAccount: role, ...quoteResult }));
      } catch (e) {
        wa.getStore().finishDraftSend(id, false);
        const message = e instanceof Error ? e.message : '';
        if (!message || message.includes(claimed.text)) return errResult('Could not send the draft.');
        return errResult(message);
      }
    },
  );

  defineTool(
    'whatsapp_download_media',
    {
      description:
        `Download one document, image, audio, video, or sticker saved on a message. Works in direct chats and groups, for received and sent files. Pass the chat JID and message id from whatsapp_read_messages or whatsapp_search_messages. Returns filename, mimetype, size in bytes, and base64 contents. Does not send or delete a chat message. Files larger than ${MEDIA_MAX_BYTES} bytes are refused. A message saved without its media key cannot be downloaded. When the saved link has expired and WhatsApp is connected, the bridge asks for one re-upload; that request is not a chat message.`,
      inputSchema: z.object({
        chat: z.string().min(1).max(128).describe('Chat JID or phone number from whatsapp_read_messages.'),
        messageId: z.string().min(1).max(128).describe('Message id from whatsapp_read_messages or whatsapp_search_messages.'),
      }),
    },
    async ({ chat, messageId }) => downloadMediaAction(wa, chat, messageId),
  );

  defineAction(
    'ping',
    {
      description: 'Harmless process check. Returns ok, the bridge version, and the time this process started. Does not read WhatsApp, send, or delete.',
      inputSchema: z.object({}),
    },
    async () => textResult({ ok: true, version: BRIDGE_VERSION, buildTime: BRIDGE_BUILD_TIME }),
  );

  defineAction(
    'webhook_status',
    {
      description: 'Report whether the incoming-message webhook is enabled, when a batch last succeeded, and delivery, drop, and error counts. Does not send, delete, or include message text or the webhook key.',
      inputSchema: z.object({}),
    },
    async () => textResult(withAccount(typeof wa.getWebhookStatus === 'function' ? wa.getWebhookStatus() : {
      enabled: false,
      lastSentAt: null,
      sentBatches: 0,
      sentMessages: 0,
      dropped: 0,
      failedBatches: 0,
      lastError: null,
    })),
  );

  // David actions stay off the shared tool list. They are registered only for the david process.
  if (options.david) {
    const david = options.david;
    defineAction(
      'david_resolve_escalation',
      {
        description: 'Resolve one David escalation. decision is approve, deny, or edit. edit requires edited_action. Idempotent: an escalation that is already resolved returns status 409 and does not change the stored decision. Does not register a new MCP tool.',
        inputSchema: z.object({
          request_id: z.uuid().describe('Escalation request_id from the Secretary payload.'),
          decision: z.enum(['approve', 'deny', 'edit']).describe('What the owner decided.'),
          note: z.string().trim().max(500).optional().describe('Optional note stored with the decision.'),
          edited_action: z.string().trim().min(1).max(500).optional().describe('Required when decision is edit. The action David should tell the requester.'),
        }),
      },
      async (args) => textResult(await david.resolveEscalation(args)),
    );
    defineAction(
      'david_allowlist_list',
      {
        description: 'List David code-agent allowlist entries for this session. The OWNER_PHONE has every repo. Does not grant access.',
        inputSchema: z.object({}),
      },
      async () => textResult(await david.allowlistList()),
    );
    defineAction(
      'david_allowlist_grant',
      {
        description: 'Grant one phone access to one repo, or * for every repo. Admin only: the caller is the David session MCP credential. Owner access cannot be narrowed here.',
        inputSchema: z.object({
          phone: z.string().trim().min(8).max(24).describe('Digits, with optional leading +.'),
          repo: z.string().trim().min(1).max(140).describe('owner/name, or * for every repo.'),
        }),
      },
      async (args) => textResult(await david.allowlistGrant(args)),
    );
    defineAction(
      'david_allowlist_revoke',
      {
        description: 'Remove one phone from the David code allowlist, or one repo for that phone. Admin only: the caller is the David session MCP credential. Refuses to revoke the owner.',
        inputSchema: z.object({
          phone: z.string().trim().min(8).max(24).describe('Digits, with optional leading +.'),
          repo: z.string().trim().min(1).max(140).optional().describe('owner/name to remove. Omit to remove every repo for that phone.'),
        }),
      },
      async (args) => textResult(await david.allowlistRevoke(args)),
    );
    defineTool(
      'whatsapp_approved_contacts_list',
      {
        description: 'List contacts approved for a first message from this David account, the daily cold-send cap, and how many cold sends have been used today. A cold send is a message to an approved contact who has never written here. Does not send.',
        inputSchema: z.object({}),
      },
      async () => {
        const listed = await david.approvedList();
        return listed.ok === false ? errResult(String(listed.error ?? 'Could not list approved contacts.')) : textResult(listed);
      },
    );
    defineTool(
      'whatsapp_approved_contacts_add',
      {
        description: 'Approve one contact so David can send them a first message. identifier is E.164 digits (country code, optional +), a phone JID (user@s.whatsapp.net), or a LID (user@lid). David stores the phone JID. approved_by and reason are required. This does not bypass pacing, the daily cold-send cap, or stripping of ¡ and ¿.',
        inputSchema: z.object({
          identifier: z.string().trim().min(1).max(128).describe('E.164 digits, user@s.whatsapp.net, or user@lid.'),
          display_name: z.string().trim().max(80).optional().describe('Name to show on the dashboard. Optional.'),
          approved_by: z.string().trim().min(1).max(80).describe('Who approved this contact. Required.'),
          reason: z.string().trim().min(1).max(300).describe('Why this contact may receive a first message. Required.'),
        }),
      },
      async (args) => {
        const added = await david.approvedAdd(args);
        return added.ok === false ? errResult(String(added.error ?? 'Could not approve that contact.')) : textResult(added);
      },
    );
    defineTool(
      'whatsapp_approved_contacts_remove',
      {
        description: 'Remove one approved contact. identifier is the stored phone JID, a phone number, or the LID saved when they were added. Does not send.',
        inputSchema: z.object({
          identifier: z.string().trim().min(1).max(128).describe('Stored phone JID, phone number, or LID.'),
        }),
      },
      async (args) => {
        const removed = await david.approvedRemove(args);
        return removed.ok === false ? errResult(String(removed.error ?? 'Could not remove that contact.')) : textResult(removed);
      },
    );
    defineAction(
      'david_code_status',
      {
        description: 'Status of one David code-agent request: pending, acked, done, or failed, plus the pull request URL when one exists.',
        inputSchema: z.object({
          request_id: z.uuid().describe('request_id returned when the code webhook was accepted.'),
        }),
      },
      async (args) => textResult(await david.codeStatus(args)),
    );
  }

  server.registerTool(
    'whatsapp_action',
    {
      description:
        'Run one bridge action. This tool name stays stable: call action "list_actions" for every action, its description, and its JSON input schema, then pass that action name and its args. New features are added as actions so an already connected client can use them without reconnecting. The existing whatsapp_* tools accept the same args.',
      inputSchema: z.object({
        action: z.string().trim().min(1).max(80).describe('Action name, such as list_actions or whatsapp_list_chats.'),
        args: z.record(z.string(), z.unknown()).optional().describe('Arguments for that action. Omit when it takes none.'),
      }),
    },
    async ({ action, args }) => traced(wa, 'whatsapp_action', action, args ?? {}, async () => {
      const spec = catalog.find((item) => item.name === action);
      if (!spec) return errResult(`Unknown action "${action}". Valid actions: ${catalog.map((item) => item.name).join(', ')}.`);
      try {
        return await spec.run(args ?? {});
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        return errResult(message || 'Action failed.');
      }
    }),
  );

  return server;
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (parts.length >= 10 || value == null) continue;
    if ((key === 'limit' || key === 'offset' || key === 'since' || key === 'until') && typeof value === 'number') {
      parts.push(`${key}=${value}`);
    } else if (key === 'all' && typeof value === 'boolean') {
      parts.push(`all=${value}`);
    } else if (typeof value === 'string') {
      parts.push(`${key}=(${value.length} chars)`);
      // Recipient fields: record kind so a group JID cannot be mistaken for a phone.
      if (key === 'to' || key === 'chat' || key === 'group' || key === 'identifier') {
        parts.push(`${key}Kind=${classifyRecipient(value).kind}`);
      }
    } else {
      parts.push(`${key}=(${typeof value})`);
    }
  }
  return parts.join(' ').slice(0, 240);
}

async function traced(wa: WhatsAppSession, tool: string, action: string | null, args: unknown, run: () => Promise<ToolResult>): Promise<ToolResult> {
  const started = Date.now();
  try {
    const result = await run();
    recordCall(wa, tool, action, args, Date.now() - started, !('isError' in result && result.isError));
    return result;
  } catch (error) {
    recordCall(wa, tool, action, args, Date.now() - started, false);
    throw error;
  }
}

function recordCall(wa: WhatsAppSession, tool: string, action: string | null, args: unknown, durationMs: number, ok: boolean): void {
  try {
    wa.getStore().recordMcpCall({
      at: Math.floor(Date.now() / 1000),
      tool,
      action,
      argsSummary: summarizeArgs(args),
      durationMs,
      ok,
    });
  } catch {
    // A logging failure must not change the tool result.
  }
}

type MediaFetch = (message: WAMessage) => Promise<Uint8Array | AsyncIterable<Uint8Array>>;

async function downloadMediaAction(wa: WhatsAppSession, chat: string, messageId: string): Promise<ToolResult> {
  let jid: string;
  try {
    jid = wa.getStatus().state === 'open'
      ? await wa.resolveJid(chat)
      : (chat.includes('@') ? chat : `${chat.replace(/[^\d]/g, '')}@s.whatsapp.net`);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return errResult(message || 'Could not download media.');
  }
  const record = wa.getStore().getStoredMedia(jid, messageId);
  if (!record) return errResult('Message not found in this chat.');
  if (record.deletedForEveryone) return errResult('This message was deleted and its media is no longer available.');
  if (!record.media) {
    if (looksLikeMediaPlaceholder(record.text)) {
      return errResult('This message looks like media, but it was saved before the media key was stored. It cannot be downloaded or re-uploaded. If WhatsApp delivers the message again, the key is stored and a later download can succeed.');
    }
    return errResult('This message has no attached document, image, audio, video, or sticker.');
  }
  if (!record.media.mediaKey) return errResult(MISSING_MEDIA_KEY);
  if (record.media.size != null && record.media.size > MEDIA_MAX_BYTES) {
    return errResult(mediaTooLargeMessage(record.media.size, MEDIA_MAX_BYTES));
  }
  const cached = wa.getStore().getCachedMessage(jid, messageId);
  const cachedMedia = cached ? describeMedia(cached.message) : null;
  const message = cached && cachedMedia?.mediaKey
    ? cached
    : buildDownloadMessage({
      jid,
      id: messageId,
      fromMe: record.fromMe,
      participant: record.participant,
      media: record.media,
    });
  const sock = wa.getStatus().state === 'open' ? wa.getSocket() : null;
  try {
    const result = await downloadPreparedMedia({
      message,
      maxBytes: MEDIA_MAX_BYTES,
      download: mediaFetcher(wa),
      reupload: sock ? (item) => sock.updateMediaMessage(item) : undefined,
    });
    if (result.reuploaded) {
      wa.getStore().updateMediaLocation(jid, messageId, { url: result.url, directPath: result.directPath });
    }
    return textResult({
      jid,
      messageId,
      kind: result.kind,
      filename: result.filename,
      mimetype: result.mimetype,
      size: result.buffer.length,
      base64: result.buffer.toString('base64'),
    });
  } catch (error) {
    if (error instanceof MediaDownloadError) return errResult(error.message);
    return errResult('The media could not be downloaded.');
  }
}

function mediaFetcher(wa: WhatsAppSession): MediaFetch {
  const hook = (wa as WhatsAppSession & { fetchMedia?: MediaFetch }).fetchMedia;
  if (typeof hook === 'function') return hook;
  return downloadBaileysMedia;
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.map(String).join('.') : 'args';
    return `${path}: ${issue.message}`;
  }).join('; ');
}

async function recipientJid(wa: WhatsAppSession, options: BridgeSessionOptions, to: string, purpose: 'send' | 'draft'): Promise<string> {
  const resolved = options.resolveRecipient ? await options.resolveRecipient(to, purpose) : await wa.resolveJid(to);
  return assertPhoneStaysDirect(to, resolved);
}

function draftError(error: unknown, body: string): string {
  const message = error instanceof Error ? error.message : '';
  if (
    message === 'chat must be a chat JID.'
    || message === 'Draft text must be 1 to 4096 characters.'
    || message === 'sendAt must be a unix timestamp.'
    || message === 'Too many drafts. Cancel one before creating another.'
  ) return message;
  if (!message || message.includes(body)) return 'Could not save the draft.';
  return message;
}
