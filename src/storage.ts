import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
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
export async function upsertAccounts(provider: ProviderId, values: Array<{ label: string; credential: OAuthCredential }>, policy: 'keep-newer' | 'replace' | 'add-only' = 'keep-newer'): Promise<StoredAccount[]> {
  const config = await loadConfig();
  const credentials = await loadCredentials();
  const accounts = values.map(({ label, credential: given }) => {
    const existing = config.accounts.find((a) => a.provider === provider && a.id === given.accountId);
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
    if (write) credentials[credentialId] = credential;
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
