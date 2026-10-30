import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { decodeJwt } from './auth.js';
import type { OAuthCredential, PersistedState, ProviderId, StoredAccount, TeamAIConfig } from './types.js';

export function dataDir(): string {
  return process.env.TEAMAI_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'teamai');
}
export const paths = () => ({
  config: join(dataDir(), 'config.json'),
  credentials: join(dataDir(), 'credentials.json'),
  state: join(dataDir(), 'state.json'),
  server: join(dataDir(), 'server.json'),
  supervisor: join(dataDir(), 'supervisor.json'),
  codexAppBinding: join(dataDir(), 'codex-app-binding.json'),
  events: join(dataDir(), 'events.log'),
});

export function defaultConfig(): TeamAIConfig {
  return { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, controlPort: 3556, clientToken: `tai-${randomBytes(24).toString('base64url')}` }, switchThreshold: 0.98, warmupIntervalMs: 5 * 60_000, maxConcurrentPerAccount: 16, fableReserveThreshold: 0.8, accounts: [] };
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}

export async function atomicWriteText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, contents, { mode: 0o600 });
  await rename(temp, path);
}

export async function atomicWrite(path: string, value: unknown): Promise<void> { await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`); }

// The activity log: one line per relay event, appended as it happens. The ring
// in state.json keeps 200 events, which under a busy fleet is four minutes —
// both 2026-09-27 blips had scrolled out of it before anyone looked. Rotated
// once a write would carry the file past maxBytes; one previous file is kept
// as `.1`, so the log is bounded at twice the cap.
export async function appendLog(path: string, lines: string[], maxBytes = 8 * 1024 * 1024): Promise<void> {
  if (!lines.length) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const chunk = `${lines.join('\n')}\n`;
  let size = 0;
  try { size = (await stat(path)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (size > 0 && size + Buffer.byteLength(chunk) > maxBytes) await rename(path, `${path}.1`);
  await appendFile(path, chunk, { mode: 0o600 });
}

export async function loadConfig(): Promise<TeamAIConfig> { return readJson(paths().config, defaultConfig()); }
export async function saveConfig(config: TeamAIConfig): Promise<void> { await atomicWrite(paths().config, config); }
export async function loadCredentials(): Promise<Record<string, OAuthCredential>> { return readJson(paths().credentials, {}); }
export async function saveCredentials(value: Record<string, OAuthCredential>): Promise<void> { await atomicWrite(paths().credentials, value); }
export async function loadState(): Promise<PersistedState> { return readJson(paths().state, { version: 1, accounts: {}, events: [] }); }
export async function saveState(value: PersistedState): Promise<void> { await atomicWrite(paths().state, value); }

// 'replace' is for a login the user just completed, which wins over anything,
// even a revoked token with a later expiry. 'keep-newer' is for copies
// (import): they never replace a logged-in credential and otherwise the later
// expiry wins. 'add-only' (cloud pull) never touches a credential already held.
// A Codex login keys its account by the token's chatgpt_account_id claim, while
// a codex-multi-auth import keys it by a workspace id, which for a personal
// account is an org id (org-…). Matching on the stored id alone turned a
// re-login of such an import into a second entry beside the dead one. So a
// login also renews the one entry whose stored token carries the same claim,
// unless that entry's id is itself a ChatGPT account id: then it names a
// workspace exactly, and sharing a token does not make it the same one.
const CHATGPT_ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function codexAccountOf(credential: OAuthCredential | undefined): string | null {
  const auth = credential ? decodeJwt(credential.accessToken)['https://api.openai.com/auth'] : null;
  const id = auth && typeof auth === 'object' ? (auth as Record<string, unknown>).chatgpt_account_id : null;
  return typeof id === 'string' ? id : null;
}

export async function upsertAccounts(provider: ProviderId, values: Array<{ label: string; credential: OAuthCredential }>, policy: 'keep-newer' | 'replace' | 'add-only' = 'keep-newer'): Promise<StoredAccount[]> {
  const config = await loadConfig();
  const credentials = await loadCredentials();
  const accounts = values.map(({ label, credential: given }) => {
    const claimed = provider === 'codex' && policy === 'replace' ? codexAccountOf(given) : null;
    const byClaim = claimed ? config.accounts.filter((a) => a.provider === provider && !CHATGPT_ACCOUNT_ID.test(a.id) && codexAccountOf(credentials[a.credentialId]) === claimed) : [];
    const existing = config.accounts.find((a) => a.provider === provider && a.id === given.accountId) || (byClaim.length === 1 ? byClaim[0] : undefined);
    const credentialId = existing?.credentialId || `${provider}:${given.accountId}`;
    const current = credentials[credentialId];
    const credential = policy === 'replace' ? { ...given, loggedInAt: Date.now() } : given;
    const account: StoredAccount = existing || { id: credential.accountId, provider, label, enabled: true, priority: null, credentialId, createdAt: new Date().toISOString() };
    account.label = label || account.label;
    if (!existing) config.accounts.push(account);
    // An import can carry an older copy of a token this machine already rotated
    // (a stale export, a lagging cloud). Writing it back would replace a live
    // refresh token with a spent one, so the later expiry wins; a copy with no
    // known expiry is taken as given, as before.
    const copyLosesToLogin = policy !== 'replace' && (current?.loggedInAt ?? 0) > (credential.loggedInAt ?? 0);
    const write = policy === 'replace' || !current || (policy === 'keep-newer' && !copyLosesToLogin && (current.expiresAt === null || credential.expiresAt === null || credential.expiresAt >= current.expiresAt));
    // An import that replaces the pair held for an existing account is the user
    // handing a token over. Stamp it, or a running server (which adopts only
    // what it can tell is newer) writes its own copy back over it on the next
    // save. The stamp is not a login stamp: a later import may still replace it.
    // Re-importing the pair already held changes nothing, so it keeps the stamps it has.
    const samePair = current !== undefined && current.accessToken === credential.accessToken && current.refreshToken === credential.refreshToken;
    const handedOver = policy === 'keep-newer' && current !== undefined && !samePair;
    if (write && !(policy === 'keep-newer' && samePair)) credentials[credentialId] = handedOver ? { ...credential, importedAt: Date.now() } : credential;
    return account;
  });
  await saveCredentials(credentials);
  await saveConfig(config);
  return accounts;
}

export async function upsertAccount(provider: ProviderId, label: string, credential: OAuthCredential): Promise<StoredAccount> {
  return (await upsertAccounts(provider, [{ label, credential }], 'replace'))[0]!;
}

export async function removeAccount(credentialId: string): Promise<boolean> {
  const config = await loadConfig(); const credentials = await loadCredentials(); const before = config.accounts.length;
  config.accounts = config.accounts.filter((account) => account.credentialId !== credentialId); delete credentials[credentialId];
  if (config.accounts.length === before) return false;
  await Promise.all([saveConfig(config), saveCredentials(credentials)]); return true;
}
