import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { importAuth } from '../src/auth.js';

test('imports all OAuth accounts from TeamClaude config without modifying it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamai-import-')); const path = join(dir, 'teamclaude.json');
  const fixture = JSON.stringify({ accounts: [
    { name: 'one@example.com', type: 'oauth', accountUuid: '11111111-1111-1111-1111-111111111111', accessToken: 'access-one', refreshToken: 'refresh-one', expiresAt: 123 },
    { name: 'two@example.com', type: 'oauth', accountUuid: '22222222-2222-2222-2222-222222222222', accessToken: 'access-two', refreshToken: 'refresh-two', expiresAt: 456 },
    { name: 'api-key', type: 'api', apiKey: 'excluded' },
  ] }, null, 2);
  await writeFile(path, fixture);
  const imported = await importAuth('claude', path);
  assert.equal(imported.length, 2); assert.equal(imported[1]?.credential.accountId, '22222222-2222-2222-2222-222222222222');
  assert.equal(await readFile(path, 'utf8'), fixture);
});

test('imports every codex-multi-auth account and preserves its selected workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamai-codex-multi-auth-import-')); const path = join(dir, 'openai-codex-accounts.json');
  const fixture = JSON.stringify({
    version: 1,
    activeIndex: 1,
    accounts: [
      {
        email: 'one@example.com', accountLabel: 'Personal', accessToken: 'access-one', refreshToken: 'refresh-one', expiresAt: 123,
        accountId: 'workspace-one', currentWorkspaceIndex: 1,
        workspaces: [{ id: 'workspace-old', name: 'Old', enabled: true }, { id: 'workspace-one', name: 'Personal', enabled: true }],
      },
      {
        email: 'two@example.com', accountLabel: 'Work', accessToken: 'access-two', refreshToken: 'refresh-two', expiresAt: 456,
        accountId: 'workspace-two', currentWorkspaceIndex: 0,
        workspaces: [{ id: 'workspace-two', name: 'Work', enabled: true }],
      },
      { email: 'invalid@example.com', accountId: 'missing-token' },
    ],
  }, null, 2);
  await writeFile(path, fixture);
  const imported = await importAuth('codex', path);
  assert.equal(imported.length, 2);
  assert.deepEqual(imported.map((row) => ({ label: row.label, accountId: row.credential.accountId })), [
    { label: 'one@example.com', accountId: 'workspace-one' },
    { label: 'two@example.com', accountId: 'workspace-two' },
  ]);
  assert.equal(imported[0]?.credential.refreshToken, 'refresh-one');
  assert.equal(await readFile(path, 'utf8'), fixture);
});
