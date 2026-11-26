import assert from 'node:assert/strict';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('import --dry-run validates a codex-multi-auth file without writing TeamAI state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-cli-dry-run-')); const source = join(root, 'accounts.json'); const home = join(root, 'teamai');
  await writeFile(source, JSON.stringify({ accounts: [{
    email: 'one@example.com', accessToken: 'access-one', refreshToken: 'refresh-one', expiresAt: 123,
    accountId: 'workspace-one', currentWorkspaceIndex: 0, workspaces: [{ id: 'workspace-one', enabled: true }],
  }] }));
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', 'tsx', cli, 'import', 'codex', '--from', source, '--dry-run'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', env: { ...process.env, TEAMAI_HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Would import 1 codex account/);
  await assert.rejects(access(join(home, 'config.json')));
});
