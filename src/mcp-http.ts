/**
 * Streamable HTTP sessions for the bridge.
 *
 * `createMcpHandler`'s default legacy path is stateless: it answers GET with
 * 405, issues no `Mcp-Session-Id`, and tears the server down after each POST.
 * Tool registration does advertise `tools.listChanged`, but
 * `notifications/tools/list_changed` is only written to the standalone SSE
 * stream, so it was dropped. A client that listed tools once kept that list
 * until a manual reconnect.
 *
 * Sessions live in memory for this process only. Each one is bound to a hash
 * of the caller's Authorization header. A different token gets the same 404 as
 * a missing session and cannot use, listen to, or close it. Sessions idle for
 * more than 30 minutes are dropped. One caller can hold 8; the process holds
 * 64 and refuses a new session rather than evicting someone else. OAuth
 * clients and grants stay in `oauth.sqlite` on the auth volume; this module
 * never opens that database.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  InMemoryServerEventBus,
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type JSONRPCMessage,
  type McpHandlerRequestOptions,
  type McpServer,
  type ServerEvent,
  type ServerEventBus,
} from '@modelcontextprotocol/server';

const MAX_SESSIONS = 64;
const MAX_PER_CALLER = 8;
const MAX_REFRESHED_CALLERS = 64;
const IDLE_MS = 30 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

type LiveSession = {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  caller: string;
  lastUsed: number;
  created: number;
  listening: boolean;
};

type BridgeMcpHandlerOptions = {
  now?: () => number;
  idleMs?: number;
};

class RefreshOnListenBus implements ServerEventBus {
  private readonly inner = new InMemoryServerEventBus();

  publish(event: ServerEvent): void {
    this.inner.publish(event);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    const unsubscribe = this.inner.subscribe(listener);
    // A listen stream opened after a deploy has no earlier event to replay.
    // Deliver one tool-list change immediately so the client re-lists.
    try {
      listener({ kind: 'tools_list_changed' });
    } catch {
      // The router drops events it did not ask for. A listener failure must
      // not prevent the subscription from being acknowledged.
    }
    return unsubscribe;
  }
}

function callerKey(request: Request): string {
  const authorization = request.headers.get('authorization') ?? '';
  return createHash('sha256').update(authorization).digest('hex');
}

function isInitializeBody(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && !Array.isArray(body) && (body as { method?: unknown }).method === 'initialize');
}

function isRpcResponse(message: JSONRPCMessage): message is JSONRPCMessage & { id: string | number } {
  return typeof message === 'object' && message !== null && 'id' in message && !('method' in message) && (typeof message.id === 'string' || typeof message.id === 'number');
}

function sessionNotFound(): Response {
  return Response.json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Session not found' },
    id: null,
  }, {
    status: 404,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function tooManySessions(): Response {
  return Response.json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Too many sessions.' },
    id: null,
  }, {
    status: 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function finishWhenRead(response: Response, finish: () => void): Response {
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    finish();
  };
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    done();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          done();
          controller.close();
          return;
        }
        if (next.value) controller.enqueue(next.value);
      } catch (error) {
        done();
        controller.error(error);
      }
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function createBridgeMcpHandler(factory: () => McpServer, options?: BridgeMcpHandlerOptions) {
  const now = options?.now ?? Date.now;
  const idleMs = options?.idleMs ?? IDLE_MS;
  const sessions = new Map<string, LiveSession>();
  const refreshedCallers = new Map<string, number>();
  const modern = createMcpHandler(factory, { legacy: 'reject', bus: new RefreshOnListenBus() });
  let created = 0;
  let closed = false;
  let sweeping = false;

  function idle(lastUsed: number): boolean {
    return now() - lastUsed > idleMs;
  }

  function sweepRefreshed(): void {
    for (const [key, used] of refreshedCallers) {
      if (idle(used)) refreshedCallers.delete(key);
    }
  }

  async function drop(id: string, live: LiveSession | undefined): Promise<void> {
    if (id) sessions.delete(id);
    await live?.transport.close().catch(() => {});
    await live?.server.close().catch(() => {});
  }

  async function sweepSessions(): Promise<void> {
    if (closed || sweeping) return;
    sweeping = true;
    try {
      const stale: string[] = [];
      for (const [id, live] of sessions) {
        if (!live.listening && idle(live.lastUsed)) stale.push(id);
      }
      for (const id of stale) {
        if (closed) return;
        const live = sessions.get(id);
        if (!live || live.listening || !idle(live.lastUsed)) continue;
        await drop(id, live);
      }
      if (!closed) sweepRefreshed();
    } finally {
      sweeping = false;
    }
  }

  const timer = setInterval(() => { void sweepSessions(); }, SWEEP_MS);
  timer.unref();

  function countOf(caller: string): number {
    let count = 0;
    for (const live of sessions.values()) if (live.caller === caller) count += 1;
    return count;
  }

  function oldestOf(caller: string): [string, LiveSession] | undefined {
    let victim: [string, LiveSession] | undefined;
    for (const entry of sessions) {
      if (entry[1].caller !== caller) continue;
      if (!victim || entry[1].lastUsed < victim[1].lastUsed || (entry[1].lastUsed === victim[1].lastUsed && entry[1].created < victim[1].created)) {
        victim = entry;
      }
    }
    return victim;
  }

  async function admit(caller: string): Promise<boolean> {
    await sweepSessions();
    while (countOf(caller) >= MAX_PER_CALLER) {
      const victim = oldestOf(caller);
      if (!victim) break;
      await drop(victim[0], victim[1]);
    }
    return sessions.size < MAX_SESSIONS;
  }

  function rememberRefresh(key: string): void {
    refreshedCallers.set(key, now());
    while (refreshedCallers.size > MAX_REFRESHED_CALLERS) {
      let victim: string | undefined;
      let victimUsed = Number.POSITIVE_INFINITY;
      for (const [stored, used] of refreshedCallers) {
        if (used < victimUsed) {
          victimUsed = used;
          victim = stored;
        }
      }
      if (victim === undefined) break;
      refreshedCallers.delete(victim);
    }
  }

  function claimNotify(key: string): { mark: () => void } | undefined {
    const used = refreshedCallers.get(key);
    if (used !== undefined && !idle(used)) {
      refreshedCallers.set(key, now());
      return undefined;
    }
    refreshedCallers.delete(key);
    return { mark: () => rememberRefresh(key) };
  }

  async function remember(live: LiveSession): Promise<boolean> {
    const id = live.transport.sessionId;
    if (!id) return false;
    if (sessions.size >= MAX_SESSIONS) {
      await live.transport.close().catch(() => {});
      await live.server.close().catch(() => {});
      return false;
    }
    sessions.set(id, live);
    return true;
  }

  async function serveStateless(request: Request, options: McpHandlerRequestOptions | undefined, notify: { mark: () => void } | undefined): Promise<Response> {
    const server = factory();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    if (notify) {
      const original = transport.send.bind(transport);
      let sent = false;
      transport.send = async (message: JSONRPCMessage, sendOptions) => {
        if (!sent && isRpcResponse(message)) {
          sent = true;
          notify.mark();
          await original({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }, { relatedRequestId: message.id });
        }
        return original(message, sendOptions);
      };
    }
    await server.connect(transport);
    const response = await transport.handleRequest(request, {
      ...options?.authInfo !== undefined && { authInfo: options.authInfo },
      ...options?.parsedBody !== undefined && { parsedBody: options.parsedBody },
    });
    return finishWhenRead(response, () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
  }

  async function fetch(request: Request, requestOptions?: McpHandlerRequestOptions): Promise<Response> {
    await sweepSessions();
    if (!(await isLegacyRequest(request, requestOptions?.parsedBody))) return modern.fetch(request, requestOptions);
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId) {
      const live = sessions.get(sessionId);
      if (!live || live.caller !== callerKey(request)) return sessionNotFound();
      live.lastUsed = now();
      const response = await live.transport.handleRequest(request, {
        ...requestOptions?.authInfo !== undefined && { authInfo: requestOptions.authInfo },
        ...requestOptions?.parsedBody !== undefined && { parsedBody: requestOptions.parsedBody },
      });
      if (request.method.toUpperCase() === 'GET' && response.ok && response.headers.get('content-type')?.includes('text/event-stream')) {
        live.listening = true;
        await live.server.server.sendToolListChanged().catch(() => {});
        return finishWhenRead(response, () => {
          if (sessions.get(sessionId) !== live) return;
          live.listening = false;
          live.lastUsed = now();
        });
      }
      return response;
    }
    if (request.method.toUpperCase() === 'POST' && isInitializeBody(requestOptions?.parsedBody)) {
      const caller = callerKey(request);
      if (!(await admit(caller))) return tooManySessions();
      let id = '';
      const server = factory();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (next) => { id = next; },
        onsessionclosed: (closedId) => {
          const live = sessions.get(closedId);
          sessions.delete(closedId);
          void live?.server.close().catch(() => {});
        },
      });
      await server.connect(transport);
      const response = await transport.handleRequest(request, {
        ...requestOptions?.authInfo !== undefined && { authInfo: requestOptions.authInfo },
        ...requestOptions?.parsedBody !== undefined && { parsedBody: requestOptions.parsedBody },
      });
      if (!id || !transport.sessionId) {
        await transport.close().catch(() => {});
        await server.close().catch(() => {});
        return response;
      }
      const stored = await remember({
        transport,
        server,
        caller,
        lastUsed: now(),
        created: created += 1,
        listening: false,
      });
      if (!stored) return tooManySessions();
      return response;
    }
    if (request.method.toUpperCase() !== 'POST') {
      return Response.json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }, { status: 405, headers: { Allow: 'GET, POST, DELETE', 'Cache-Control': 'no-store' } });
    }
    const notify = claimNotify(callerKey(request));
    return serveStateless(request, requestOptions, notify);
  }

  return {
    fetch,
    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);
      const live = [...sessions.entries()];
      sessions.clear();
      await Promise.all(live.map(async ([id, item]) => drop(id, item)));
      await modern.close();
    },
  };
}
