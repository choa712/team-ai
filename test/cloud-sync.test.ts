import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountPool } from '../src/account-pool.js';
import { assertSecureUrl, CloudClient, CloudCoordinator, normalizeExpiry, type CloudAccount } from '../src/cloud-sync.js';
import { syncFromCloud } from '../src/cloud-fleet.js';
import type { OAuthCredential, Provider, StoredAccount } from '../src/types.js';

const NOW = 1_000_000_000_000;
const HOUR = 60 * 60_000;
const cred = (access: string, refresh: string, expiresAt: number, accountId = 'acc'): OAuthCredential => ({ accessToken: access, refreshToken: refresh, expiresAt, accountId });
const remote = (access: string | null, refresh: string | null, expiresAt: number, accountUuid = 'acc'): CloudAccount => ({ accountUuid, name: accountUuid, accessToken: access, refreshToken: refresh, expiresAt });

// A fake cloud holding one list; push applies freshest-token-wins like the real one.
function fakeCloud(initial: CloudAccount[], opts: { pullFails?: boolean; pushFails?: number } = {}) {
  let accounts = [...initial]; let pushFailures = opts.pushFails ?? 0; const pushes: OAuthCredential[] = []; let pulls = 0;
  return {
    pushes, get pulls() { return pulls; }, set(list: CloudAccount[]) { accounts = [...list]; },
    async pull() { pulls++; if (opts.pullFails) throw new Error('Cloud pull failed (503)'); return accounts.map((a) => ({ ...a })); },
    async push(list: Array<{ label: string; credential: OAuthCredential }>) {
      if (pushFailures > 0) { pushFailures--; throw new Error('Cloud push failed (503)'); }
      for (const { credential } of list) {
        pushes.push(credential);
        const held = accounts.find((a) => a.accountUuid === credential.accountId);
        if (!held) accounts.push(remote(credential.accessToken, credential.refreshToken, credential.expiresAt ?? 0, credential.accountId));
        else if ((credential.expiresAt ?? 0) > held.expiresAt) Object.assign(held, { accessToken: credential.accessToken, refreshToken: credential.refreshToken, expiresAt: credential.expiresAt ?? 0 });
      }
    },
  };
}
const refused = () => Promise.reject(new Error('OAuth refresh failed (400)'));
const settle = () => new Promise((r) => setImmediate(r));

test('adopts a newer token another machine published instead of rotating', async () => {
  const cloud = fakeCloud([remote('a2', 'r2', NOW + 8 * HOUR)]);
  const coordinator = new CloudCoordinator(cloud, () => {}, 20_000, () => NOW);
  let rotations = 0;
  const next = await coordinator.refresh('acc', cred('a1', 'r1', NOW + 60_000), async (c) => { rotations++; return c; });
  assert.equal(rotations, 0);
  assert.deepEqual([next.accessToken, next.refreshToken, next.expiresAt], ['a2', 'r2', NOW + 8 * HOUR]);
  assert.equal(cloud.pushes.length, 0);
});

test('rotates when the cloud is not newer and publishes the new pair', async () => {
  const cloud = fakeCloud([remote('a1', 'r1', NOW + 60_000)]);
  const coordinator = new CloudCoordinator(cloud, () => {}, 20_000, () => NOW);
  const next = await coordinator.refresh('acc', cred('a1', 'r1', NOW + 60_000), async (c) => ({ ...c, accessToken: 'a2', refreshToken: 'r2', expiresAt: NOW + 8 * HOUR }));
  assert.equal(next.refreshToken, 'r2');
  await settle();
  assert.equal(cloud.pushes.at(-1)?.refreshToken, 'r2');
});

test('continues from the cloud chain when its access token lapsed but its refresh token is newer', async () => {
  const cloud = fakeCloud([remote('a2', 'r2', NOW + 60_000)]);
  const coordinator = new CloudCoordinator(cloud, () => {}, 20_000, () => NOW);
  let used = '';
  await coordinator.refresh('acc', cred('a1', 'r1', NOW - HOUR), async (c) => { used = c.refreshToken!; return { ...c, accessToken: 'a3', refreshToken: 'r3', expiresAt: NOW + 8 * HOUR }; });
  assert.equal(used, 'r2', 'must rotate the chain the cloud holds, not the spent local one');
});

test('a refused refresh recovers from the pair the winner published', async () => {
  const cloud = fakeCloud([remote('a1', 'r1', NOW - HOUR)]);
  const coordinator = new CloudCoordinator(cloud, () => {}, 20_000, () => NOW);
  const next = await coordinator.refresh('acc', cred('a1', 'r1', NOW - HOUR), async () => {
    // Another machine rotates and publishes while this refresh is in flight.
    cloud.set([remote('a2', 'r2', NOW + 8 * HOUR)]);
    return refused();
  });
  assert.deepEqual([next.accessToken, next.refreshToken], ['a2', 'r2']);
});

