import type { AccountPool } from './account-pool.js';
import { CloudClient, cloudIsNewer, type CloudAccount, type CloudCoordinator, type CloudLink } from './cloud-sync.js';
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

// Server-side periodic sync. Tokens only: accounts are added to or removed from
// this machine by an explicit `teamai cloud pull` or the dashboard, never by a
// timer, so an account the user dropped here does not come back on its own.
export async function syncFromCloud(cloud: CloudCoordinator, pool: AccountPool): Promise<{ adopted: number; published: number }> {
  const snapshot = await cloud.snapshot(true);
  let adopted = 0; let published = await cloud.retryUnpublished();
  for (const account of pool.accounts) {
    const remote = snapshot.get(account.id);
    // Adoption is verified upstream (see CloudCoordinator.verify): a newer expiry
    // alone could be a revoked token that would undo a fresh login here.
    // The check is async: a refresh or re-login can land on the account while it
    // runs, and that newer credential must not be overwritten by the candidate.
    const before = account.credential;
    const verified = remote ? await cloud.adoptable(before, remote, 60_000) : null;
    if (verified && account.credential === before) { account.credential = verified; account.error = null; adopted++; continue; }
    if (account.credential !== before) continue;
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
export async function pullAccounts(link: CloudLink, client = new CloudClient(link), verify: (credential: OAuthCredential) => Promise<boolean> = async () => true): Promise<{ added: string[]; updated: string[]; unchanged: number; tokenless: number }> {
  const remote = await client.pull();
  const [config, credentials] = await Promise.all([loadConfig(), loadCredentials()]);
  const known = new Map(config.accounts.filter((a) => a.provider === 'claude').map((a) => [a.id, a]));
  const usable = remote.filter((r) => r.accessToken);
  const added: string[] = []; const updated: string[] = []; let unchanged = 0;
  const writes: Array<{ label: string; credential: OAuthCredential }> = [];
  for (const r of usable) {
    const label = r.name || r.accountUuid; const existing = known.get(r.accountUuid);
    const held = existing ? credentials[existing.credentialId] : undefined;
    if (!held) { (existing ? updated : added).push(label); writes.push({ label, credential: toCredential(r) }); continue; }
    // Replacing a local token needs proof the cloud one is alive: a revoked copy
    // keeps its later expiry and would undo a fresh login here.
    const candidate = cloudIsNewer(r, held) ? toCredential(r, held) : null;
    if (candidate && await verify(candidate).catch(() => false)) { updated.push(label); writes.push({ label, credential: candidate }); continue; }
    unchanged++;
  }
  if (writes.length) await upsertAccounts('claude', writes);
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
