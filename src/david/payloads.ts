/** JSON bodies for the Secretary webhook. Field names match the David contract. */
import { createHmac } from 'node:crypto';

export type EscalationType = 'meeting_book' | 'meeting_change' | 'policy' | 'other' | 'escalation_timeout' | 'resolved_via_whatsapp';

export type EscalationContext = {
  when: string;
  who: string;
  raw_excerpt: string;
};

export type EscalationPayloadInput = {
  requestId: string;
  type: string;
  summary: string;
  suggestedAction: string;
  chatId: string;
  requesterPhone: string;
  context: EscalationContext;
  fallbackAfterMinutes: number;
  issuedAt: string;
};

export function escalationPayload(row: EscalationPayloadInput, type: EscalationType | string = row.type) {
  return {
    request_id: row.requestId,
    type,
    summary: row.summary,
    suggested_action: row.suggestedAction,
    chat_id: row.chatId,
    requester_phone: row.requesterPhone,
    context: {
      when: row.context.when,
      who: row.context.who,
      raw_excerpt: row.context.raw_excerpt,
    },
    fallback_after_minutes: row.fallbackAfterMinutes,
    issued_at: row.issuedAt,
  };
}

export type CodePayloadInput = {
  requestId: string;
  requesterPhone: string;
  repo: string;
  ask: string;
  chatId: string;
  issuedAt: string;
};

export function codeAgentPayload(row: CodePayloadInput, callbackUrl: string | null) {
  const body: {
    request_id: string;
    requester_phone: string;
    repo: string;
    ask: string;
    chat_id: string;
    callback_url?: string;
    issued_at: string;
  } = {
    request_id: row.requestId,
    requester_phone: row.requesterPhone,
    repo: row.repo,
    ask: row.ask,
    chat_id: row.chatId,
    issued_at: row.issuedAt,
  };
  if (callbackUrl) body.callback_url = callbackUrl;
  return body;
}

/** HMAC-SHA256 of the exact JSON body, hex-encoded. Header value is `sha256=<hex>`. */
export function webhookSignature(key: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', key).update(rawBody).digest('hex')}`;
}

export async function postJson(
  url: string,
  key: string,
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (key) {
    headers.Authorization = `Bearer ${key}`;
    headers['X-Webhook-Signature'] = webhookSignature(key, raw);
  }
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: raw,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
