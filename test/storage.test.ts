import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('stores credentials separately with restrictive permissions and deduplicates accounts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-storage-')); process.env.TEAMAI_HOME = root;
  const storage = await import(`../src/storage.js?test=${Date.now()}`);
  const credential = { accessToken: 'secret', refreshToken: 'refresh', expiresAt: 123, accountId: 'same' };
  await storage.upsertAccount('codex', 'first', credential); await storage.upsertAccount('codex', 'renamed', { ...credential, accessToken: 'new-secret' });
  const config = await storage.loadConfig(); assert.equal(config.accounts.length, 1); assert.equal(config.accounts[0]?.label, 'renamed');
  assert.equal((await readFile(storage.paths().config, 'utf8')).includes('new-secret'), false);
  assert.equal((await stat(storage.paths().credentials)).mode & 0o777, 0o600);
  await storage.upsertAccounts('codex', [
    { label: 'renamed-again', credential: { ...credential, accessToken: 'third-secret' } },
    { label: 'second', credential: { ...credential, accessToken: 'second-secret', accountId: 'second' } },
  ]);
  const bulk = await storage.loadConfig(); assert.equal(bulk.accounts.length, 2); assert.equal(bulk.accounts[0]?.label, 'renamed-again');
  delete process.env.TEAMAI_HOME;
});

// A Codex account imported from codex-multi-auth is keyed by its workspace id,
// while `teamai login codex` keys the same account by the token's
// chatgpt_account_id. Both tokens carry that claim, so it is what names the account.
test('a Codex login for an account imported under another id refreshes that account instead of adding a second one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-codex-identity-')); process.env.TEAMAI_HOME = root;
  const storage = await import(`../src/storage.js?codex-identity=${Date.now()}`);
  const jwt = (claims: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  const tokenFor = (account: string, n: number): string => jwt({ n, 'https://api.openai.com/auth': { chatgpt_account_id: account } });
  await storage.upsertAccounts('codex', [{ label: 'one@example.com', credential: { accessToken: tokenFor('acct-one', 1), refreshToken: 'spent', expiresAt: 100, accountId: 'org-imported' } }]);

  const account = await storage.upsertAccount('codex', 'one@example.com', { accessToken: tokenFor('acct-one', 2), refreshToken: 'fresh', expiresAt: 200, accountId: 'acct-one' });
  await storage.upsertAccount('codex', 'other@example.com', { accessToken: tokenFor('acct-other', 1), refreshToken: 'other', expiresAt: 300, accountId: 'acct-other' });

  const config = await storage.loadConfig();
  assert.deepEqual(config.accounts.map((a: { label: string }) => a.label), ['one@example.com', 'other@example.com']);
  assert.equal(account.credentialId, 'codex:org-imported');
  const credentials = await storage.loadCredentials();
  assert.equal(credentials['codex:org-imported'].refreshToken, 'fresh');
  assert.equal(credentials['codex:org-imported'].accountId, 'acct-one');
  assert.equal(typeof credentials['codex:org-imported'].loggedInAt, 'number');
  delete process.env.TEAMAI_HOME;
});

test('workspaces that share one Codex token stay separate entries, on import and on login', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-codex-workspaces-')); process.env.TEAMAI_HOME = root;
  const storage = await import(`../src/storage.js?codex-workspaces=${Date.now()}`);
  const shared = `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-one' } })).toString('base64url')}.s`;
  const team = '0b0b0b0b-0000-4000-8000-000000000001';
  await storage.upsertAccounts('codex', [
    { label: 'one@example.com', credential: { accessToken: shared, refreshToken: 'r1', expiresAt: 100, accountId: 'org-personal' } },
    { label: 'one@example.com', credential: { accessToken: shared, refreshToken: 'r2', expiresAt: 100, accountId: team } },
  ]);
  assert.deepEqual((await storage.loadConfig()).accounts.map((a: { id: string }) => a.id), ['org-personal', team]);

  // The team entry names its workspace, so the login renews the personal one only.
  await storage.upsertAccount('codex', 'one@example.com', { accessToken: shared, refreshToken: 'fresh', expiresAt: 200, accountId: 'acct-one' });
  assert.deepEqual((await storage.loadConfig()).accounts.map((a: { id: string }) => a.id), ['org-personal', team]);
  const credentials = await storage.loadCredentials();
  assert.equal(credentials['codex:org-personal'].refreshToken, 'fresh');
  assert.equal(credentials[`codex:${team}`].refreshToken, 'r2');
  delete process.env.TEAMAI_HOME;
});

test('a Codex login adds an entry when more than one imported entry carries its claim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-codex-ambiguous-')); process.env.TEAMAI_HOME = root;
  const storage = await import(`../src/storage.js?codex-ambiguous=${Date.now()}`);
  const shared = `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-one' } })).toString('base64url')}.s`;
  await storage.upsertAccounts('codex', [
    { label: 'one@example.com', credential: { accessToken: shared, refreshToken: 'r1', expiresAt: 100, accountId: 'org-first' } },
    { label: 'one@example.com', credential: { accessToken: shared, refreshToken: 'r2', expiresAt: 100, accountId: 'org-second' } },
  ]);
  await storage.upsertAccount('codex', 'one@example.com', { accessToken: shared, refreshToken: 'fresh', expiresAt: 200, accountId: 'acct-one' });
  assert.deepEqual((await storage.loadConfig()).accounts.map((a: { id: string }) => a.id), ['org-first', 'org-second', 'acct-one']);
  const credentials = await storage.loadCredentials();
  assert.deepEqual([credentials['codex:org-first'].refreshToken, credentials['codex:org-second'].refreshToken], ['r1', 'r2']);
  delete process.env.TEAMAI_HOME;
});

