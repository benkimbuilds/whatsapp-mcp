# David Secretary events

David does not send automatic WhatsApp replies. Every inbound message that David should see becomes one event. Events leave only through `SECRETARY_ESCALATION_WEBHOOK_URL`, in a fixed window of `SECRETARY_ESCALATION_BATCH_SECONDS` (default 60). Replies come back through David's MCP send tools or `POST /david/cursor-callback`. Both of those go through the paced sender.

`SWE_CODE_AGENT_WEBHOOK_URL` is ignored. If it is set, the process logs once that it is deprecated. `SWE_CODE_AGENT_WEBHOOK_KEY` is still accepted as the callback bearer when `DAVID_CALLBACK_SECRET` is empty.

`AIBM_GROUP_JID` is parsed and ignored. It is not a gate. `FALLBACK_AFTER_MINUTES` is parsed and ignored. David does not DM the owner on a timer.

The personal `WEBHOOK_URL` batch is a different webhook. Its window, retry, and hourly cap are unchanged. It is not HMAC signed. David's Secretary POST is.

## What becomes an event

- Every direct message, except status broadcasts, other broadcasts, and newsletters.
- A group message when it addresses David (the name "david", an @mention of this account, or a reply to this account).
- Every group message when `DAVID_GROUP_ALL=true`. The default is false.
- Messages David sent, stubs, and empty text are not events.

The keyword classifier sets `hint` only. It never sends.

## Batching

The first unsent row opens one window. Later rows join it. The deadline does not move. `0` flushes inside the inbound handler. Shutdown (`SIGTERM` or `SIGINT`) flushes even if the window is still open.

The outbox in `david.sqlite` is the source of truth. A row is marked sent only after HTTP 2xx. A failed POST stays unsent and is retried on the 15 second tick. Rows already marked are not sent again. A crash after the receiver accepted the body and before the row was marked can deliver that batch once more. Dedupe on `chat_jid` + `message_id`.

An empty Secretary URL stores the rows and marks them sent locally. Nothing is POSTed. The key is never logged.

## Request

- Method: `POST`
- URL: `SECRETARY_ESCALATION_WEBHOOK_URL`
- `content-type: application/json`
- `accept: application/json`
- Redirects are not followed (`redirect: manual`)
- Timeout: 10 seconds
- When `SECRETARY_ESCALATION_WEBHOOK_KEY` is non-empty, both of these headers are set:
  - `Authorization: Bearer <key>`
  - `X-Webhook-Signature: sha256=<hex>`
- The signature is HMAC-SHA256 of the raw JSON body, using the key as the HMAC secret, hex-encoded, prefixed with `sha256=`. When the key is empty, both headers are omitted.

## Body

```json
{
  "account": "david",
  "account_jid": "5215550000000@s.whatsapp.net",
  "account_phone": "5215550000000",
  "style": "Be succinct: one or two short sentences. Do not be flattering or subservient. No thanks-so-much, happy-to-help, gushing, or over-apologizing. Match the sender's language. In Spanish, never use ¡ or ¿.",
  "events": [
    {
      "type": "inbound_message",
      "account": "david",
      "account_jid": "5215550000000@s.whatsapp.net",
      "account_phone": "5215550000000",
      "chat_jid": "15555550177@s.whatsapp.net",
      "chat_name": "Alex",
      "is_group": false,
      "sender_jid": "199999999990001@lid",
      "sender_phone": "15555550177",
      "sender_name": "Alex",
      "message_id": "ABC123",
      "text": "can we meet tomorrow at 4 pm?",
      "timestamp": "2026-10-19T21:49:00.000Z",
      "reply": null,
      "language": "en",
      "hint": "meeting",
      "context": [
        {
          "message_id": "PREV",
          "from_me": false,
          "sender_jid": "15555550177@s.whatsapp.net",
          "sender_phone": "15555550177",
          "text": "earlier message",
          "timestamp": "2026-10-19T21:40:00.000Z"
        }
      ]
    }
  ]
}
```