test('a refused refresh with nothing newer in the cloud still fails', async () => {
  const cloud = fakeCloud([remote('a1', 'r1', NOW - HOUR)]);
  const coordinator = new CloudCoordinator(cloud, () => {}, 20_000, () => NOW);
  await assert.rejects(coordinator.refresh('acc', cred('a1', 'r1', NOW - HOUR), refused), /OAuth refresh failed \(400\)/);
});

test('transport errors are not treated as a moved chain', async () => {
  const cloud = fakeCloud([remote('a2', 'r2', NOW - 1)]);
  const coordinator = new CloudCoordinator(cloud, () => {}, 20_000, () => NOW);
  const before = cloud.pulls;
  await assert.rejects(coordinator.refresh('acc', cred('a1', 'r1', NOW - HOUR), () => Promise.reject(new Error('OAuth refresh failed (503)'))), /503/);
  assert.equal(cloud.pulls - before, 1, 'only the pre-refresh read, no recovery pull');
});

test('an unreachable cloud never blocks a local refresh, and the pair is published later', async () => {
  const cloud = fakeCloud([remote('a1', 'r1', NOW)], { pushFails: 1 });
  const logs: string[] = [];
  const coordinator = new CloudCoordinator(cloud, (m) => logs.push(m), 20_000, () => NOW);
  const next = await coordinator.refresh('acc', cred('a1', 'r1', NOW), async (c) => ({ ...c, refreshToken: 'r2', expiresAt: NOW + 8 * HOUR }));
  assert.equal(next.refreshToken, 'r2');
  await settle();
  assert.equal(coordinator.unpublished.size, 1);
  assert.ok(logs.some((m) => m.includes('deferred')));
  assert.equal(await coordinator.retryUnpublished(), 1);
  assert.equal(coordinator.unpublished.size, 0);
  const down = new CloudCoordinator(fakeCloud([], { pullFails: true }), () => {}, 20_000, () => NOW);
  assert.equal((await down.refresh('acc', cred('a1', 'r1', NOW), async (c) => ({ ...c, refreshToken: 'r9' }))).refreshToken, 'r9');
});

const provider: Provider = {
  id: 'claude', label: 'Claude', upstreamBase: 'https://example.test', normalizePath: (p) => p,
  buildHeaders: (h) => h, rewriteBody: (b) => b, readQuota: () => null,
  classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }), refresh: async (c) => ({ ...c, refreshToken: 'local' }),
};
const stored = (id: string): StoredAccount => ({ id, provider: 'claude', label: id, enabled: true, priority: null, credentialId: `claude:${id}`, createdAt: new Date().toISOString() });

test('the pool routes refreshes through the hook when one is set', async () => {
  const pool = new AccountPool(provider, [stored('acc')], { 'claude:acc': cred('a1', 'r1', 0) }, { version: 1, accounts: {} });
  pool.refreshVia = async (account, rotate) => ({ ...(await rotate(account.credential)), accessToken: 'via-hook' });
  await pool.refresh(pool.accounts[0]!, true);
  assert.deepEqual([pool.accounts[0]!.credential.accessToken, pool.accounts[0]!.credential.refreshToken], ['via-hook', 'local']);
});

test('periodic sync adopts newer tokens, heals the account, and republishes only known accounts', async () => {
  const later = Date.now() + 8 * HOUR;
  const pool = new AccountPool(provider, [stored('dead'), stored('ahead'), stored('local-only')], {
    'claude:dead': cred('d1', 'dr1', Date.now() - HOUR, 'dead'),
    'claude:ahead': cred('h2', 'hr2', later, 'ahead'),
    'claude:local-only': cred('l1', 'lr1', later, 'local-only'),
  }, { version: 1, accounts: {} });
  pool.accounts[0]!.error = 'token refresh failed: OAuth refresh failed (400)';
  const cloud = fakeCloud([remote('d2', 'dr2', later, 'dead'), remote('h1', 'hr1', Date.now(), 'ahead')]);
  const result = await syncFromCloud(new CloudCoordinator(cloud), pool);
  assert.deepEqual(result, { adopted: 1, published: 1 });
  assert.equal(pool.accounts[0]!.credential.refreshToken, 'dr2');
  assert.equal(pool.accounts[0]!.error, null);
  assert.deepEqual(cloud.pushes.map((c) => c.accountId), ['ahead']);
});

