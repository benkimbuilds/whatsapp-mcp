/** Minimal disconnected Baileys fake for child-process HTTP/MCP tests. No I/O. */
export const Browsers = { macOS: () => ['Test', 'Fake', '1'] };
export const DisconnectReason = { loggedOut: 401 };
export const fetchLatestBaileysVersion = async () => ({ version: [2, 3000, 0] });
export const jidNormalizedUser = jid => jid.replace(/:\d+@/, '@');
export const useMultiFileAuthState = async () => ({ state: { creds: { registered: false } }, saveCreds: async () => {} });
export default function makeWASocket() {
  return { ev: { process() {}, on() {} } };
}
