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
const settle = () => new Promise((resolve) => setImmediate(resolve));
const refused = (): Promise<never> => Promise.reject(new Error('OAuth refresh failed (400)'));

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
const rotateTo = (access: string, refresh: string) => async (c: OAuthCredential) => ({ ...c, accessToken: access, refreshToken: refresh, expiresAt: NOW + 8 * HOUR });

test('a refresh rotates this machine\'s own chain and publishes it, even when the cloud holds a newer token', async () => {
  const cloud = fakeCloud([remote('elsewhere', 'r-elsewhere', NOW + 8 * HOUR)]);
  const coordinator = new CloudCoordinator(cloud, () => {}, 20_000, () => NOW);
  const used: string[] = [];
  const next = await coordinator.refresh('acc', cred('a1', 'r1', NOW), async (c) => { used.push(c.refreshToken!); return rotateTo('a2', 'r2')(c); });
  assert.deepEqual(used, ['r1']);
  assert.equal(next.refreshToken, 'r2');
  await settle();
  assert.equal(cloud.pushes.at(-1)?.refreshToken, 'r2');
  assert.equal(cloud.pulls, 0, 'a successful rotation never reads the cloud');
});

test('a refused refresh recovers from the live token another machine published', async () => {
  const cloud = fakeCloud([remote('a2', 'r2', NOW + 8 * HOUR)]);
  const coordinator = new CloudCoordinator(cloud, () => {}, 20_000, () => NOW);
  const login = { ...cred('a1', 'r1', NOW), loggedInAt: 7 };
  const next = await coordinator.refresh('acc', login, refused);
  assert.deepEqual([next.accessToken, next.refreshToken, next.loggedInAt], ['a2', 'r2', 7]);
});

test('a refused refresh continues the published chain when its access token lapsed', async () => {
  const cloud = fakeCloud([remote('a2', 'r2', NOW - 1)]);
  const coordinator = new CloudCoordinator(cloud, () => {}, 20_000, () => NOW);
  const used: string[] = [];
  const next = await coordinator.refresh('acc', cred('a1', 'r1', NOW), async (c) => { used.push(c.refreshToken!); return c.refreshToken === 'r1' ? refused() : rotateTo('a3', 'r3')(c); });
  assert.deepEqual(used, ['r1', 'r2']);
  assert.equal(next.refreshToken, 'r3');
});

test('a refused refresh does not adopt a cloud token that fails the upstream check', async () => {
  const cloud = fakeCloud([remote('revoked', 'r-revoked', NOW + 8 * HOUR)]);
  const coordinator = new CloudCoordinator(cloud, () => {}, 20_000, () => NOW, async (c) => c.accessToken !== 'revoked');
  const used: string[] = [];
  await assert.rejects(coordinator.refresh('acc', cred('a1', 'r1', NOW), async (c) => { used.push(c.refreshToken!); return refused(); }), /400/);
  assert.deepEqual(used, ['r1', 'r-revoked'], 'its chain is tried, and refused too');
});

test('a refused refresh with nothing different in the cloud still fails', async () => {
  const coordinator = new CloudCoordinator(fakeCloud([remote('a1', 'r1', NOW + HOUR)]), () => {}, 20_000, () => NOW);
  await assert.rejects(coordinator.refresh('acc', cred('a1', 'r1', NOW), refused), /OAuth refresh failed \(400\)/);
});

test('transport errors are not treated as a moved chain', async () => {
  const cloud = fakeCloud([remote('a2', 'r2', NOW + HOUR)]);
  const coordinator = new CloudCoordinator(cloud, () => {}, 20_000, () => NOW);
  await assert.rejects(coordinator.refresh('acc', cred('a1', 'r1', NOW), () => Promise.reject(new Error('OAuth refresh failed (503)'))), /503/);
  assert.equal(cloud.pulls, 0);
});

