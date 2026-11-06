# David (WhatsApp PA)

David is the owner's assistant on a **separate** Baileys session (a second WhatsApp number). Set `OWNER_NAME` so its canned lines use your name. The brain runs **in this process**. It is not the personal bridge and it is not the batched incoming-message webhook (`WEBHOOK_URL`).

Personal keeps its current container, volume, token, and webhook. David is an extra Compose service.

## Deploy David only

On the host, from the directory that contains `docker-compose.yml`:

```bash
cp .env.david.example .env.david
chmod 600 .env.david
# Fill tokens and webhook URLs in .env.david on the VM. Do not commit that file.

docker compose build david
docker compose up -d --no-deps --force-recreate david
docker compose logs -f david
```

Leave `personal` running. Do not `docker compose build personal`, do not `docker compose up personal`, and do not recreate it as part of this deploy.

`docker compose build david` rebuilds the shared image tag `whatsapp-mcp:local`. The running personal container keeps the image it already started with until someone recreates it. Do not recreate it.

Never run `docker compose down -v`. That deletes linked-device volumes, including `personal_auth`.

`assistant` is the old stopped PA slot and publishes the same host port `127.0.0.1:8788`. Leave `assistant` stopped. Do not start `assistant` and `david` together.

`david` is in Compose profile `david`, so a plain `docker compose up` does not start it. Naming the service does. `.env.david` is optional in the compose file (Compose v2.24 or newer) so a missing file does not make `personal` commands fail. Create `.env.david` before starting David, or the process exits for lack of `MCP_BEARER_TOKEN`.

David's auth and `david.sqlite` live on the volume `david_auth`, mounted at `/data/auth`. Do not point David at `personal_auth` or `assistant_auth`.

Suggested public MCP hostname, not wired in this repo: `https://wa-david.example.com/mcp` (Cloudflare Tunnel to `http://localhost:8788` with HTTP Host Header `localhost`). Pair by scanning the QR from `docker compose logs -f david` with the WhatsApp account you want this session to use. You must be present with that phone. Do not publish the QR.

## Environment

Placeholders live in `.env.david.example`. Real values stay in `.env.david` on the VM.

| Variable | Purpose |
|---|---|
| `MCP_BEARER_TOKEN` | David MCP bearer. Different from personal and assistant. Placeholder is rejected. |
| `OAUTH_PUBLIC_URL`, `OAUTH_EMAIL`, `OAUTH_PASSWORD_HASH` | Optional, same pattern as personal, for this session only. |
| `SESSION_ROLE` | `david`. Compose sets this. |
| `DAVID_MODE` | `true`. Also turns the brain on if the role is something else. Compose sets this. |
| `OWNER_PHONE` | Required. Digits only, with country code. Owner commands and the all-repos allowlist. The process exits if this is missing or not 8–15 digits. There is no default. |
| `OWNER_NAME` | Optional. The owner's name in canned replies ("I'm Alex's assistant"). Default `the owner`. |
| `AIBM_GROUP_JID` | Tolerated and ignored. Not a gate. |
| `SECRETARY_ESCALATION_WEBHOOK_URL` | Where inbound events are POSTed. |
| `SECRETARY_ESCALATION_WEBHOOK_KEY` | Bearer and the HMAC secret for that POST. |
| `SECRETARY_ESCALATION_BATCH_SECONDS` | Default `60`. Fixed window. `0` flushes immediately. |
| `DAVID_GROUP_ALL` | Default false. True sends every group message, not only ones that address David. |
| `DAVID_EVENT_CONTEXT_MESSAGES` | Default `10`. Prior messages copied onto each event. |
| `DAVID_TYPING_MIN_MS` / `DAVID_TYPING_MAX_MS` / `DAVID_TYPING_MS_PER_CHAR` | Composing pause. Defaults `2000`, `12000`, and `40`. |
| `DAVID_CHAT_GAP_MS` | Default `15000`. Minimum gap between sends in one chat. |
| `DAVID_SEND_PER_MINUTE` / `DAVID_SEND_PER_HOUR` | Defaults `5` and `40`. |
| `DAVID_SEND_MAX_WAIT_MS` | Default `60000`. Longer waits are refused. |
| `SWE_CODE_AGENT_WEBHOOK_URL` | Deprecated. Not called. |
| `SWE_CODE_AGENT_WEBHOOK_KEY` | Callback bearer fallback only. |
| `FALLBACK_AFTER_MINUTES` | Tolerated and ignored. No automatic DM to the owner. |
| `DAVID_CALLBACK_PUBLIC_BASE` | Origin only, such as `https://wa-david.example.com`. Code events then include `callback_url` `{base}/david/cursor-callback`. |
| `DAVID_CALLBACK_SECRET` | Bearer for that callback. If empty, the SWE key is used. If both are empty, the route answers 503. |
| `DAVID_TIMEZONE` | Quiet-hours clock for `/quiet`. Default `UTC`. Quiet hours do not drop events. |
| `ALLOW_SEND` / `ALLOW_DELETE` | Both default to false in `.env.david.example`. Compose does not override them. `ALLOW_SEND=true` is required before MCP sends, owner-command replies, and callback notices leave this account. `ALLOW_DELETE=true` allows deletion only of this account's own messages. |
| `PORT` | `8788` inside the container and on host loopback. |
| `DAVID_READ_SECRET` | Same value as in `.env.personal`. Enables `GET /internal/admin/*`, the style write, and the approved-contact writes so the personal dashboard can read this service and save those settings. There is no separate write secret. Leave `ADMIN_SECRET` unset. |
| `PERSONAL_LID_URL` | Optional. `http://personal:8787` in Compose, or `http://127.0.0.1:8787` for a local personal process. Used only when this session's Baileys lid-mapping has no phone for a `@lid` JID. http, localhost or one DNS label, no userinfo. |

