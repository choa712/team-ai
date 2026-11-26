import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isServerCommandLine, ownsServerPid } from '../src/runtime.js';
import { defaultConfig } from '../src/storage.js';

test('a relay server command line is recognized however it was started', () => {
  assert.equal(isServerCommandLine('/usr/local/bin/node /Users/me/team-ai/dist/src/cli.js server'), true);
  assert.equal(isServerCommandLine('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\team-ai\\dist\\src\\cli.js" server'), true);
  assert.equal(isServerCommandLine('node /opt/teamai-cli/dist/src/cli.js server --verbose'), true);
  assert.equal(isServerCommandLine('node /Users/me/team-ai/dist/src/cli.js status'), false, 'a CLI command is not the server');
  assert.equal(isServerCommandLine('node /Users/me/team-ai/dist/src/cli.js serverless'), false);
  assert.equal(isServerCommandLine('/usr/bin/python3 -m http.server'), false);
  assert.equal(isServerCommandLine(null), false);
});

async function freePort(): Promise<number> {
  const probe = createServer(); await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const address = probe.address(); assert(address && typeof address !== 'string');
  await new Promise<void>((r) => probe.close(() => r()));
  return address.port;
}

test('a recorded pid is ours only when it is this relay, never a program that reused the pid', { timeout: 20_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'teamai-ownership-'));
  const config = defaultConfig(); config.proxy.controlPort = await freePort();
  // A hung server: the right command line, no /health answer.
  const cli = join(home, 'dist', 'src', 'cli.js');
  await mkdir(join(home, 'dist', 'src'), { recursive: true });
  await writeFile(cli, 'setTimeout(() => {}, 60_000);\n');
  const hung = spawn(process.execPath, [cli, 'server'], { stdio: 'ignore' });
  // Another program now holding a pid server.json could name.
  const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await ownsServerPid(hung.pid!, config), true, 'a hung server is recognized by its command line');
    assert.equal(await ownsServerPid(stranger.pid!, config), false, 'an unrelated process is not signalled');
    assert.equal(await ownsServerPid(2 ** 22 + 12_345, config), false, 'a pid with no process is not ours');
  } finally { hung.kill('SIGKILL'); stranger.kill('SIGKILL'); }
});