test('an unreachable cloud never blocks a refresh, and a failed push is resent later', async () => {
  const cloud = fakeCloud([remote('a1', 'r1', NOW)], { pushFails: 1 });
  const logs: string[] = [];
  const coordinator = new CloudCoordinator(cloud, (m) => logs.push(m), 20_000, () => NOW);
  const next = await coordinator.refresh('acc', cred('a1', 'r1', NOW), rotateTo('a2', 'r2'));
  assert.equal(next.refreshToken, 'r2');
  await settle();
  assert.equal(coordinator.unpublished.size, 1);
  assert.ok(logs.some((m) => m.includes('deferred')));
  assert.equal(await coordinator.retryUnpublished(), 1);
  assert.equal(coordinator.unpublished.size, 0);
  const down = new CloudCoordinator(fakeCloud([], { pullFails: true }), () => {}, 20_000, () => NOW);
  await assert.rejects(down.refresh('acc', cred('a1', 'r1', NOW), refused), /400/);
});

const provider: Provider = {
  id: 'claude', label: 'Claude', upstreamBase: 'https://example.test', normalizePath: (p) => p,
  buildHeaders: (h) => h, rewriteBody: (b) => b, readQuota: () => null,
  classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }), refresh: async (c) => ({ ...c, refreshToken: 'local' }),
};
const stored = (id: string): StoredAccount => ({ id, provider: 'claude', label: id, enabled: true, priority: null, credentialId: `claude:${id}`, createdAt: new Date().toISOString() });
const poolOf = (credentials: Record<string, OAuthCredential>) => new AccountPool(provider, Object.keys(credentials).map(stored), Object.fromEntries(Object.entries(credentials).map(([id, c]) => [`claude:${id}`, c])), { version: 1, accounts: {} });

test('the pool routes refreshes through the hook, and a result never lands on a credential that changed meanwhile', async () => {
  const pool = poolOf({ acc: cred('a1', 'r1', 0) });
  pool.refreshVia = async (account, rotate) => ({ ...(await rotate(account.credential)), accessToken: 'via-hook' });
  await pool.refresh(pool.accounts[0]!, true);
  assert.deepEqual([pool.accounts[0]!.credential.accessToken, pool.accounts[0]!.credential.refreshToken], ['via-hook', 'local']);
  const racing = poolOf({ acc: cred('a1', 'r1', 0) });
  racing.refreshVia = async (account) => { const started = account.credential; racing.accounts[0]!.credential = cred('synced', 'r-synced', NOW); return { ...started, refreshToken: 'stale-result' }; };
  await racing.refresh(racing.accounts[0]!, true);
  assert.equal(racing.accounts[0]!.credential.refreshToken, 'r-synced');
});

test('periodic sync recovers refused accounts only, and republishes pairs the cloud lags', async () => {
  const later = Date.now() + 8 * HOUR;
  const pool = poolOf({
    dead: cred('d1', 'dr1', Date.now() - HOUR, 'dead'),
    working: cred('w1', 'wr1', Date.now() + HOUR, 'working'),
    ahead: cred('h2', 'hr2', later, 'ahead'),
    'local-only': cred('l1', 'lr1', later, 'local-only'),
  });
  pool.accounts[0]!.error = 'token refresh failed: OAuth refresh failed (400)';
  const cloud = fakeCloud([remote('d2', 'dr2', later, 'dead'), remote('w2', 'wr2', later, 'working'), remote('h1', 'hr1', Date.now(), 'ahead')]);
  const result = await syncFromCloud(new CloudCoordinator(cloud), pool);
  assert.deepEqual(result, { adopted: 1, published: 1 });
  assert.equal(pool.accounts[0]!.credential.refreshToken, 'dr2');
  assert.equal(pool.accounts[0]!.error, null);
  assert.equal(pool.accounts[1]!.credential.refreshToken, 'wr1', 'a working chain is never replaced');
  assert.deepEqual(cloud.pushes.map((c) => c.accountId), ['ahead']);
});

