# Set up whatsapp-mcp

Hand this file to an assistant that can edit files and run commands on the machine where the bridge will run. Read [README.md](README.md) for the product description, recipient rules, and limits. This file is the procedure.

**This setup is not fully unattended.** The assistant cannot scan the WhatsApp QR, invent a safe public hostname, or decide that sending messages is acceptable. It must stop and ask a person at the steps marked **Ask** and **Stop**.

Do not send WhatsApp messages, invite people, pair an account the person did not name, or print secrets into the chat. A successful setup ends with `/healthz` showing `whatsapp.state: "open"` and `tools/list` returning HTTP 200. It does not end with a test send.

## 1. Ask before changing anything

Ask the person, and wait:

1. Which machine will run the bridge, and will it stay on? A laptop that sleeps will drop the linked device.
2. Docker Compose, or Node.js 22.13+ on the host?
3. One WhatsApp number (personal only), or also an optional second number (assistant or David, not both on port 8788)?
4. Will MCP clients run on that same machine (loopback is enough) or somewhere else (they need HTTPS)?
5. If remote: which hostname, and which TLS proxy they can already operate (Cloudflare Tunnel, Caddy, something else)? Do not create a Cloudflare account or a DNS record they did not ask for.
6. Should the connector be read-only? The correct default is yes: `ALLOW_SEND=false` and `ALLOW_DELETE=false`. Turn a flag on only after they say, in this conversation, that this number may send or may delete its own messages.
7. Do they want the optional incoming webhook, the optional `/admin` dashboard, optional OAuth, or optional David? Each needs extra secrets and, for David, a second phone.

If they only said "set it up", assume: one personal session, Docker if Docker is installed otherwise Node, loopback only, read-only, no webhook, no David, no OAuth, no admin UI. Tell them that assumption before you continue.

## 2. Prerequisites

Confirm, do not invent:

- Git clone of `https://github.com/benkimbuilds/whatsapp-mcp.git` and a directory they choose, such as `/opt/whatsapp-mcp` or a home directory.
- Node.js 22.13 or newer **or** Docker with Compose v2.24+.
- `openssl` for generating tokens.
- A phone with the WhatsApp account they will link, in their hands, for the QR step.
- Outbound network access so Baileys can reach WhatsApp. You do not need to open a public inbound port if clients are local.

`npm test` does not need a WhatsApp account. Run it if you changed code. A normal install does not require changing code.

## 3. Create env files without leaking secrets

Work on the host. Do not echo tokens, do not write them into the chat, and do not commit the filled-in file.

```bash
cd /path/to/whatsapp-mcp
cp .env.personal.example .env.personal
chmod 600 .env.personal
umask 077
TOKEN=$(openssl rand -hex 32)
# Write the token into MCP_BEARER_TOKEN in .env.personal using a local editor
# or a careful in-place replace. Then unset TOKEN.
unset TOKEN
```

Check without printing the secret:

```bash
# exit 0 when the placeholder is gone and the value is at least 16 characters
python3 - <<'PY'
from pathlib import Path
text = Path(".env.personal").read_text()
value = ""
for line in text.splitlines():
    if line.startswith("MCP_BEARER_TOKEN="):
        value = line.split("=", 1)[1].strip()
ok = value and value != "change-me-to-a-long-random-secret" and len(value) >= 16
send = [line for line in text.splitlines() if line.startswith("ALLOW_SEND=")]
delete = [line for line in text.splitlines() if line.startswith("ALLOW_DELETE=")]
print("token_ok", ok, "length", len(value))
print("send_line", send)
print("delete_line", delete)
raise SystemExit(0 if ok else 1)
PY
```

Leave `ALLOW_SEND=false` and `ALLOW_DELETE=false` unless they explicitly opted in. Leave `OAUTH_*`, `WEBHOOK_*`, `ADMIN_SECRET`, and `DAVID_READ_SECRET` empty when those features were not requested.

`.env.personal` is gitignored. `git status` must not show it. If it does, stop.

Repeat with `.env.assistant` or `.env.david` only when that session was requested. Each file gets its own token. David also needs `OWNER_PHONE` (digits, country code, no plus). Ask them to type that phone into the file themselves if you can avoid seeing it. If you must write it, do not repeat it back in chat.