test('the cloud client parses pulls, sends the key only as a header, and refuses plain http', async () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string; redirect: string }> = [];
  const client = new CloudClient({ url: 'https://cloud.example', key: 'k-secret' }, async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body, redirect: init.redirect });
    return { ok: true, status: 200, json: async () => ({ accounts: [{ accountUuid: 'u1', name: 'one', accessToken: 'a', refreshToken: 'r', expiresAt: 1_700_000_000 }, { name: 'no-uuid' }] }) };
  });
  const list = await client.pull();
  assert.deepEqual(list, [{ accountUuid: 'u1', name: 'one', accessToken: 'a', refreshToken: 'r', expiresAt: 1_700_000_000_000 }]);
  assert.equal(calls[0]!.url, 'https://cloud.example/functions/v1/cloud/sync/pull');
  assert.equal(calls[0]!.headers['x-teamclaude-key'], 'k-secret');
  assert.equal(calls[0]!.url.includes('k-secret'), false);
  assert.equal(calls[0]!.redirect, 'error');
  await client.push([{ label: 'one', credential: cred('a', 'r', 1, 'u1') }]);
  assert.equal(calls[1]!.redirect, 'error');
  assert.equal(calls[1]!.headers['x-teamclaude-key'], 'k-secret');
  assert.throws(() => assertSecureUrl('http://cloud.example'), /Refusing/);
  assert.doesNotThrow(() => assertSecureUrl('http://127.0.0.1:9999'));
  assert.equal(normalizeExpiry('x'), 0);
});

test('an import never replaces a newer credential with an older copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-cloud-')); process.env.TEAMAI_HOME = root;
  try {
    const storage = await import(`../src/storage.js?cloud=${Date.now()}`);
    await storage.upsertAccount('claude', 'acc', cred('new', 'r-new', NOW + HOUR));
    await storage.upsertAccounts('claude', [{ label: 'acc', credential: cred('old', 'r-old', NOW) }]);
    assert.equal((await storage.loadCredentials())['claude:acc'].refreshToken, 'r-new');
    await storage.upsertAccount('claude', 'acc', cred('newer', 'r-newer', NOW + 2 * HOUR));
    assert.equal((await storage.loadCredentials())['claude:acc'].refreshToken, 'r-newer');
    // A login is explicit and replaces even a credential with a later expiry.
    await storage.upsertAccount('claude', 'acc', cred('relogin', 'r-relogin', NOW));
    assert.equal((await storage.loadCredentials())['claude:acc'].refreshToken, 'r-relogin');
    await storage.upsertAccounts('claude', [{ label: 'acc', credential: cred('stale', 'r-stale', NOW - HOUR) }]);
    assert.equal((await storage.loadCredentials())['claude:acc'].refreshToken, 'r-relogin');
    const cloudSync = await import(`../src/cloud-sync.js?cloud=${Date.now()}`);
    await cloudSync.saveCloudLink({ url: 'https://cloud.example', key: 'k' });
    assert.equal((await stat(join(root, 'cloud.json'))).mode & 0o777, 0o600);
    assert.deepEqual(await cloudSync.loadCloudLink(), { url: 'https://cloud.example', key: 'k' });
  } finally { delete process.env.TEAMAI_HOME; }
});

test('an errored account adopts a re-login even when its dead token expires later', () => {
  const pool = new AccountPool(provider, [stored('acc')], { 'claude:acc': cred('dead', 'r-dead', NOW + 8 * HOUR) }, { version: 1, accounts: {} });
  assert.equal(pool.adoptCredentials({ 'claude:acc': cred('fresh', 'r-fresh', NOW + HOUR) }), 0, 'a healthy account keeps its later token');
  pool.accounts[0]!.error = 'token refresh failed: OAuth refresh failed (400)';
  assert.equal(pool.adoptCredentials({ 'claude:acc': cred('fresh', 'r-fresh', NOW + HOUR) }), 1);
  assert.equal(pool.accounts[0]!.credential.refreshToken, 'r-fresh');
  assert.equal(pool.accounts[0]!.error, null);
});