test('periodic sync leaves an account alone if its credential changed during the upstream check', async () => {
  const pool = poolOf({ acc: cred('old', 'r-old', Date.now() - HOUR) });
  pool.accounts[0]!.error = 'token refresh failed: OAuth refresh failed (400)';
  const verify = async () => { pool.accounts[0]!.credential = cred('login', 'r-login', Date.now() + HOUR); return true; };
  const result = await syncFromCloud(new CloudCoordinator(fakeCloud([remote('c', 'r-cloud', Date.now() + 8 * HOUR)]), () => {}, 20_000, Date.now, verify), pool);
  assert.equal(result.adopted, 0);
  assert.equal(pool.accounts[0]!.credential.refreshToken, 'r-login');
});

test('a running server adopts an explicit re-login even over a healthy token with a later expiry', () => {
  const pool = poolOf({ acc: { ...cred('old', 'r-old', NOW + 8 * HOUR), loggedInAt: 1 } });
  assert.equal(pool.adoptCredentials({ 'claude:acc': cred('copy', 'r-copy', NOW + HOUR) }), 0, 'a plain copy with an earlier expiry is ignored');
  assert.equal(pool.adoptCredentials({ 'claude:acc': { ...cred('login', 'r-login', NOW + HOUR), loggedInAt: 2 } }), 1);
  assert.equal(pool.accounts[0]!.credential.refreshToken, 'r-login');
  assert.equal(pool.adoptCredentials({ 'claude:acc': { ...cred('login', 'r-login', NOW + HOUR), loggedInAt: 2 } }), 0, 'no churn once adopted');
});

test('an errored account adopts a re-login even when its dead token expires later', () => {
  const pool = poolOf({ acc: cred('dead', 'r-dead', NOW + 8 * HOUR) });
  assert.equal(pool.adoptCredentials({ 'claude:acc': cred('fresh', 'r-fresh', NOW + 9 * HOUR) }), 0, 'a healthy account ignores an unstamped copy, even a later one');
  pool.accounts[0]!.error = 'token refresh failed: OAuth refresh failed (400)';
  assert.equal(pool.adoptCredentials({ 'claude:acc': cred('copy', 'r-copy', NOW + HOUR) }), 0, 'an unstamped older copy is not a re-login');
  assert.equal(pool.adoptCredentials({ 'claude:acc': { ...cred('fresh', 'r-fresh', NOW + HOUR), loggedInAt: 3 } }), 1);
  assert.equal(pool.accounts[0]!.error, null);
});

test('the cloud client parses pulls, sends the key only as a header, refuses redirects and plain http', async () => {
  const calls: Array<{ url: string; headers: Record<string, string>; redirect: string }> = [];
  const client = new CloudClient({ url: 'https://cloud.example', key: 'k-secret' }, async (url, init) => {
    calls.push({ url, headers: init.headers, redirect: init.redirect });
    return { ok: true, status: 200, json: async () => ({ accounts: [{ accountUuid: 'u1', name: 'one', accessToken: 'a', refreshToken: 'r', expiresAt: 1_700_000_000 }, { name: 'no-uuid' }] }) };
  });
  assert.deepEqual(await client.pull(), [{ accountUuid: 'u1', name: 'one', accessToken: 'a', refreshToken: 'r', expiresAt: 1_700_000_000_000 }]);
  await client.push([{ label: 'one', credential: cred('a', 'r', 1, 'u1') }]);
  assert.equal(calls[0]!.url, 'https://cloud.example/functions/v1/cloud/sync/pull');
  for (const call of calls) { assert.equal(call.headers['x-teamclaude-key'], 'k-secret'); assert.equal(call.redirect, 'error'); assert.equal(call.url.includes('k-secret'), false); }
  assert.throws(() => assertSecureUrl('http://cloud.example'), /Refusing/);
  assert.doesNotThrow(() => assertSecureUrl('http://127.0.0.1:9999'));
  assert.equal(normalizeExpiry('x'), 0);
});