`account` is `SESSION_ROLE` (`david` on this service). `account_jid` prefers the phone JID, otherwise the paired LID. `account_phone` is digits only when that JID is a real 8–15 digit number, otherwise null.

`style` is the current style guide, a string. It is the saved guide from `david_settings`, or the built-in default when that setting is empty. Every batch includes it, including a batch that was stored before this field existed and is flushed later. Older consumers that ignore unknown fields keep working. The other fields are unchanged. The guide is instructions for the Secretary, not a WhatsApp message, so it may name the marks ¡ and ¿. Editing the guide on `/admin/david` changes the next batch. No new environment variable is required.

`sender_phone` is digits when the sender JID is a phone JID, when `remoteJidAlt` / `participantAlt` carries one, or when `jid_links` (or the contact `pn`) maps a LID. It is `""` when none of those exist. A meeting from an unresolved LID is still an event.

`reply` is null, or `{ "message_id", "participant", "text" }` when the inbound message quotes another. `text` on the reply is at most 300 characters.

`language` is `en` or `es`. A clear signal in the current message wins and is stored for that chat and sender. Otherwise the stored language is kept. Otherwise recent messages in the chat are scanned, skipping David's own messages and, when the sender is not the owner, skipping the owner's messages. A Mexican number (`52…`) with no signal defaults to Spanish. Anything else defaults to English. The default is not stored. Templates do not use inverted punctuation.

`hint` is one of `owner_command`, `command`, `ai`, `welcome`, `meeting`, `meeting_change`, `meeting_unimportant`, `code`, `code_denied`, `policy`, `escalate`, or null for ordinary chat.

`context` is the previous messages in that chat, oldest first, at most `DAVID_EVENT_CONTEXT_MESSAGES` (default 10, range 1–50). A context row whose `from_me` is true also has `sent_by_account` set to this account. The current message is not repeated in `context`.

### Code object

Present only when `hint` is `code` or `code_denied`. It is an object when the sender is allowlisted for the named `owner/name` repo. Otherwise it is null. David does not POST the SWE webhook and does not tell the chat that work started.

```json
"code": {
  "request_id": "8c1a2c4e-1111-4111-8111-111111111111",
  "repo": "owner/name",
  "callback_url": "https://wa-david.example.com/david/cursor-callback",
  "ask": "please fix the login bug in owner/name"
}
```

`callback_url` is null when `DAVID_CALLBACK_PUBLIC_BASE` is empty. The callback still accepts `Authorization: Bearer <DAVID_CALLBACK_SECRET or the SWE key>`. A `done` result with an https `pr_url` is sent to the original chat through the paced sender, quoting `message_id` when one was stored.

## Paced sender

Every David outbound send (MCP `whatsapp_send_text`, `whatsapp_send_draft`, owner-command replies, and the callback) uses one queue:

1. Refuse a 1:1 chat that has never messaged David, unless that phone is on the code allowlist (the owner is) or on the approved-contact list. The approved list bypasses only this refusal. A group David has no saved chat or message for is still refused. An approved contact who has never written is a cold send. The daily cap is `approved.cold_per_day` in `david_settings` (default 5, edited on `/admin/david`). Over the cap, the error is `Cold-send limit reached for today. This approved contact has not written to this account.` Someone who has already written does not count.
2. Wait for the per-chat gap and the global per-minute and per-hour caps. If the wait would exceed `DAVID_SEND_MAX_WAIT_MS`, the call returns a rate-limit error instead of blocking.
3. Mark the quoted message, or the latest inbound in that chat, as read.
4. Send composing presence, wait a typing delay, then paused. The delay is `typingMinMs + length * typingMsPerChar`, plus random jitter up to 2 seconds, clamped to `typingMinMs`…`typingMaxMs`.
5. If David's strip toggle is on (the default), remove ¡ and ¿ from the text, then collapse doubled spaces and trim a leading or trailing space run that the removal left. Text that had neither mark is unchanged. The toggle is the `style.strip` setting (`on` or `off`). Off sends the text exactly as given. Personal and assistant do not use this queue and do not strip.
6. Send the text. A `replyTo` message id is quoted.