## 4. Choose infrastructure

| They have | Do this | Do not |
|---|---|---|
| Docker | `docker compose up -d --build personal` | `docker compose up` with no service name, if `.env.assistant` does not exist. Do not run `docker compose down -v` |
| Node only | `npm ci && npm run build` then `DOTENV_CONFIG_PATH=.env.personal node dist/index.js` under systemd or another supervisor | Commit `node_modules` or `dist` |
| Client on the same machine | Stop after loopback works. URL `http://127.0.0.1:8787/mcp` | Open the port on a public interface |
| Remote client | They must already have a TLS proxy. Point it at `http://127.0.0.1:8787` and either override the Host header to `localhost` or set `ALLOWED_HOSTS` to the public hostname | Put the bearer token in a public URL or a ticket |

The Compose file publishes `127.0.0.1:8787:8787` only. Keep it that way. Auth and history live in the volume `whatsapp-mcp_personal_auth`, mounted at `/data/auth`. That volume is required. An empty container disk will demand a new QR after every recreate that drops the volume.

Assistant, if requested, uses `127.0.0.1:8788` and volume `whatsapp-mcp_assistant_auth`. David uses the same host port and volume `whatsapp-mcp_david_auth`, and it does not start unless you name the service. Never start assistant and David together.

## 5. Start the process

Docker:

```bash
docker compose up -d --build personal
docker compose ps
docker compose logs --tail=50 personal
```

Node, in the foreground for the first pairing, then move it to a supervisor:

```bash
npm ci
npm run build
DOTENV_CONFIG_PATH=.env.personal node dist/index.js
```

**Stop** when the log says the process is waiting for a QR. Tell the person the log command (`docker compose logs -f personal` or the terminal that is running Node). Ask them to scan it from the intended phone: WhatsApp → Settings → Linked devices → Link a device.

Do not copy the QR into chat. Do not screenshot it into the ticket. If they say they cannot scan right now, leave the process running or stopped as they prefer, and end the session as blocked on pairing. You cannot finish pairing for them.

## 6. Confirm the link

After they say they scanned:

```bash
curl -s http://127.0.0.1:8787/healthz
```

Wait until `whatsapp.state` is `open` and `whatsappConnected` is true. `ok: true` alone only means HTTP is up. If it stays on a QR state, ask them to scan again. If the phone says the device is already linked and the process still wants a QR, the volume is a different directory than the one that was paired. Do not delete a volume that might hold the only copy of history unless they agree.

## 7. Connect the MCP client

Ask which client they use. Then:

- URL: `https://wa-personal.example.com/mcp` (their real hostname), or `http://127.0.0.1:8787/mcp` on the same machine.
- Header: `Authorization: Bearer <the token in .env.personal>`.
- Transport: Streamable HTTP. There is no `/sse` URL.

Have them paste the header into the client's own config UI. If you can write a local config file, write the token from `.env.personal` into that file without printing it. A placeholder like `PERSONAL_TOKEN_HERE` in an example is not a working token.

Clients that cannot store a header need optional OAuth. Only set that up if they asked. Run `bash scripts/enable-oauth-password.sh` in an interactive terminal **they** are using, so the password is typed there and not in chat. Then recreate the container. Accepted redirect URIs are listed in the README.

A wrong or missing bearer returns HTTP 401. A public hostname that arrives as `Host` and is not in `ALLOWED_HOSTS` returns HTTP 403.

## 8. Optional webhook and routines

Skip this section unless they asked.

**Personal incoming webhook.** They provide `WEBHOOK_URL` and a `WEBHOOK_KEY` generated on the machine. Set them in `.env.personal` and recreate personal. Direct messages are batched, default every 10 minutes, max 6 batches an hour. Group JIDs must be listed explicitly in `WEBHOOK_GROUP_JIDS` or those groups are ignored. This POST is not HMAC signed. Do not point it at a URL you cannot describe to them.

