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