test('stored credentials: a login always wins, a copy never beats a login, a pull only adds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-cloud-')); process.env.TEAMAI_HOME = root;
  try {
    const storage = await import(`../src/storage.js?cloud=${Date.now()}`);
    const fleet = await import(`../src/cloud-fleet.js?cloud=${Date.now()}`);
    const cloudSync = await import(`../src/cloud-sync.js?cloud=${Date.now()}`);
    const token = async () => (await storage.loadCredentials())['claude:acc'].refreshToken;
    await storage.upsertAccounts('claude', [{ label: 'acc', credential: cred('new', 'r-new', NOW + HOUR) }]);
    await storage.upsertAccounts('claude', [{ label: 'acc', credential: cred('old', 'r-old', NOW) }]);
    assert.equal(await token(), 'r-new', 'an older copy loses');
    await storage.upsertAccount('claude', 'acc', cred('login', 'r-login', NOW));
    assert.equal(await token(), 'r-login', 'a login wins over a later expiry');
    await storage.upsertAccounts('claude', [{ label: 'acc', credential: cred('copy', 'r-copy', NOW + 9 * HOUR) }]);
    assert.equal(await token(), 'r-login', 'a copy never replaces a login');
    const result = await fleet.pullAccounts({ url: 'https://cloud.example', key: 'k' }, fakeCloud([remote('cloud', 'r-cloud', NOW + 9 * HOUR), remote('n', 'r-n', NOW, 'fresh')]));
    assert.deepEqual([result.added, result.known], [['fresh'], 1]);
    assert.equal(await token(), 'r-login', 'a pull never touches a held account');
    await cloudSync.saveCloudLink({ url: 'https://cloud.example', key: 'k' });
    assert.equal((await stat(join(root, 'cloud.json'))).mode & 0o777, 0o600);
    assert.deepEqual(await cloudSync.loadCloudLink(), { url: 'https://cloud.example', key: 'k' });
  } finally { delete process.env.TEAMAI_HOME; }
});

test('periodic sync replaces only chains that were refused, and a recovery survives the next save', async () => {
  const later = Date.now() + 8 * HOUR;
  const pool = poolOf({ refused: cred('r1', 'rr1', later + HOUR, 'refused'), flaky: cred('f1', 'fr1', Date.now() + HOUR, 'flaky') });
  pool.accounts[0]!.error = 'token refresh failed: OAuth refresh failed (400)';
  pool.accounts[1]!.error = 'token refresh failed: OAuth refresh failed (503)';
  const cloud = fakeCloud([remote('r2', 'rr2', Date.now() + HOUR, 'refused'), remote('f2', 'fr2', later, 'flaky')]);
  const result = await syncFromCloud(new CloudCoordinator(cloud), pool);
  assert.equal(result.adopted, 1);
  assert.equal(pool.accounts[0]!.credential.refreshToken, 'rr2');
  assert.equal(pool.accounts[1]!.credential.refreshToken, 'fr1', 'a transient failure keeps its own chain');
  // The dead chain on disk expires later than the recovered one; the next save must not bring it back.
  assert.equal(pool.adoptCredentials({ 'claude:refused': cred('r1', 'rr1', later + HOUR, 'refused') }), 0);
  assert.equal(pool.accounts[0]!.credential.refreshToken, 'rr2');
});

test('a failing account never restores an older chain from disk', () => {
  const pool = poolOf({ acc: cred('a2', 'r2', NOW + 8 * HOUR) });
  pool.accounts[0]!.error = 'token refresh failed: OAuth refresh failed (503)';
  assert.equal(pool.adoptCredentials({ 'claude:acc': cred('a1', 'r1', NOW) }), 0);
  assert.equal(pool.accounts[0]!.credential.refreshToken, 'r2');
});