Do not put a Cursor API credential in the app, in `.env.david`, or on the VPS. David never calls Cursor.

Leave `WEBHOOK_URL` unset on David. That variable is the personal incoming-message batch webhook and is a different feature. It is not HMAC signed. David's Secretary POST is.

Leave `ADMIN_SECRET` unset. David does not serve `/admin` and must not get a public hostname. The personal dashboard reads `GET /internal/admin/*` on this process with `DAVID_READ_SECRET`. The same bearer authorizes `PUT /internal/admin/style` (the style guide, the canned lines, and the inverted-punctuation toggle) and the approved-contact routes (`GET` and `POST /internal/admin/approved-contacts`, `POST /internal/admin/approved-contacts/remove`, `PUT /internal/admin/approved-contacts/cap`). A missing or wrong bearer is 401. Compose allows the Host value `david` for that call and still publishes the port only on `127.0.0.1`. History, escalations, code-agent rows, the code allowlist, deflections, the Secretary outbox, and the paced-send snapshot stay read-only. Approved contacts are a separate table in `david.sqlite`. The route does not send a WhatsApp message.

## Secretary events

David sends no automatic replies. A direct message, and a group message that mentions David or replies to him, is stored and POSTed in a one-minute batch. The exact body, the HMAC header, and the paced-sender rules are in [docs/david-secretary-events.md](docs/david-secretary-events.md).

The classifier only fills `hint`. `can we meet tomorrow at 4 pm?` is `hint: meeting`. A greeting such as "nice to meet you" is not. Nothing in that path sends a WhatsApp message.

A failed POST stays in `david_outbox` and is retried. Shutdown flushes the open window. The log line is `event=queued` or `event=ignored` plus a reason, the chat JID, and the message id. It does not include the text or the key.

## Replies

WhatsApp sends happen only when something asks for one:

- An owner slash command in the owner's own DM (`OWNER_PHONE`). The reply goes only to that chat, through the paced sender.
- MCP `whatsapp_send_text`, `whatsapp_send_media`, or `whatsapp_send_draft` on this session. Same queue. A `replyTo` id is quoted with the saved original's text and sender; an id that is not saved sends without a quote. A number that has never messaged David is refused unless it is on the code allowlist or the approved-contact list. A group David is not in is refused. An approved contact who has never written counts as a cold send, capped per day.
- `POST /david/cursor-callback` when a code request finishes. The pull request link goes to the original chat through the same queue.

`david_resolve_escalation` updates the stored row and does not message the requester.

## Resolve action

There is no new MCP tool. On the David session only, `whatsapp_action` gains:

- `david_resolve_escalation` with `{ request_id, decision: approve|deny|edit, note?, edited_action? }`
- `david_allowlist_list`
- `david_allowlist_grant` with `{ phone, repo }`
- `david_allowlist_revoke` with `{ phone, repo? }`
- `david_code_status` with `{ request_id }`