test('a running server adopts an explicit re-login even over a healthy token with a later expiry', () => {
  const pool = new AccountPool(provider, [stored('acc')], { 'claude:acc': { ...cred('old', 'r-old', NOW + 8 * HOUR), loggedInAt: 1 } }, { version: 1, accounts: {} });
  assert.equal(pool.adoptCredentials({ 'claude:acc': cred('copy', 'r-copy', NOW + HOUR) }), 0, 'a plain copy with an earlier expiry is ignored');
  assert.equal(pool.adoptCredentials({ 'claude:acc': { ...cred('login', 'r-login', NOW + HOUR), loggedInAt: 2 } }), 1);
  assert.equal(pool.accounts[0]!.credential.refreshToken, 'r-login');
  assert.equal(pool.adoptCredentials({ 'claude:acc': { ...cred('login', 'r-login', NOW + HOUR), loggedInAt: 2 } }), 0, 'no churn once adopted');
});

test('adopting a cloud token keeps the login stamp, so the older logged-in copy on disk is not brought back', async () => {
  const later = Date.now() + 8 * HOUR;
  const onDisk = { ...cred('login', 'r-login', Date.now() - HOUR), loggedInAt: 5 };
  const pool = new AccountPool(provider, [stored('acc')], { 'claude:acc': onDisk }, { version: 1, accounts: {} });
  await syncFromCloud(new CloudCoordinator(fakeCloud([remote('c2', 'rc2', later)])), pool);
  assert.equal(pool.accounts[0]!.credential.refreshToken, 'rc2');
  assert.equal(pool.accounts[0]!.credential.loggedInAt, 5);
  assert.equal(pool.adoptCredentials({ 'claude:acc': onDisk }), 0);
});

test('a revoked cloud token with a later expiry is never adopted over a fresh local login', async () => {
  const cloud = fakeCloud([remote('revoked', 'r-revoked', NOW + 8 * HOUR)]);
  const verify = async (c: OAuthCredential) => c.accessToken !== 'revoked';
  const coordinator = new CloudCoordinator(cloud, () => {}, 20_000, () => NOW, verify);
  const login = { ...cred('login', 'r-login', NOW + 60_000), loggedInAt: 9 };
  const rotated: string[] = [];
  const next = await coordinator.refresh('acc', login, async (c) => { rotated.push(c.refreshToken!); if (c.refreshToken === 'r-revoked') return refused(); return { ...c, accessToken: 'a2', refreshToken: 'r2', expiresAt: NOW + 8 * HOUR }; });
  assert.equal(next.refreshToken, 'r2');
  assert.deepEqual(rotated, ['r-revoked', 'r-login'], 'the dead cloud chain is tried, then our own');
  assert.equal(next.loggedInAt, 9);

  const pool = new AccountPool(provider, [stored('acc')], { 'claude:acc': { ...cred('login', 'r-login', Date.now() + HOUR), loggedInAt: 9 } }, { version: 1, accounts: {} });
  const result = await syncFromCloud(new CloudCoordinator(fakeCloud([remote('revoked', 'r-revoked', Date.now() + 2 * HOUR)]), () => {}, 20_000, Date.now, verify), pool);
  assert.equal(result.adopted, 0);
  assert.equal(pool.accounts[0]!.credential.refreshToken, 'r-login');
});

test('periodic sync does not overwrite a credential that changed while the cloud token was being verified', async () => {
  const later = Date.now() + 8 * HOUR;
  const pool = new AccountPool(provider, [stored('acc')], { 'claude:acc': cred('old', 'r-old', Date.now() - HOUR) }, { version: 1, accounts: {} });
  const verify = async () => { pool.accounts[0]!.credential = cred('rotated', 'r-rotated', later + HOUR); return true; };
  const result = await syncFromCloud(new CloudCoordinator(fakeCloud([remote('c', 'r-cloud', later)]), () => {}, 20_000, Date.now, verify), pool);
  assert.equal(result.adopted, 0);
  assert.equal(pool.accounts[0]!.credential.refreshToken, 'r-rotated');
});

test('a manual pull replaces a local token only with one that passes verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-pull-')); process.env.TEAMAI_HOME = root;
  try {
    const storage = await import(`../src/storage.js?pull=${Date.now()}`);
    const fleet = await import(`../src/cloud-fleet.js?pull=${Date.now()}`);
    await storage.upsertAccount('claude', 'acc', cred('login', 'r-login', NOW + HOUR));
    const client = fakeCloud([remote('revoked', 'r-revoked', NOW + 2 * HOUR), remote('new', 'r-new', NOW + HOUR, 'fresh')]);
    const result = await fleet.pullAccounts({ url: 'https://cloud.example', key: 'k' }, client, async (c: OAuthCredential) => c.accessToken !== 'revoked');
    assert.deepEqual([result.added, result.updated, result.unchanged], [['fresh'], [], 1]);
    assert.equal((await storage.loadCredentials())['claude:acc'].refreshToken, 'r-login');
  } finally { delete process.env.TEAMAI_HOME; }
});