test('a Codex login never renews an entry stored under a different ChatGPT workspace id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-codex-team-')); process.env.TEAMAI_HOME = root;
  const storage = await import(`../src/storage.js?codex-team=${Date.now()}`);
  const shared = `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-one' } })).toString('base64url')}.s`;
  const team = '0b0b0b0b-0000-4000-8000-000000000001';
  await storage.upsertAccounts('codex', [{ label: 'one@example.com', credential: { accessToken: shared, refreshToken: 'team', expiresAt: 100, accountId: team } }]);
  await storage.upsertAccount('codex', 'one@example.com', { accessToken: shared, refreshToken: 'fresh', expiresAt: 200, accountId: 'acct-one' });
  assert.deepEqual((await storage.loadConfig()).accounts.map((a: { id: string }) => a.id), [team, 'acct-one']);
  assert.equal((await storage.loadCredentials())[`codex:${team}`].refreshToken, 'team');
  delete process.env.TEAMAI_HOME;
});

// `teamai import` wrote a later token for an account the running server held
// without a login stamp. The server refused it as "not a login", and its next
// save wrote the held token back over it, so the import was undone and the
// account stayed on a chain that might already be spent (2026-10-30 review).
test('an explicit import that replaces a held token is adopted by a running server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-import-adopt-')); process.env.TEAMAI_HOME = root;
  const storage = await import(`../src/storage.js?import-adopt=${Date.now()}`);
  const { AccountPool } = await import('../src/account-pool.js');
  const provider = {
    id: 'claude', label: 'Claude', upstreamBase: 'https://example.test', normalizePath: (p: string) => p,
    buildHeaders: (h: Headers) => h, rewriteBody: (b: Buffer) => b, readQuota: () => null,
    classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }), refresh: async (c: unknown) => c,
  };
  const held = { accessToken: 'held', refreshToken: 'held-refresh', expiresAt: Date.now() + 60_000, accountId: 'a' };
  await storage.upsertAccounts('claude', [{ label: 'a', credential: held }]);
  const pool = new AccountPool(provider as never, (await storage.loadConfig()).accounts, await storage.loadCredentials(), { version: 1, accounts: {} });

  const imported = { ...held, accessToken: 'imported', refreshToken: 'imported-refresh', expiresAt: held.expiresAt + 3_600_000 };
  await storage.upsertAccounts('claude', [{ label: 'a', credential: imported }]);
  assert.equal(pool.adoptCredentials(await storage.loadCredentials()), 1, 'the server takes the imported token');
  assert.equal(pool.accounts[0]?.credential.accessToken, 'imported');

  // Importing the token already held is not a hand-over: nothing is rewritten or re-stamped.
  const stamped = (await storage.loadCredentials())['claude:a'];
  await storage.upsertAccounts('claude', [{ label: 'a', credential: imported }]);
  assert.deepEqual((await storage.loadCredentials())['claude:a'], stamped);
  // An older copy still loses to what is held.
  await storage.upsertAccounts('claude', [{ label: 'a', credential: { ...held, accessToken: 'older', expiresAt: held.expiresAt - 1 } }]);
  assert.equal((await storage.loadCredentials())['claude:a'].accessToken, 'imported');
  // A second import, here a new refresh chain behind the same access token, is a hand-over too.
  await new Promise((resolve) => setTimeout(resolve, 2));
  const rechained = { ...imported, refreshToken: 'rechained-refresh', expiresAt: imported.expiresAt + 1 };
  await storage.upsertAccounts('claude', [{ label: 'a', credential: rechained }]);
  assert.equal(pool.adoptCredentials(await storage.loadCredentials()), 1, 'the server takes the new refresh chain');
  assert.equal(pool.accounts[0]?.credential.refreshToken, 'rechained-refresh');

  // A login outranks every import: a later import neither lands on disk nor reaches the server.
  await storage.upsertAccount('claude', 'a', { ...held, accessToken: 'logged-in', expiresAt: held.expiresAt + 1 });
  assert.equal(pool.adoptCredentials(await storage.loadCredentials()), 1);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await storage.upsertAccounts('claude', [{ label: 'a', credential: { ...held, accessToken: 'after-login', expiresAt: held.expiresAt + 7_200_000 } }]);
  assert.equal((await storage.loadCredentials())['claude:a'].accessToken, 'logged-in');
  assert.equal(pool.adoptCredentials(await storage.loadCredentials()), 0);
  assert.equal(pool.accounts[0]?.credential.accessToken, 'logged-in');
  delete process.env.TEAMAI_HOME;
});

test('the activity log appends, and rotates once a write would carry it past its cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-log-'));
  const storage = await import(`../src/storage.js?log=${Date.now()}`);
  const path = join(root, 'events.log');
  await storage.appendLog(path, ['one', 'two'], 40);
  assert.equal(await readFile(path, 'utf8'), 'one\ntwo\n');
  await storage.appendLog(path, ['three'], 40);
  assert.equal(await readFile(path, 'utf8'), 'one\ntwo\nthree\n');
  await storage.appendLog(path, ['a much longer line that carries the file past the cap'], 40);
  assert.equal(await readFile(path, 'utf8'), 'a much longer line that carries the file past the cap\n');
  assert.equal(await readFile(`${path}.1`, 'utf8'), 'one\ntwo\nthree\n', 'the previous file is kept as .1');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
