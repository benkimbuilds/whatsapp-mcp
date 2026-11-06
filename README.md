# whatsapp-mcp

Self-hosted bridge from a WhatsApp account you control to a remote [MCP](https://modelcontextprotocol.io) server (Streamable HTTP). Any MCP client that can call an HTTPS URL can use it. Nothing in this repository assumes a particular hosted agent, including Grok Bot.

**Give an assistant [LLM_SETUP.md](LLM_SETUP.md) to set this up.** That guide asks you the questions it cannot answer, keeps secrets out of chat, and stops for QR pairing. Setup is not fully unattended.

This tree is a sanitized snapshot of the production bridge. It is a fresh repository with no prior git history. See [Provenance](#provenance).

> **Unofficial client.** [Baileys](https://github.com/WhiskeySockets/Baileys) is not affiliated with WhatsApp or Meta. Linking an unofficial client can violate the WhatsApp Terms of Service and can get a number temporarily or permanently banned. Use accounts you control, keep traffic low, and do not bulk-message. A product that needs WhatsApp should use the official WhatsApp Cloud API.

## What it does

- Keeps one or more WhatsApp accounts linked as always-on devices and stores chat history in SQLite on a volume you control.
- Exposes each account as `POST /mcp` with read, search, and draft tools. Sending, reactions, and deletion stay **off** until you set them.
- Optionally POSTs new incoming messages to a webhook you choose, in a rate-limited batch.
- Optionally runs **David**, a separate assistant session that does not auto-reply. It forwards inbound events to your own webhook. Replies leave only through an explicit send path, and only after `ALLOW_SEND=true`.

## Required and optional

| Piece | Required? | Role |
|---|---|---|
| One WhatsApp account you control, and a phone present for the QR scan | Required | The linked device |
| Node.js 22.13+ **or** Docker | Required | Run the process |
| `MCP_BEARER_TOKEN` of at least 16 characters, not the example placeholder | Required | Authenticates `/mcp` |
| Persistent `AUTH_DIR` (Compose volume or a durable directory) | Required | Session keys and history. Losing it means pairing again |
| HTTPS in front of the process before any remote client connects | Required for remote clients | Loopback is enough for a client on the same machine |
| `ALLOW_SEND` / `ALLOW_DELETE` | Optional, default **false** | Turn on only the actions you accept |
| Assistant session (second number, port 8788) | Optional | A second linked device with its own token and volume |
| David assistant | Optional | In-bridge assistant, approved contacts, escalation webhook |
| OAuth login | Optional | For clients that cannot store a bearer header |
| `/admin` dashboard | Optional | Needs `ADMIN_SECRET` on the personal process only |
| Incoming `WEBHOOK_URL` | Optional | Personal process only. Not HMAC signed |
| Secretary escalation webhook | Optional | David only. HMAC signed |
| `MEDIA_SEND_DIR` | Optional | Local files for `whatsapp_send_media`. Unset refuses paths |
| Cloudflare Tunnel, Caddy, or another TLS proxy | Optional choice | Any of them can publish the loopback port. None is built in |

No hosted agent product is required. A client that can send `Authorization: Bearer …` to a Streamable HTTP MCP URL is enough.

## Architecture

```
MCP client (any)
    │  HTTPS  POST /mcp
    │  Authorization: Bearer <per-session token>
    ▼
TLS proxy you run (Cloudflare Tunnel, Caddy, …)  →  127.0.0.1:8787
    ▼
whatsapp-mcp personal          optional assistant :8788
    │  Baileys linked device              │
    │  AUTH_DIR + history.sqlite          │  own AUTH_DIR
    ▼                                     ▼
WhatsApp

Optional, personal process only:
  new incoming messages ──batch──▶ WEBHOOK_URL   (not signed)

Optional David process (Compose profile "david", also on 8788):
  inbound events ──HMAC batch──▶ your escalation webhook
  replies only if ALLOW_SEND=true, through the paced sender
  personal /admin may call David on the Compose network at
  http://david:8788/internal/admin  (not a public route)
```

Log lines use the prefix `whatsapp-bridge:<role>`. The MCP server name is `whatsapp-bridge-<role>`. Those identifiers match the process, not a separate product.

One process pairs one WhatsApp account. Do not point two processes at the same `AUTH_DIR` or `HISTORY_DB_PATH`.

### WhatsApp connection

Baileys links this process as a companion device. The first start prints a QR code. You scan it from the phone: WhatsApp → Settings → Linked devices → Link a device. Later restarts reuse the files in `AUTH_DIR` until the phone unlinks the device. The phone does not stay cabled to the server. It does have to remain a valid linked session.

### Persistence

Compose mounts a named volume at `/data/auth` inside the container:

| Service | Host port | Volume | History file |
|---|---|---|---|
| personal | `127.0.0.1:8787` | `personal_auth` | `/data/auth/history.sqlite` |
| assistant (optional) | `127.0.0.1:8788` | `assistant_auth` | `/data/auth/history.sqlite` |
| david (optional) | `127.0.0.1:8788` | `david_auth` | history plus `david.sqlite` |

The Compose project name is `whatsapp-mcp`, so the personal volume is `whatsapp-mcp_personal_auth`. `docker compose down -v` **deletes these volumes**. Do not run it. Back up a volume only while that service is stopped, and store the backup as private data. It contains the linked-device keys and message history.

A host install uses `AUTH_DIR` on disk the same way. `HISTORY_DB_PATH` defaults to `AUTH_DIR/history.sqlite`.

### MCP authentication and tools

`/mcp` requires `Authorization: Bearer <MCP_BEARER_TOKEN>`. The placeholder `change-me-to-a-long-random-secret` is rejected. Comparison is timing-safe. Optional OAuth is a second way in, for one owner email and a scrypt password hash. It does not replace the bearer for clients that can hold a header.

`GET /healthz` is unauthenticated. It reports process and connection state (`whatsapp.state`, `hasCreds`, `allowSend`, `allowDelete`). It does not include a phone number or message text. `whatsapp_status` does include the paired number and requires the bearer.

Sending tools (`whatsapp_send_text`, `whatsapp_send_media`, `whatsapp_send_draft`, `whatsapp_react`) return an error while `ALLOW_SEND` is not true. Delete tools return an error while `ALLOW_DELETE` is not true. Read, search, draft editing, and `whatsapp_resolve_recipient` keep working. David owner-command replies and callback notices also stay silent until `ALLOW_SEND=true`.

`whatsapp_action` is the stable tool. `action: "list_actions"` returns every action and its schema, including actions that are not separate tools (`ping`, `webhook_status`, and David-only actions).

### Incoming batching and webhooks

On the **personal** process, `WEBHOOK_URL` enables a generic HTTP POST of new incoming messages. Direct messages are included. Group messages are included only when the group JID is listed in `WEBHOOK_GROUP_JIDS`. The first qualifying message opens a window (`WEBHOOK_BATCH_SECONDS`, default 600). Further messages join that window. One JSON body is sent when it ends, with at most 100 previews of 200 characters. `WEBHOOK_MAX_PER_HOUR` (default 6) drops anything beyond the cap. The body is **not** HMAC signed. Treat the URL and `WEBHOOK_KEY` as secrets. Leave this unset on assistant and David.

This is not an agent callback and it is not David's escalation webhook.

### Optional David assistant and escalations

David is a second WhatsApp number with an in-process assistant. It does not auto-reply to ordinary chats. A direct message, or a group message that addresses David (the name, an @mention including a LID mention, or a reply to David's message), is stored and posted to `SECRETARY_ESCALATION_WEBHOOK_URL` in a batch (`SECRETARY_ESCALATION_BATCH_SECONDS`, default 60). That POST sends `Authorization: Bearer <key>` and `X-Webhook-Signature: sha256=<hmac of the raw body>`. Verify the HMAC on your receiver.

Replies, owner slash commands, and code-callback notices use one paced queue (typing delay, per-chat gap, per-minute and per-hour caps). They send only when `ALLOW_SEND=true`. First messages to someone who has not written first require an approved contact and a daily cold-send cap. Details and the event schema: [DAVID.md](DAVID.md), [docs/david-secretary-events.md](docs/david-secretary-events.md).

David does not call Cursor and does not take a Cursor API credential. `SWE_CODE_AGENT_WEBHOOK_URL` is ignored. `POST /david/cursor-callback` only accepts a bearer you configured (`DAVID_CALLBACK_SECRET`) and is how a pull-request link can be written back.

Do not run `assistant` and `david` together. Both publish `127.0.0.1:8788`.

## Requirements

- A machine that stays on. Two gigabytes of RAM is a reasonable start; measure actual use.
- Node.js **22.13+** if you do not use Docker. The image is `node:22-bookworm-slim`. Node's built-in SQLite is still marked experimental by Node.
- Docker with Compose v2.24 or newer if you use Compose (David's env file is optional so personal commands still work).
- One WhatsApp account you are allowed to link. A second account only if you enable assistant or David.
- For a remote MCP client: a hostname and TLS. The process itself speaks HTTP.

## Local setup (no Docker)

```bash
git clone https://github.com/benkimbuilds/whatsapp-mcp.git
cd whatsapp-mcp
npm ci
npm run build
cp .env.personal.example .env.personal
chmod 600 .env.personal
# Replace MCP_BEARER_TOKEN locally. Do not paste the token into chat.
# openssl rand -hex 32
# Leave ALLOW_SEND=false and ALLOW_DELETE=false until you decide otherwise.
DOTENV_CONFIG_PATH=.env.personal node dist/index.js
```

`dotenv` reads `DOTENV_CONFIG_PATH` (default `.env`). Use a separate env file, port, token, and `AUTH_DIR` for each session. An always-on host should run the process under systemd or another supervisor. A sample unit is below.

## Docker setup

```bash
git clone https://github.com/benkimbuilds/whatsapp-mcp.git
cd whatsapp-mcp
cp .env.personal.example .env.personal
chmod 600 .env.personal
# Unique MCP_BEARER_TOKEN inside the file. openssl rand -hex 32
docker compose up -d --build personal
docker compose logs -f personal
```

That starts **only** personal. Compose publishes `127.0.0.1:8787` on the host. Inside the container the process binds `0.0.0.0` so Docker can publish the port. Do not publish 8787 or 8788 on a public interface. Put TLS in front of loopback.

`environment:` in the Compose file sets port, bind address, auth directory, role, and internal URLs. It does **not** set `ALLOW_SEND` or `ALLOW_DELETE`. Those come from the env file, and the examples are `false`. The env file is also where the bearer token lives. Compose does not interpolate that token from the shell.

Optional assistant, after you create `.env.assistant` with a **different** token and its own `ALLOW_SEND=false`:

```bash
docker compose up -d --build assistant
```

Optional David, without recreating personal:

```bash
cp .env.david.example .env.david
chmod 600 .env.david
# Fill MCP_BEARER_TOKEN and OWNER_PHONE locally. Leave ALLOW_SEND=false.
docker compose build david
docker compose up -d --no-deps --force-recreate david
```

`david` is in Compose profile `david`, so a plain `docker compose up` does not start it. `.env.david` is optional in the compose file, which keeps personal commands working when the file is absent. Create it before starting David or the process exits for lack of a token.

The image tag is `whatsapp-mcp:local`.

## QR pairing

You must be present with the phone. The QR is a login credential. Do not copy it into chat, tickets, or screenshots that leave the machine.

1. `docker compose logs -f personal` (or the Node process stdout).
2. On that phone: WhatsApp → Settings → Linked devices → Link a device. Scan **that** QR.
3. Confirm:

```bash
curl -s http://127.0.0.1:8787/healthz
```

`ok: true` means the HTTP process is up, including while it is waiting for a QR. `whatsapp.state` becomes `"open"` and `whatsappConnected` becomes `true` after pairing. Later restarts reconnect without a new QR while the volume is intact.

If the phone unlinks the device, stop the service, remove **that** volume or `AUTH_DIR`, and pair again. Back up `history.sqlite` first if you need the saved history.

```bash
docker compose rm -sf personal
docker volume rm whatsapp-mcp_personal_auth
docker compose up -d personal
```

Repeat with the matching phone for assistant or David. Never scan the personal QR with a different account.

## HTTPS and connecting an MCP client

Bind stays on loopback. Terminate TLS in a proxy you control.

Cloudflare Tunnel is one option, not a requirement. In the Cloudflare dashboard, create a remotely managed tunnel and install `cloudflared` using Cloudflare's own instructions: [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/). Keep the tunnel credential on the machine. A published route looks like:

| Public hostname | Service |
|---|---|
| `wa-personal.example.com` | `http://localhost:8787` |
| `wa-assistant.example.com` | `http://localhost:8788` (only if you run assistant) |

Set the HTTP Host header to `localhost` **or** add the public hostname to `ALLOWED_HOSTS`. The process checks `Host` when it is not bound to loopback (inside the container it is bound to `0.0.0.0`). A public Host without an allow entry is `403`.

Do not publish David. Personal reaches it at `http://david:8788` on the Compose network. Requests to `/internal/*` that carry `Cf-Ray`, `Cf-Connecting-Ip`, `Cf-Ipcountry`, or `X-Forwarded-For` are 404, which is how tunnel traffic is kept off those routes.

Caddy, Tailscale Funnel, or another reverse proxy works the same way: one public HTTPS URL per process, each forwarded to a different loopback port. Avoid free tunnels that inject an interstitial page. MCP clients often cannot click through it.

There is no legacy `/sse` endpoint. Transport is Streamable HTTP, `POST /mcp`.

Example client config. Replace the host. Put the real token in the client config on your machine, not in a chat transcript. The placeholders below are not secrets and will be rejected if used as-is.

```json
{
  "mcpServers": {
    "whatsapp-personal": {
      "url": "https://wa-personal.example.com/mcp",
      "headers": {
        "Authorization": "Bearer PERSONAL_TOKEN_HERE"
      }
    }
  }
}
```

Add a second server only if you run assistant, with the assistant URL and the assistant token.

### Optional OAuth

Leave `OAUTH_PUBLIC_URL` empty to keep OAuth off. Static bearer clients keep working when it is on.

For a client that cannot store a bearer header, set these in the **private** env file and recreate that service:

```dotenv
OAUTH_PUBLIC_URL=https://wa-personal.example.com/mcp
OAUTH_EMAIL=owner@example.com
OAUTH_PASSWORD_HASH=scrypt:...generated-hash...
```

Generate the hash on the machine, in an interactive terminal. The script does not print the password or the hash:

```bash
bash scripts/enable-oauth-password.sh .env.personal https://wa-personal.example.com/mcp owner@example.com
```

The password must be at least 20 characters and must not be reused from WhatsApp or the machine. Accepted redirect URIs are `cursor://anysphere.cursor-mcp/oauth/callback`, `https://www.cursor.com/agents/mcp/oauth/callback`, and `http://localhost:8787/callback`. Access tokens last 24 hours. Refresh tokens rotate and last up to 30 days. Authorization codes are single-use and use PKCE.

The first time `ALLOW_DELETE` flips on, existing OAuth grants are invalidated so the next consent screen includes deletion. Bearer clients are gated by the token and the flag. Rotate the token if a client should not gain deletion.

## Configuration

Every variable is described in [`.env.example`](.env.example). Role templates:

- [`.env.personal.example`](.env.personal.example) — main number
- [`.env.assistant.example`](.env.assistant.example) — optional second number
- [`.env.david.example`](.env.david.example) — optional David

Generate secrets with `openssl rand -hex 32`. Minimums: bearer 16 characters, `ADMIN_SECRET` and `DAVID_READ_SECRET` 24 characters and must not contain `change-me`. Use a different bearer for every session.

| Variable | Required | Notes |
|---|---|---|
| `MCP_BEARER_TOKEN` | yes | Per session |
| `ALLOW_SEND` | no | Default false. Also gates David replies |
| `ALLOW_DELETE` | no | Default false. Own messages only |
| `PORT` / `HOST` | no | 8787 and `127.0.0.1` on the host. Compose overrides these two |
| `AUTH_DIR` | no | This session's Baileys directory |
| `SESSION_ROLE` | no | `personal`, `assistant`, or `david` |
| `MEDIA_MAX_BYTES` | no | Default 16M, max 100M |
| `MEDIA_SEND_DIR` | no | Only directory `path` may read |
| `ALLOWED_HOSTS` | when Host is not loopback | Comma-separated |
| `OAUTH_*` | no | See above |
| `ADMIN_SECRET` | no | Personal `/admin` only |
| `DAVID_READ_SECRET` | no | Shared by personal and David for internal reads |
| `DAVID_ADMIN_URL` | no | Compose sets `http://david:8788` |
| `WEBHOOK_*` | no | Personal incoming batch |
| `OWNER_PHONE` | David only | Digits, country code, no default |
| `SECRETARY_ESCALATION_*` | no | David escalation webhook |

## Recipient safety

A bare phone number is a direct chat and nothing else.

- Digits, an optional `+`, spaces, or dashes: the bridge resolves `<digits>@s.whatsapp.net` (8 to 15 digits, country code included).
- If a lookup returns a group JID, a LID, or anything that is not that phone's direct chat, the send, the draft, and `whatsapp_resolve_recipient` **refuse**. Nothing is queued.
- A group needs an explicit JID ending in `@g.us`. A LID (`…@lid`) is explicit. Passing a phone number never selects a group, even if that group is the most recently active chat.
- `whatsapp_resolve_recipient` uses the same rules and does not send. The result includes `requestedTo`, `kind` (`bare_phone`, `phone_jid`, `lid`, `group`, or `other`), and `jid`.
- MCP call logs store `toKind` and lengths, not the message text. Check `kind` before you send.
- On David, the same guard wraps the paced sender. Approved contacts and the cold-send cap are additional limits, not a way around the phone-versus-group rule.

`whatsapp_send_media` uses that same recipient path. It sends one image, video, audio file, or document from exactly one of `base64`, an `https` URL, or `path` inside `MEDIA_SEND_DIR`. URLs must be https, follow at most three redirects, and are refused when the address is loopback, private, link-local, or CGNAT. `kind: "document"` sends any file as a document. Audio cannot carry a caption.

There is no separate `whatsapp_send_file` tool. File send is `whatsapp_send_media`. See [Provenance](#provenance).

`whatsapp_delete_message` (older name `whatsapp_delete_for_everyone`) revokes one message **this account sent**. It will not delete someone else's message. The history row stays and is marked deleted. Recipients may already have the message. WhatsApp may refuse an old revoke.

## Usage examples

Read-only calls are safe to try after pairing. Send and delete examples are here so a client knows the shape. They do nothing useful until you set the flags, and you should point them at a chat you mean to touch. The JIDs below are the fictional fixtures used in tests.

List tools (no send):

```bash
curl -s http://127.0.0.1:8787/healthz

read -rsp 'Personal MCP token: ' PERSONAL_TOKEN; echo
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $PERSONAL_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Resolve before any send. A bare number that does not come back as a direct chat is a refusal, which is what you want:

```json
{ "name": "whatsapp_resolve_recipient", "arguments": { "to": "15555550100" } }
```

Opt-in send, only after `ALLOW_SEND=true` and an open connection:

```json
{ "name": "whatsapp_send_text", "arguments": { "to": "15555550100", "text": "hello" } }
```

Opt-in file, same flag. `kind` may be omitted; `document` forces a file bubble:

```json
{
  "name": "whatsapp_send_media",
  "arguments": {
    "to": "120363000000000099@g.us",
    "url": "https://example.com/report.pdf",
    "kind": "document",
    "filename": "report.pdf"
  }
}
```

A group send must pass the `@g.us` JID. A phone number will not be redirected there.

| Tool | Sends? |
|---|---|
| `whatsapp_action` | Same gate as the action it runs |
| `whatsapp_status` | No |
| `whatsapp_resolve_recipient` | No. Lookup only |
| `whatsapp_list_chats`, `whatsapp_read_messages`, `whatsapp_find_contact`, `whatsapp_search_messages` | No. Saved history |
| `whatsapp_group_activity`, `whatsapp_mentions` | No |
| `whatsapp_group_info` | No. Live counts, no member phone numbers |
| `whatsapp_download_media` | No chat message. Fetches one saved file |
| `whatsapp_create_draft`, `whatsapp_list_drafts`, `whatsapp_cancel_draft` | No. `sendAt` is a reminder, not a timer |
| `whatsapp_send_text`, `whatsapp_send_media`, `whatsapp_send_draft`, `whatsapp_react` | Yes, needs `ALLOW_SEND=true` |
| `whatsapp_delete_message`, `whatsapp_delete_for_everyone` | Yes, needs `ALLOW_DELETE=true`, own messages only |
| `whatsapp_webhook_blocklist_list`, `_add`, `_remove` | No send. Add does not purge old rows |
| `whatsapp_approved_contacts_*` | David only. Does not itself send |

Blocklist, quotes, reactions, drafts, and history behavior are covered by the offline tests and by comments on the tools. A blocklist drops matching **inbound** messages before storage and forwarding. It starts empty. It does not block outbound sends. Purging stored rows is a confirmed action on `/admin/david`, not an MCP tool.

## Verification

Offline, no WhatsApp account and no sends:

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run smoke
```

`npm test` includes `scripts/privacy-scan.mjs`. GitHub Actions runs the same sequence on push and pull request (`.github/workflows/ci.yml`).

After a real install, still without sending:

```bash
curl -s http://127.0.0.1:8787/healthz
# tools/list with the bearer, as in the example above
# a wrong token must be HTTP 401
# the personal token must be HTTP 401 on the assistant port, if assistant is running
```

Do not call a send or delete tool as a connectivity test.

## Troubleshooting

| What you see | What to check |
|---|---|
| Process exits immediately | `MCP_BEARER_TOKEN` missing, shorter than 16 characters, or still the example placeholder. David also exits without `OWNER_PHONE` |
| `whatsapp.state` is not `open` | QR not scanned, phone unlinked the device, or the volume was recreated. Read the logs. Do not paste the QR |
| HTTP 401 on `/mcp` | Wrong bearer, or the token from the other session |
| HTTP 403 | `Host` is not loopback and not in `ALLOWED_HOSTS`. Tunnel routes that forward the public Host need that name listed, or an HTTP Host override of `localhost` |
| Send tool returns `ALLOW_SEND=false` | Expected until you edit the env file and recreate the container. Compose will not turn it on for you |
| Send refused, "not a direct chat" | A phone number resolved to something other than that person's direct chat. Pass an explicit `…@g.us` JID for a group |
| Assistant and David both fail to bind | They share host port 8788. Run one of them |
| Personal `/admin` says David is unavailable | David is stopped, `DAVID_READ_SECRET` does not match, or `DAVID_ADMIN_URL` is wrong. Personal keeps serving its own history |
| Webhook never fires | `WEBHOOK_URL` unset, message was outbound, group JID not listed, or the hourly cap dropped it. `whatsapp_action` `webhook_status` shows counts, not message text |
| `docker compose up` asks for `.env.assistant` | You started the assistant service. Use `docker compose up -d --build personal` for one number |
| History gone after a restart | The process used an ephemeral `AUTH_DIR`, or someone ran `docker compose down -v` |

## Security limitations

- Anyone who holds a session token can use every tool that session has enabled, including send and delete once those flags are on. Treat the token like a password for that WhatsApp account.
- `ALLOW_SEND=false` and `ALLOW_DELETE=false` are the safe defaults. Turning them on is the operator's decision and applies to every client of that token.
- `/healthz` is public on whatever interface you publish. Do not put message content there. The paired number is only on the authenticated status tool.
- The personal incoming webhook is not signed. David's escalation webhook is signed. Verify that HMAC yourself.
- SQLite deletes are not secure erasure of old pages, WAL files, or backups.
- `whatsapp_group_info` returns subjects, counts, this account's role, and community JIDs. It does not return member phone numbers. Group JIDs are still identifiers.
- Auth directories, env files, QR codes, and webhook keys do not belong in git, chat, or tickets. `.gitignore` and `.dockerignore` exclude env files (except the examples), auth directories, and SQLite files. That ignore list is not a substitute for reading a diff before you publish a fork.
- This process can be banned by WhatsApp. It is not the official API.
- OAuth passwords, bearer tokens, and `DAVID_READ_SECRET` are only as private as the host. This repository cannot see or rotate them for you.

## systemd sample

```ini
# /etc/systemd/system/whatsapp-mcp-personal.service
[Unit]
Description=whatsapp-mcp personal session
After=network.target

[Service]
WorkingDirectory=/opt/whatsapp-mcp
EnvironmentFile=/opt/whatsapp-mcp/.env.personal
ExecStart=/usr/bin/node dist/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

Pair from `journalctl -u whatsapp-mcp-personal -f`.

## Repository layout

```
src/index.ts           HTTP server, env gates, webhook and David wiring
src/recipient.ts       bare-phone direct-chat guard
src/mcp-tools.ts       MCP tools and whatsapp_action
src/media-send.ts      load a file for whatsapp_send_media; does not send
src/whatsapp.ts        Baileys connection, QR, reconnect
src/store.ts           SQLite history
src/webhook.ts         personal incoming batch
src/david/             optional assistant
scripts/               offline tests, privacy scan, OAuth hash helper
docs/                  David event schema
Dockerfile
docker-compose.yml
LLM_SETUP.md           guide to hand to an assistant
DAVID.md               David behavior
.env*.example          placeholders only
```

## Provenance

Authoritative source: `https://github.com/benkimbuilds/whatsapp-bridge` commit `ec74c827d5984aac56b87a60895017c2321c3d04` (2026-10-30, merge of the recipient resolve work). This repository is a new root commit of that tree plus the documentation and safety edits below. Source git history was not copied.

Included from that snapshot:

- Bare phone numbers only resolve to that person's direct chat (`src/recipient.ts`, source commits `f287ffa` and merge `ec74c82`).
- David group forwarding for LID @mentions and replies to David (`d14b123`).
- `whatsapp_resolve_recipient` dry-run and `toKind` call logging, with regression tests (`43cf5a7`).
- Quoted replies, reactions, delete, media download, and `whatsapp_send_media` (`d158658`), which is the file-send path.
- The earlier bridge: history, search, drafts, groups, webhooks, blocklists, admin, OAuth, and optional David.

Not incorporated:

- `https://github.com/benkimbuilds/whats-app-bridge-agustin` commit `971acaf8a1` (described elsewhere as adding `whatsapp_send_file`, one commit ahead of `ee770e21bc`). That repository returned 404 to both the authenticated GitHub integration and anonymous access, so its diff could not be reviewed. No second file-send tool was added. `whatsapp_send_media` remains the send path and uses the recipient guard above.

Edits made for this public tree, on top of that snapshot:

- Compose and the example env files no longer turn `ALLOW_SEND` or `ALLOW_DELETE` on. David refuses outbound delivery when `ALLOW_SEND` is false, including owner commands and callbacks.
- The recipient regression fixture uses fictional numbers and names. The 11-digit versus 23-character length check is unchanged.
- `HANDOFF.md` and `GROKBOT_HANDOFF.md` are omitted. [LLM_SETUP.md](LLM_SETUP.md) is the setup guide for an assistant.
- README and examples point at this repository. A privacy scan and GitHub Actions workflow were added.

## License

`package.json` says `UNLICENSED`. No `LICENSE` file is included and none is granted by publishing this code. You can see the code. That is not permission to use, copy, modify, or redistribute it. Choosing a license remains Benjamin Kim's decision.
