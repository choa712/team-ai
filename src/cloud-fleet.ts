import type { AccountPool } from './account-pool.js';
import { CloudClient, cloudIsNewer, type CloudAccount, type CloudCoordinator, type CloudLink } from './cloud-sync.js';
import { loadConfig, loadCredentials, upsertAccounts } from './storage.js';
import type { OAuthCredential } from './types.js';

const toCredential = (remote: CloudAccount, base?: OAuthCredential): OAuthCredential => ({
  accessToken: remote.accessToken ?? base?.accessToken ?? '',
  refreshToken: remote.refreshToken ?? base?.refreshToken ?? null,
  expiresAt: remote.expiresAt || base?.expiresAt || null,
  accountId: remote.accountUuid,
});

// Server-side periodic sync. Tokens only: accounts are added to or removed from
// this machine by an explicit `teamai cloud pull` or the dashboard, never by a
// timer, so an account the user dropped here does not come back on its own.
export async function syncFromCloud(cloud: CloudCoordinator, pool: AccountPool): Promise<{ adopted: number; published: number }> {
  const snapshot = await cloud.snapshot(true);
  let adopted = 0; let published = await cloud.retryUnpublished();
  for (const account of pool.accounts) {
    const remote = snapshot.get(account.id);
    if (remote && cloudIsNewer(remote, account.credential)) { account.credential = toCredential(remote, account.credential); account.error = null; adopted++; continue; }
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

// `teamai cloud pull`: bring the cloud's accounts onto this machine. New
// accounts are added; known ones take the cloud token only when it is newer
// (upsertAccounts keeps the later expiry), so a pull can never undo a rotation.
export async function pullAccounts(link: CloudLink, client = new CloudClient(link)): Promise<{ added: string[]; updated: string[]; unchanged: number; tokenless: number }> {
  const remote = await client.pull();
  const [config, credentials] = await Promise.all([loadConfig(), loadCredentials()]);
  const known = new Map(config.accounts.filter((a) => a.provider === 'claude').map((a) => [a.id, a]));
  const usable = remote.filter((r) => r.accessToken);
  const added: string[] = []; const updated: string[] = []; let unchanged = 0;
  const writes = usable.filter((r) => {
    const label = r.name || r.accountUuid; const existing = known.get(r.accountUuid);
    if (!existing) { added.push(label); return true; }
    const held = credentials[existing.credentialId];
    if (!held || cloudIsNewer(r, held)) { updated.push(label); return true; }
    unchanged++; return false;
  });
  if (writes.length) await upsertAccounts('claude', writes.map((r) => ({ label: r.name || r.accountUuid, credential: toCredential(r) })));
  return { added, updated, unchanged, tokenless: remote.length - usable.length };
}

// `teamai cloud push`: publish this machine's Claude accounts. The cloud keeps
// the later expiry per account, so pushing an older pair is a no-op there.
export async function pushAccounts(link: CloudLink, client = new CloudClient(link)): Promise<number> {
  const [config, credentials] = await Promise.all([loadConfig(), loadCredentials()]);
  const entries = config.accounts.filter((a) => a.provider === 'claude' && credentials[a.credentialId]).map((a) => ({ label: a.label, credential: credentials[a.credentialId]! }));
  await client.push(entries);
  return entries.length;
}
