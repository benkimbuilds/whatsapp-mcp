// Fail the export if tracked text looks like a credential, a live session file,
// or a phone / LID / group id that is not an obvious fixture. Prints file, line,
// and category only.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipDir = new Set(['node_modules', 'dist', '.git', 'coverage', 'data', 'auth']);
const skipFile = new Set(['package-lock.json']);
const secretPatterns = [
  { name: 'private-key', re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PRIVATE )/ },
  { name: 'github-token', re: /\bghp_[A-Za-z0-9]{20,}/ },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'stripe-live-key', re: /\bsk_live_[A-Za-z0-9]{8,}/ },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}/ },
];

const findings = [];

function note(file, line, kind) {
  findings.push(`${path.relative(root, file)}:${line} ${kind}`);
}

function fixtureDigits(digits) {
  return digits.includes('555')
    || digits.includes('123456')
    || digits.includes('987654')
    || /0{4,}/.test(digits)
    || /1{4,}/.test(digits)
    || /(\d)\1{5,}/.test(digits);
}

function digitsAllowed(digits, kind) {
  if (kind === 'group' && digits.length <= 12) return true;
  if (digits.length < 8) return true;
  return fixtureDigits(digits);
}

function hostAllowed(raw) {
  let host = raw.replace(/[),.;]+$/, '').toLowerCase();
  if (host.includes('${') || host.includes('{') || host.includes('}') || host.includes('<')) return true;
  const at = host.lastIndexOf('@');
  if (at >= 0) host = host.slice(at + 1);
  const colon = host.indexOf(':');
  if (colon >= 0) host = host.slice(0, colon);
  if (host.startsWith('[')) return true;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host === 'personal' || host === 'david' || host === 'host') return true;
  if (host.endsWith('.example.com') || host === 'example.com') return true;
  if (host.endsWith('.example.org') || host === 'example.org') return true;
  if (host.endsWith('.example.test') || host === 'example.test') return true;
  if (host.endsWith('.example') || host.endsWith('.test') || host.endsWith('.invalid')) return true;
  if (host === 'github.com' || host.endsWith('.github.com') || host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com')) return true;
  if (host === 'developers.cloudflare.com' || host === 'modelcontextprotocol.io') return true;
  if (host === 'forum.cursor.com' || host === 'www.cursor.com') return true;
  if (host === 'mmg.whatsapp.net' || host.endsWith('.whatsapp.net')) return true;
  return false;
}

function scanText(file, text) {
  const lines = text.split(/\n/);
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    for (const pattern of secretPatterns) {
      if (pattern.re.test(line)) note(file, lineNo, pattern.name);
    }
    for (const match of line.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
      const domain = match[1].toLowerCase();
      if (domain === 's.whatsapp.net' || domain === 'c.us' || domain === 'g.us') continue;
      if (domain === 'example.com' || domain.endsWith('.example.com')) continue;
      if (domain === 'example.org' || domain === 'example.test' || domain === 'localhost') continue;
      note(file, lineNo, `email-domain:${domain}`);
    }
    for (const match of line.matchAll(/(\d{6,20})@(s\.whatsapp\.net|c\.us|lid|g\.us)/gi)) {
      const server = match[2].toLowerCase();
      const kind = server === 'g.us' ? 'group' : server === 'lid' ? 'lid' : 'phone';
      if (!digitsAllowed(match[1], kind)) note(file, lineNo, `${kind}-jid`);
    }
    for (const match of line.matchAll(/(?<![A-Fa-f0-9])(\d{10,15})(?![A-Fa-f0-9])/g)) {
      if (!digitsAllowed(match[1], 'phone')) note(file, lineNo, 'digit-run');
    }
    for (const match of line.matchAll(/\bhttps?:\/\/([^/\s)'"`]+)/gi)) {
      if (!hostAllowed(match[1])) note(file, lineNo, 'url-host');
    }
  });
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (skipDir.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (!entry.isFile() || skipFile.has(entry.name)) continue;
    if (/(^|\/)(creds\.json)$/i.test(entry.name) || /\.(sqlite|sqlite3|db|pem|key|p12|pfx)$/i.test(entry.name) || /^(id_rsa|id_ed25519)$/.test(entry.name)) {
      note(full, 1, 'sensitive-filename');
      continue;
    }
    const info = await stat(full);
    if (info.size > 2_000_000) {
      note(full, 1, 'unexpected-large-file');
      continue;
    }
    const bytes = await readFile(full);
    if (bytes.includes(0)) continue;
    scanText(full, bytes.toString('utf8'));
  }
}

const nonFixture = '31415' + '926535';
if (fixtureDigits('15555550100') !== true || fixtureDigits(nonFixture) !== false || nonFixture.length !== 11) {
  console.error('privacy-scan self-check failed');
  process.exit(1);
}

await walk(root);
if (findings.length > 0) {
  console.error(`privacy-scan failed (${findings.length})`);
  for (const finding of findings) console.error(finding);
  process.exit(1);
}
console.log('privacy-scan ok');
