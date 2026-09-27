import type { AccountPool } from './account-pool.js';
import { CloudClient, type CloudAccount, type CloudCoordinator, type CloudLink } from './cloud-sync.js';
import { loadConfig, loadCredentials, upsertAccounts } from './storage.js';
import type { OAuthCredential } from './types.js';

// The login stamp stays with the account: dropping it would make the older
// logged-in copy on disk look like a newer login and bring it back.
const toCredential = (remote: CloudAccount, base?: OAuthCredential): OAuthCredential => ({
  ...(base?.loggedInAt !== undefined ? { loggedInAt: base.loggedInAt } : {}),
  accessToken: remote.accessToken ?? base?.accessToken ?? '',
  refreshToken: remote.refreshToken ?? base?.refreshToken ?? null,
  expiresAt: remote.expiresAt || base?.expiresAt || null,
  accountId: remote.accountUuid,
});

// Server-side periodic sync. It recovers accounts whose refresh was refused
// (another machine rotated first) and republishes pairs the cloud lags behind.
// Working accounts keep their own chain, and accounts are never added or
// removed by a timer, so an account the user dropped here stays dropped.
export async function syncFromCloud(cloud: CloudCoordinator, pool: AccountPool): Promise<{ adopted: number; published: number }> {
  const snapshot = await cloud.snapshot(true);
  let adopted = 0; let published = await cloud.retryUnpublished();
  for (const account of pool.accounts) {
    const remote = snapshot.get(account.id);
    if (account.error !== null) {
      // The check is async: a refresh or re-login can land on the account while
      // it runs, and that credential must not be overwritten by the candidate.
      const before = account.credential;
      const verified = remote ? await cloud.adoptable(before, remote, 60_000) : null;
      if (verified && account.credential === before) { account.credential = verified; account.error = null; adopted++; }
      continue;
    }
    // The cloud lags a pair rotated here (a push lost to a restart, or rotated
    // before this machine was linked). Only accounts the cloud already has are
    // sent, so a local-only account is never published by a timer.
    if (remote && !cloud.unpublished.has(account.id) && account.credential.expiresAt !== null && account.credential.expiresAt > remote.expiresAt) {
      await cloud.publish(account.label, account.credential);
      if (!cloud.unpublished.has(account.id)) published++;
    }
  }
  return { adopted, published };
}

// `teamai cloud pull`: add the cloud's accounts this machine does not have yet.
// Known accounts keep their own token: the running relay recovers a refused one
// from the cloud by itself, and a copy must never replace a working chain or a
// fresh login here.
export async function pullAccounts(link: CloudLink, client = new CloudClient(link)): Promise<{ added: string[]; known: number; tokenless: number }> {
  const remote = await client.pull();
  const [config, credentials] = await Promise.all([loadConfig(), loadCredentials()]);
  const held = new Set(config.accounts.filter((a) => a.provider === 'claude' && credentials[a.credentialId]).map((a) => a.id));
  const usable = remote.filter((r) => r.accessToken);
  const fresh = usable.filter((r) => !held.has(r.accountUuid));
  // upsertAccounts re-reads the files and adds only, so an account logged in
  // while this ran keeps its credential (see its copy policy).
  if (fresh.length) await upsertAccounts('claude', fresh.map((r) => ({ label: r.name || r.accountUuid, credential: toCredential(r) })), 'add-only');
  return { added: fresh.map((r) => r.name || r.accountUuid), known: usable.length - fresh.length, tokenless: remote.length - usable.length };
}

// `teamai cloud push`: publish this machine's Claude accounts. The cloud keeps
// the later expiry per account, so pushing an older pair is a no-op there.
export async function pushAccounts(link: CloudLink, client = new CloudClient(link)): Promise<number> {
  const [config, credentials] = await Promise.all([loadConfig(), loadCredentials()]);
  const entries = config.accounts.filter((a) => a.provider === 'claude' && credentials[a.credentialId]).map((a) => ({ label: a.label, credential: credentials[a.credentialId]! }));
  await client.push(entries);
  return entries.length;
}