`tools/list` on personal and assistant includes eighteen tools, including the three webhook-blocklist tools. They do not register the `david_*` actions or the approved-contact tools. David adds the three approved-contact tools (twenty-one total). A client that cached the old list needs to list tools again (`listChanged` is already advertised).

`david_resolve_escalation` is idempotent. The first call stores the decision and returns `status: 200`. A later call returns `status: 409` and `error: already_resolved` without changing the decision. It does not send a WhatsApp message.

Grant and revoke require the David session's MCP credential. WhatsApp `/allowlist` commands run only from `OWNER_PHONE` in a direct chat, and the answer goes only to that chat. The owner's all-repos grant cannot be revoked.

## Code requests

The phone in `OWNER_PHONE` may name any `owner/name` repo. Anyone else needs a grant. When the hint would be `code` and the allowlist passes, the Secretary event includes a `code` object (`request_id`, `repo`, `callback_url`, `ask`) and a row is stored for the callback. Otherwise `hint` is `code` or `code_denied` and `code` is null. David does not POST `SWE_CODE_AGENT_WEBHOOK_URL` and does not tell the chat that work started.

`POST /david/cursor-callback` exists only on the David process. `Authorization: Bearer <DAVID_CALLBACK_SECRET or the SWE key>`. A `done` body with an `https` `pr_url` is sent into the original chat through the paced sender. The same `pr_url` again does not send a second message. A missing or wrong bearer is 401.

`david_code_status` reports `pending`, `acked`, `done`, or `failed` for that `request_id`.

## Approved contacts

This list is not the code allowlist. It is who David may message before they have written to this account. Rows live in `david_approved_contacts` inside `david.sqlite` (`jid`, `phone`, `display_name`, `note`, `added_by`, `added_at`, and the `lid` when one was resolved). The `jid` is always `user@s.whatsapp.net`. Nothing is hardcoded.

It bypasses only the guard whose text is `Refusing to message a number that has not written to this account.` The paced sender still marks the quoted or latest inbound message read, waits out the typing delay, and enforces the per-chat gap and the per-minute and per-hour caps. ¡ and ¿ are still stripped when that toggle is on. A group David does not know is still refused. The code allowlist is unchanged.

A cold send is a successful message to an approved contact who has never written. The cap defaults to 5 per calendar day in `DAVID_TIMEZONE`. It is the `approved.cold_per_day` row in `david_settings` (an integer from 0 to 100; a missing or invalid row uses 5). `/admin/david` edits it. When the cap is hit the send returns `Cold-send limit reached for today. This approved contact has not written to this account.` A contact who has already written does not consume the cap. A failed or rate-limited send does not either. The next local day starts the count over.

Every add, remove, and cold send is appended to `david_approved_log` and written to the process log as `approved=add`, `approved=remove`, or `approved=cold_send` with the phone JID. The log line does not include the message text.

`/admin/david` on the personal dashboard lists the contacts, adds one, removes one, and edits the cap. The login is the personal admin secret. The dashboard calls David's internal routes with `DAVID_READ_SECRET`. Those routes answer 401 without that bearer.

On the David MCP connector only:

- `whatsapp_approved_contacts_list`
- `whatsapp_approved_contacts_add` with `{ identifier, display_name?, approved_by, reason }`. `approved_by` and `reason` are required.
- `whatsapp_approved_contacts_remove` with `{ identifier }`

### Which identifier to pass

Pass any of these. David stores and sends the phone JID.

- E.164 digits with country code, `+` optional: `5215550102030` or `+5215550102030`
- Phone JID: `5215550102030@s.whatsapp.net` (`@c.us` is accepted and rewritten)
- LID: `199999999990002@lid`

Prefer the phone JID when the bot already has it. A LID is resolved before the allowlist check and before the send, so a later send to either form matches the same contact. Resolution order:

1. This session's Baileys lid-mapping store, then a phone already linked in this session's history.
2. `GET /internal/lid-pn?lid=` on the personal container (`PERSONAL_LID_URL`, bearer `DAVID_READ_SECRET`). That route answers only for Host `personal` or loopback, and only when the request has none of `Cf-Ray`, `Cf-Connecting-Ip`, `Cf-Ipcountry`, or `X-Forwarded-For`. Any `/internal/*` request on personal or David that carries one of those headers is 404, including a correct bearer, because the Cloudflare tunnel sends `Host: localhost`. The dashboard's server-side calls to `http://david:8788/internal/admin/*` send no forwarding headers, so they still use the bearer. A missing bearer on an allowed call is 401. `199999999990002@lid` is the shape that resolves to `5215550102030@s.whatsapp.net` when personal has that mapping.
3. `onWhatsApp()` only for a phone David has never seen, and only on an allowlist add or a first cold send. A saved chat, contact, or LID mapping skips it. `199999999990001@lid` maps to `15555550177@s.whatsapp.net` and does not call `onWhatsApp()`. An answer is cached for 7 days. A number WhatsApp does not know is rejected and that negative answer is cached too.