`whatsapp_send_text`, `whatsapp_create_draft`, and `whatsapp_send_draft` on David accept E.164 digits, a `@s.whatsapp.net` JID, or a `@lid` JID. Pass the phone JID when the bot has it. A LID is resolved to the phone JID before this queue runs, so the allowlist matches either form. David's Baileys lid-mapping is tried first. If it has no phone, David calls `GET /internal/lid-pn` on personal with `DAVID_READ_SECRET` (`199999999990002@lid` → `5215550102030@s.whatsapp.net` when personal has that pair). That route accepts Host `personal` or loopback and rejects Cloudflare or `X-Forwarded-For` headers with 404; the same 404 applies to every `/internal/*` path on both containers. `onWhatsApp()` runs only for a never-seen number on allowlist add or the first cold send, and the answer is cached for 7 days. A known chat or a mapped LID (such as `199999999990001@lid` → `15555550177@s.whatsapp.net`) does not call it. The stored contact and the send use the phone JID. An unresolvable LID is an error and is not sent. See [DAVID.md](../DAVID.md) for the add, remove, and cap tools.

Canned lines (the pull request reply, the code-failed notice, and the other stored templates) are read from `david_settings` at send time. A missing or blank line uses the built-in text. Owner slash-command replies stay as they are.

Owner slash commands run only from the owner's own DM and the reply goes only to that chat. `david_resolve_escalation` does not message the requester.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SECRETARY_ESCALATION_BATCH_SECONDS` | `60` | Fixed window. `0`–`86400`. Invalid values use 60. `0` flushes immediately. |
| `DAVID_GROUP_ALL` | `false` | `true` events every group message. |
| `DAVID_EVENT_CONTEXT_MESSAGES` | `10` | Prior messages on each event. `1`–`50`. |
| `DAVID_TYPING_MIN_MS` | `2000` | Shortest composing pause. |
| `DAVID_TYPING_MAX_MS` | `12000` | Longest composing pause. Raised to the minimum if it is lower. |
| `DAVID_TYPING_MS_PER_CHAR` | `40` | Added to the minimum per character before the clamp. |
| `DAVID_CHAT_GAP_MS` | `15000` | Minimum time between sends in one chat. |
| `DAVID_SEND_PER_MINUTE` | `5` | Global cap. `1`–`600`. |
| `DAVID_SEND_PER_HOUR` | `40` | Global cap. `1`–`5000`. |
| `DAVID_SEND_MAX_WAIT_MS` | `60000` | Refuse instead of waiting longer than this. |
| `SECRETARY_ESCALATION_WEBHOOK_URL` | empty | Batch target. Empty marks events sent locally. |
| `SECRETARY_ESCALATION_WEBHOOK_KEY` | empty | Bearer and HMAC secret. |
| `SWE_CODE_AGENT_WEBHOOK_URL` | empty | Deprecated. Ignored for delivery. |
| `SWE_CODE_AGENT_WEBHOOK_KEY` | empty | Callback bearer fallback only. |
| `FALLBACK_AFTER_MINUTES` | `30` | Ignored. No automatic DM. |
| `AIBM_GROUP_JID` | empty | Ignored. Not a gate. |
| `OWNER_PHONE` | none | Required. Digits, country code, 8–15. No default. |
| `PERSONAL_LID_URL` | empty | Personal base URL for a LID David cannot map. `http://personal:8787` in Compose. |

## Deploy

Rebuild and recreate `david` and `personal`. Personal serves the dashboard section and `GET /internal/lid-pn`. Do not recreate `assistant`. Do not change `docker-compose.override.yml`. Do not run `docker compose down -v`.

```bash
docker compose build david personal
docker compose up -d --no-deps --force-recreate david personal
```