**David escalations.** Separate from the webhook above. They need a second WhatsApp number, `OWNER_PHONE`, a distinct bearer, and `SECRETARY_ESCALATION_WEBHOOK_URL` plus key if something should receive events. The receiver must verify `X-Webhook-Signature`. David still does not send WhatsApp replies until `ALLOW_SEND=true`. Start it with:

```bash
docker compose build david
docker compose up -d --no-deps --force-recreate david
```

Do not recreate personal as part of that command. Do not put a Cursor API credential in `.env.david`. David does not call Cursor.

There is no built-in cron inside this repository. If their MCP client has its own scheduled tasks, those tasks are configured in the client, not here. A schedule that sends messages needs `ALLOW_SEND=true` and a recipient they have checked with `whatsapp_resolve_recipient`.

## 9. Smoke tests

Run these. Do not add a send or delete call.

```bash
curl -s http://127.0.0.1:8787/healthz
```

Expect `ok: true`, `session: "personal"`, `allowSend: false`, `allowDelete: false` unless they opted in, and `whatsapp.state: "open"` after pairing.

Then `tools/list` with the bearer, the same request as in the README. Expect a JSON-RPC result that includes `whatsapp_status`, `whatsapp_list_chats`, and `whatsapp_resolve_recipient`. Expect send tools to be listed too. Listing them does not enable them. Calling `whatsapp_send_text` while `ALLOW_SEND=false` must return an error and must not deliver a message. You do not need to call it to prove that. The flag in `/healthz` is the check.

A useful authenticated read, after pairing, is `whatsapp_status` or `whatsapp_list_chats`. Do not paste phone numbers or message text from the result into chat. Say "status is open" or "chats returned" instead.

`whatsapp_resolve_recipient` on a real number asks WhatsApp whether that number exists. Use it only when they want to check a specific recipient, and report `kind` and whether it is a direct chat, not a copied address book.

Offline, any time, from a clean checkout:

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run smoke
```

Those tests must not open a live WhatsApp session. If `npm test` fails on `privacy-scan`, do not publish the tree. Fix the finding or stop and report it. The scanner prints a file, line, and category. It does not print the secret. Do not print the offending line into chat if the category is a credential.

## 10. Troubleshooting

| Symptom | Next step |
|---|---|
| Exit on startup | Token still the placeholder, or shorter than 16 characters. David without `OWNER_PHONE` also exits |
| Logs show a QR and they already scanned | They scanned a different process's QR, or the auth directory is not the volume that survived the restart |
| `state` never leaves the connecting/QR state | Phone has no network, unofficial clients are restricted on that account, or outbound HTTPS from the host is blocked. Ask them. Do not try a second account |
| 401 | Token in the client does not match this session's env file |
| 403 | `ALLOWED_HOSTS` or the proxy Host header |
| Send "succeeds" during a smoke test | Stop. `ALLOW_SEND` is true. Set it false and recreate unless they opted in. Do not send another message |
| Port in use | Assistant and David both want 8788, or an old process is still bound |
| `git status` shows `.env.personal` | Stop. The ignore rule failed. Do not commit |

## 11. Acceptance checklist

All of these are true before you call the setup done:

- [ ] Person confirmed the machine, the account, and read-only versus send/delete.
- [ ] `.env.personal` exists, mode `600`, token is not the placeholder, and the token was not written into chat.
- [ ] `ALLOW_SEND` and `ALLOW_DELETE` match what they asked. Default is false. Compose was not edited to force them true.
- [ ] Process is supervised (Compose restart policy or systemd), and the auth volume or `AUTH_DIR` is on persistent disk.
- [ ] Person scanned the QR themselves. `GET /healthz` shows `whatsapp.state` `open`.
- [ ] Their MCP client can `tools/list` with the bearer. A missing bearer returns 401.
- [ ] No send or delete tool was called as a test.
- [ ] Optional pieces they did not ask for are unset: webhook, OAuth, admin, assistant, David.
- [ ] `git status` is clean of env files, auth directories, and SQLite files.
- [ ] You told them the unofficial-client and ban risk, and that no open-source license is granted (see README License).

If any box is unchecked, say what is blocked and who has to act. Do not mark pairing done because the container is healthy.
