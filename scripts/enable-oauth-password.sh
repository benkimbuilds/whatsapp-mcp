#!/usr/bin/env bash
set -euo pipefail

if [[ ! -t 0 || $# -ne 3 ]]; then
  printf 'Usage (interactive terminal): bash scripts/enable-oauth-password.sh <private-env-file> <https-mcp-url> <owner-email>\n' >&2
  exit 1
fi

env_path=$1
public_url=$2
owner_email=$3
if [[ ! -f "$env_path" ]]; then
  printf 'Private env file does not exist.\n' >&2
  exit 1
fi
if [[ ! "$public_url" =~ ^https://[A-Za-z0-9.-]+/mcp$ || ! "$owner_email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  printf 'Expected an HTTPS /mcp URL and a valid owner email.\n' >&2
  exit 1
fi

original_tty=$(stty -g)
trap 'stty "$original_tty"' EXIT
printf 'Choose a unique password of at least 20 characters: ' >&2
stty -echo
IFS= read -r oauth_password
printf '\nConfirm password: ' >&2
IFS= read -r confirmation
stty "$original_tty"
printf '\n' >&2

if (( ${#oauth_password} < 20 )) || [[ "$oauth_password" != "$confirmation" ]]; then
  printf 'Passwords did not match or were shorter than 20 characters.\n' >&2
  exit 1
fi
unset confirmation

if command -v node >/dev/null 2>&1; then
  node_command=(node)
else
  node_command=(docker run --rm -i --network none --entrypoint node whatsapp-mcp:local)
fi
hash=$(printf '%s' "$oauth_password" | "${node_command[@]}" -e '
  const { randomBytes, scryptSync } = require("node:crypto");
  const chunks = [];
  process.stdin.on("data", chunk => chunks.push(chunk));
  process.stdin.on("end", () => {
    const salt = randomBytes(16);
    const hash = scryptSync(Buffer.concat(chunks), salt, 32);
    process.stdout.write(`scrypt:${salt.toString("hex")}:${hash.toString("hex")}\n`);
  });
')
unset oauth_password

umask 077
temp_file=$(mktemp "${env_path}.tmp.XXXXXX")
trap 'stty "$original_tty"; rm -f "$temp_file"' EXIT
sed '/^OAUTH_PUBLIC_URL=/d; /^OAUTH_EMAIL=/d; /^OAUTH_PASSWORD_HASH=/d' "$env_path" > "$temp_file"
printf 'OAUTH_PUBLIC_URL=%s\nOAUTH_EMAIL=%s\nOAUTH_PASSWORD_HASH=%s\n' "$public_url" "$owner_email" "$hash" >> "$temp_file"
chmod 600 "$temp_file"
mv "$temp_file" "$env_path"
unset hash
printf 'OAuth login configured in %s. Recreate the service to enable it.\n' "$env_path"