If none of those produce a phone, the call returns `Could not resolve <lid> to a WhatsApp phone number.` The same resolver runs for `whatsapp_send_text`, `whatsapp_create_draft`, and `whatsapp_send_draft` on David. A draft keeps a plain phone number as a phone JID and resolves a LID from the mappings above. A draft does not call `onWhatsApp()`.

## Persona and groups

David does not author a message unless a command, the callback, or MCP send asked for one. Stored templates still exist for those paths. They are Spanish or English. The built-in Spanish lines do not use inverted punctuation. `/admin/david` on the personal dashboard has a Style section that edits the guide, those lines, and a toggle that strips ¡ and ¿ from every David send (on by default). Saving requires the admin login. The dashboard proxies to `PUT /internal/admin/style` with `DAVID_READ_SECRET`. The current guide is the top-level `style` field on every Secretary batch.

Direct messages are always events. Group messages are events when they address David, or all of them when `DAVID_GROUP_ALL=true`. Group join stubs are skipped.

Owner commands, from the owner's direct chat only, reply only to the owner:

- `/allowlist`, `/allowlist grant <phone> <owner/name|*>`, `/allowlist revoke <phone> [repo]`
- `/status`
- `/quiet`, `/quiet off`, `/quiet 22:00-08:00` (zone from `DAVID_TIMEZONE`)
- `/approve [request_id]`, `/deny [request_id]`, `/edit <request_id> <new action>`

`/approve` with no stored escalation tells the owner there is nothing open. Meeting messages do not create those rows; Secretary sees them as events.

## Inbound storage and webhook blocklist

David's `webhook_blocklist` and durable `skipped`/`dropped` counters live in
`david.sqlite`, separate from approved contacts and the code allowlist. The
runtime attaches this same policy to its history store before the socket
starts. Listed senders' DMs and all their group messages are dropped before
history/cache writes, previews, mentions/activity, media handling, language or
code processing, and Secretary queueing. The shared event processor applies
this to history sync and append/backfill as well as notify; history mappings
and PN/LID alternate keys participate in matching. WhatsApp socket receive,
read receipts, outbound sends and approved contacts stay unchanged.

Use `whatsapp_webhook_blocklist_list`, `whatsapp_webhook_blocklist_add`
(`identifier`, optional `name`/`note`, required `approved_by` and `reason`), or
`whatsapp_webhook_blocklist_remove` (`identifier`) on either connector. Each
connector changes only its own account; the same names work as actions.
List output includes read-only `stored_count` (inbound history rows) and
`event_count` (sent and unsent Secretary outbox rows) for each entry.
`dropped` counts ingress observations, including replays; `skipped` retains
its prior total and also counts drops. Pending events still recheck policy.

Existing rows are never automatically purged. Personal's `/admin/david`
provides **Review purge** separately for each entry/account, then requires an
explicit confirmation signed for that entry/account with a five-minute expiry.
The purge removes matching inbound history rows/cache/preview state and David
outbox rows, preserving outbound messages, other group participants and the
blocklist entry. There is no MCP purge tool/action. Counts are logical row
counts; purge does not erase backups or revoke messages inside WhatsApp.

The dashboard uses GET/POST `/internal/admin/webhook-blocklist`, POST
`/internal/admin/webhook-blocklist/remove`, and internal POST
`/internal/admin/webhook-blocklist/purge` with `DAVID_READ_SECRET`. The purge
transport requires an exact listed JID and `confirmation: "PURGE"`.
Cloudflare/forwarding-header rejection runs before bearer auth.

The original one-time seed and its removal marker are unchanged. Preserve the
existing volumes and rebuild/recreate both personal and David for this release;
leave the legacy assistant stopped. No credentials or env changes are needed.
Inspect counts after deploy; purging old data is a separate admin decision for
each account. See README for matching rules, counter semantics and purge scope.
