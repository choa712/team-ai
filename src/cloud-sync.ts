import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { atomicWrite, dataDir } from './storage.js';
import type { OAuthCredential } from './types.js';

// TeamClaude Cloud is used here as an account registry and a token mailbox,
// never as the refresher. The same Claude accounts are in use on several
// machines, and an Anthropic refresh token is single-use: whoever rotates it
// first kills every other copy. So the rule is "rotate locally, publish at
// once, and before rotating check whether someone else already did":
//
//   - before a refresh, adopt the cloud's token if it is newer than ours;
//   - after a refresh, push the new pair so the other machines can adopt it;
//   - when a refresh is refused (the chain moved on elsewhere), re-read the
//     cloud and continue from the chain it holds.
//
// The cloud keeps the freshest token by expiry, so a late or duplicate push
// can never replace a newer pair with an older one.

export interface CloudLink { url: string; key: string }

export interface CloudAccount {
  accountUuid: string;
  name: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number;
}

export const DEFAULT_CLOUD_URL = 'https://auth.teamclaude.cloud';

const cloudPath = (): string => join(dataDir(), 'cloud.json');
const expand = (path: string): string => path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path);

// Credentials never travel over plain HTTP; loopback is allowed for tests.
export function assertSecureUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid cloud URL: ${url}`); }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) throw new Error(`Refusing to send credentials over ${parsed.protocol}//`);
}

// Seconds and milliseconds both appear upstream; anything below 1e10 is seconds.
export function normalizeExpiry(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return value < 10_000_000_000 ? value * 1000 : value;
}

