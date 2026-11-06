import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import path from 'node:path';
import { MemoryStore } from './store.js';
import type { WebhookStatus } from './webhook.js';
import { acceptsRealtimeUpsert } from './webhook.js';
import { resolveSendJid } from './recipient.js';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'qr' | 'open' | 'logged_out';

export interface WhatsAppSession {
  getStatus(): {
    state: ConnectionStatus;
    pairedJid?: string;
    pairedNumber?: string;
    hasCreds: boolean;
  };
  getSocket(): WASocket | null;
  getStore(): MemoryStore;
  /** Last known paired account. Available from saved creds even while disconnected. */
  getAccount(): { id?: string; lid?: string; phoneNumber?: string };
  resolveJid(to: string): Promise<string>;
  getWebhookStatus(): WebhookStatus;
  start(): Promise<void>;
}

const disabledWebhook = (): WebhookStatus => ({
  enabled: false,
  lastSentAt: null,
  sentBatches: 0,
  sentMessages: 0,
  dropped: 0,
  failedBatches: 0,
  lastError: null,
});

export type SessionHooks = {
  /** Called only for real-time `notify` upserts, after the message is saved. Must not throw. */
  onNotify?: (message: import('@whiskeysockets/baileys').WAMessage) => void;
  webhookStatus?: () => WebhookStatus;
};

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });

export function createWhatsAppSession(authDir: string, historyDbPath: string, label = 'default', hooks?: SessionHooks): WhatsAppSession {
  const tag = `[whatsapp-bridge:${label}]`;
  const store = new MemoryStore(historyDbPath);
  let sock: WASocket | null = null;
  let status: ConnectionStatus = 'disconnected';
  let hasCreds = false;
  let account: { id?: string; lid?: string; phoneNumber?: string } | undefined;
  const rememberAccount = (user?: { id?: string; lid?: string; phoneNumber?: string } | null) => {
    if (!user || (!user.id && !user.lid && !user.phoneNumber)) return;
    account = { id: user.id, lid: user.lid, phoneNumber: user.phoneNumber };
  };
  let starting = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelayMs = 2000;

  const scheduleReconnect = () => {
    if (retryTimer || status === 'logged_out') return;
    const delay = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, 30000);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, delay);
  };

  const connect = async (): Promise<void> => {
    status = 'connecting';
    try {
      const resolvedAuth = path.resolve(authDir);
      const { state, saveCreds } = await useMultiFileAuthState(resolvedAuth);
      hasCreds = Boolean(state.creds?.me?.id || state.creds?.registered);
      rememberAccount(state.creds?.me);

      const { version } = await fetchLatestBaileysVersion();

      const currentSocket = makeWASocket({
        version,
        auth: state,
        logger,
        // WhatsApp rejects the legacy Desktop sub-platform before QR pairing (428).
        browser: Browsers.macOS('Chrome'),
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true,
        markOnlineOnConnect: false,
        getMessage: store.getMessage,
      });
      sock = currentSocket;

      bindStoreEvents(currentSocket, store, hooks, tag);

      currentSocket.ev.on('creds.update', () => {
        rememberAccount(state.creds?.me);
        void saveCreds().then(() => {
          hasCreds = true;
        }).catch((err) => console.error(`${tag} failed to save auth state`, err));
      });

      currentSocket.ev.on('connection.update', (update) => {
        if (sock !== currentSocket) return;
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          status = 'qr';
          console.log(`\n=== ${tag} Scan this QR with the "${label}" WhatsApp account ===`);
          console.log('WhatsApp → Settings → Linked devices → Link a device\n');
          qrcode.generate(qr, { small: true });
          console.log('\n');
        }

        if (connection === 'open') {
          status = 'open';
          retryDelayMs = 2000;
          rememberAccount(currentSocket.user);
          const me = sock?.user?.id;
          console.log(`${tag} connected as ${me ?? 'unknown'}`);
        }

        if (connection === 'close') {
          const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
          const loggedOut = code === DisconnectReason.loggedOut;
          console.log(`${tag} connection closed (code=${code}), reconnect=${!loggedOut}`);
          sock = null;
          if (loggedOut) {
            status = 'logged_out';
            hasCreds = false;
            account = undefined;
            console.error(
              `${tag} Logged out. Preserve history.sqlite before clearing this session's auth files, then restart to pair again.`,
            );
            return;
          }
          status = 'connecting';
          scheduleReconnect();
        }
      });
    } catch (err) {
      console.error(`${tag} connection setup failed`, err);
      scheduleReconnect();
    }
  };

  return {
    getStore: () => store,
    getSocket: () => sock,
    getAccount: () => ({ ...account }),
    getWebhookStatus: () => hooks?.webhookStatus?.() ?? disabledWebhook(),
    getStatus: () => {
      const me = sock?.user?.id;
      const pairedJid = me ? jidNormalizedUser(me) : undefined;
      const pairedNumber = pairedJid?.replace(/@.*/, '');
      return { state: status, pairedJid, pairedNumber, hasCreds };
    },
    resolveJid: (to: string): Promise<string> => resolveSendJid(to, sock ? (jid) => sock!.onWhatsApp(jid) : null),
    start: async () => {
      if (starting) return;
      starting = true;
      await connect();
    },
  };
}

/** Shared live/history ingress. A fake event source can exercise this without connecting. */
export function bindStoreEvents(s: Pick<WASocket, 'ev'>, store: MemoryStore, hooks?: SessionHooks, tag = '[whatsapp-bridge]'): void {
  s.ev.process(async (events) => {
    if (events['contacts.upsert']) {
      for (const c of events['contacts.upsert']) store.upsertContact(c);
    }
    if (events['contacts.update']) {
      for (const c of events['contacts.update']) store.upsertContact(c);
    }
    if (events['lid-mapping.update']) {
      const mapping = events['lid-mapping.update'];
      store.linkJids(mapping.pn, mapping.lid);
    }
    if (events['messaging-history.set']) {
      const hist = events['messaging-history.set'];
      store.transaction(() => {
        for (const contact of hist.contacts) store.upsertContact(contact);
        for (const mapping of hist.lidPnMappings ?? []) store.linkJids(mapping.pn, mapping.lid);
        for (const msg of hist.messages) store.upsertMessage(msg);
        for (const chat of hist.chats) store.upsertChat(chat);
      });
    }
    if (events['messages.upsert']) {
      const upsert = events['messages.upsert'];
      const accepted = upsert.messages.filter(msg => store.upsertMessage(msg));
      if (acceptsRealtimeUpsert(upsert.type)) {
        for (const msg of accepted) {
          try {
            hooks?.onNotify?.(msg);
          } catch {
            console.error(`${tag} incoming webhook failed`);
          }
        }
      }
    }
    if (events['chats.upsert']) {
      for (const chat of events['chats.upsert']) store.upsertChat(chat);
    }
    if (events['chats.update']) {
      for (const update of events['chats.update']) store.updateChat(update as { id?: string | null } & Partial<import('@whiskeysockets/baileys').Chat>);
    }
    if (events['chats.delete']) {
      store.deleteChats(events['chats.delete']);
    }
    if (events['messages.update']) {
      for (const { key, update } of events['messages.update']) {
        store.updateMessage(key, update as never);
      }
    }
  });
}