export async function loadCloudLink(): Promise<CloudLink | null> {
  const envKey = process.env.TEAMAI_CLOUD_KEY?.trim();
  let stored: Partial<CloudLink> = {};
  try { stored = JSON.parse(await readFile(cloudPath(), 'utf8')) as Partial<CloudLink>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const key = envKey || (typeof stored.key === 'string' ? stored.key : '');
  if (!key) return null;
  const url = typeof stored.url === 'string' && stored.url ? stored.url : DEFAULT_CLOUD_URL;
  assertSecureUrl(url);
  return { url, key };
}

export async function saveCloudLink(link: CloudLink): Promise<void> {
  assertSecureUrl(link.url);
  await atomicWrite(cloudPath(), link);
}

// The pull key and endpoint TeamClaude already holds, so linking does not put
// the key on a command line where `ps` and shell history would see it.
export async function linkFromTeamClaude(path = '~/.config/teamclaude.json'): Promise<CloudLink> {
  const raw = JSON.parse(await readFile(expand(path), 'utf8')) as { cloud?: { url?: unknown; pullKey?: unknown } };
  const key = typeof raw.cloud?.pullKey === 'string' ? raw.cloud.pullKey : '';
  if (!key) throw new Error(`No cloud pull key in ${path}`);
  const url = typeof raw.cloud?.url === 'string' && raw.cloud.url ? raw.cloud.url : DEFAULT_CLOUD_URL;
  return { url, key };
}

export const maskKey = (key: string): string => key.length <= 8 ? '****' : `${key.slice(0, 4)}…${key.slice(-4)}`;

type FetchLike = (url: string, init: { method?: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: 'error' }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class CloudClient {
  constructor(readonly link: CloudLink, private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike, private readonly timeoutMs = 8_000) { assertSecureUrl(link.url); }

  // Redirects are refused, not followed: a hop to another origin or to plain
  // http would carry the key header and, on push, every token with it.
  private endpoint(path: string): string { return `${this.link.url.replace(/\/+$/, '')}/functions/v1/cloud${path}`; }

  async pull(): Promise<CloudAccount[]> {
    const response = await this.fetchImpl(this.endpoint('/sync/pull'), { headers: { 'x-teamclaude-key': this.link.key }, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    if (!response.ok) throw Object.assign(new Error(`Cloud pull failed (${response.status})`), { status: response.status });
    const data = await response.json() as { accounts?: unknown };
    const list = Array.isArray(data.accounts) ? data.accounts : [];
    return list.flatMap((entry) => {
      const a = entry as Record<string, unknown>;
      if (typeof a.accountUuid !== 'string' || !a.accountUuid) return [];
      return [{
        accountUuid: a.accountUuid,
        name: typeof a.name === 'string' ? a.name : null,
        accessToken: typeof a.accessToken === 'string' && a.accessToken ? a.accessToken : null,
        refreshToken: typeof a.refreshToken === 'string' && a.refreshToken ? a.refreshToken : null,
        expiresAt: normalizeExpiry(a.expiresAt),
      }];
    });
  }

  async push(accounts: Array<{ label: string; credential: OAuthCredential }>): Promise<void> {
    if (!accounts.length) return;
    const body = JSON.stringify({ accounts: accounts.map(({ label, credential }) => ({ accountUuid: credential.accountId, name: label, tier: null, type: 'oauth', accessToken: credential.accessToken, refreshToken: credential.refreshToken, expiresAt: credential.expiresAt ?? 0 })) });
    const response = await this.fetchImpl(this.endpoint('/sync/push'), { method: 'POST', headers: { 'x-teamclaude-key': this.link.key, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    if (!response.ok) throw Object.assign(new Error(`Cloud push failed (${response.status})`), { status: response.status });
  }
}

// A refused refresh means the token chain moved on somewhere else. Transport
// failures and 5xx do not: those say nothing about who holds the chain.
export function refusedRefresh(error: unknown): boolean {
  const match = /OAuth refresh failed \((\d+)\)/.exec((error as Error)?.message ?? '');
  return !!match && (match[1] === '400' || match[1] === '401');
}

const asCredential = (base: OAuthCredential, cloud: CloudAccount): OAuthCredential => ({ ...base, accessToken: cloud.accessToken ?? base.accessToken, refreshToken: cloud.refreshToken ?? base.refreshToken, expiresAt: cloud.expiresAt || base.expiresAt });

// Newer means a later expiry, the same test the cloud uses to keep the freshest token.
export const cloudIsNewer = (cloud: CloudAccount | undefined, local: OAuthCredential): boolean => !!cloud && !!cloud.accessToken && cloud.expiresAt > (local.expiresAt ?? 0);

export class CloudCoordinator {
  private cache: { at: number; accounts: Map<string, CloudAccount> } | null = null;
  private inflight: Promise<Map<string, CloudAccount>> | null = null;
  // Pairs rotated here that the cloud has not confirmed yet, retried on each sync.
  readonly unpublished = new Map<string, { label: string; credential: OAuthCredential }>();

  constructor(private readonly client: Pick<CloudClient, 'pull' | 'push'>, private readonly log: (message: string) => void = () => {}, private readonly cacheMs = 20_000, private readonly now: () => number = Date.now) {}

  async snapshot(force = false): Promise<Map<string, CloudAccount>> {
    if (!force && this.cache && this.now() - this.cache.at < this.cacheMs) return this.cache.accounts;
    if (this.inflight) return this.inflight;
    this.inflight = this.client.pull().then((list) => {
      const accounts = new Map(list.map((a) => [a.accountUuid, a]));
      this.cache = { at: this.now(), accounts };
      return accounts;
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  // The cloud being down must never stop a refresh; it only loses the chance to adopt.
  private async latest(accountId: string, force = false): Promise<CloudAccount | undefined> {
    try { return (await this.snapshot(force)).get(accountId); }
    catch (error) { this.log(`cloud unreachable: ${(error as Error).message}`); return undefined; }
  }

  async publish(label: string, credential: OAuthCredential): Promise<void> {
    this.unpublished.set(credential.accountId, { label, credential });
    try {
      await this.client.push([{ label, credential }]);
      if (this.unpublished.get(credential.accountId)?.credential === credential) this.unpublished.delete(credential.accountId);
      if (this.cache) this.cache.accounts.set(credential.accountId, { accountUuid: credential.accountId, name: label, accessToken: credential.accessToken, refreshToken: credential.refreshToken, expiresAt: credential.expiresAt ?? 0 });
    } catch (error) { this.log(`cloud push deferred for ${label}: ${(error as Error).message}`); }
  }

  // A rotated pair is handed back before it is published: the old refresh token
  // is already spent, so the new one must reach the pool (and disk) at once. A
  // push that is slow or lost is retried by the periodic sync.
  async refresh(label: string, credential: OAuthCredential, rotate: (credential: OAuthCredential) => Promise<OAuthCredential>): Promise<OAuthCredential> {
    const margin = 5 * 60_000;
    const cloud = await this.latest(credential.accountId, true);
    // Another machine already rotated and its access token still has life: take it, rotate nothing.
    if (cloud && cloudIsNewer(cloud, credential) && cloud.expiresAt > this.now() + margin) return asCredential(credential, cloud);
    // The cloud holds a newer chain even if its access token lapsed: continue from that chain.
    const base = cloudIsNewer(cloud, credential) || (cloud?.refreshToken && cloud.expiresAt > (credential.expiresAt ?? 0)) ? asCredential(credential, cloud!) : credential;
    try {
      const next = await rotate(base);
      void this.publish(label, next);
      return next;
    } catch (error) {
      if (!refusedRefresh(error)) throw error;
      // Refused: someone rotated between our read and our rotation. Their push is the only way back.
      const fresh = await this.latest(credential.accountId, true);
      if (!fresh?.refreshToken || fresh.refreshToken === base.refreshToken) throw error;
      if (fresh.accessToken && fresh.expiresAt > this.now() + 60_000) return asCredential(credential, fresh);
      const next = await rotate(asCredential(credential, fresh));
      void this.publish(label, next);
      return next;
    }
  }

  async retryUnpublished(): Promise<number> {
    let sent = 0;
    for (const { label, credential } of [...this.unpublished.values()]) {
      const before = this.unpublished.size;
      await this.publish(label, credential);
      if (this.unpublished.size < before) sent++;
    }
    return sent;
  }
}
