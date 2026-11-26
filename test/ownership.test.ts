import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startedBy } from '../src/process-identity.js';
import { isServerCommandLine, ownsServerPid } from '../src/runtime.js';
import { defaultConfig, paths } from '../src/storage.js';

test('a relay server command line is recognized however it was started', () => {
  assert.equal(isServerCommandLine('/usr/local/bin/node /Users/me/team-ai/dist/src/cli.js server'), true);
  assert.equal(isServerCommandLine('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\team-ai\\dist\\src\\cli.js" server'), true);
  assert.equal(isServerCommandLine('node /opt/teamai-cli/dist/src/cli.js server --verbose'), true);
  assert.equal(isServerCommandLine('node /Users/me/team-ai/dist/src/cli.js status'), false, 'a CLI command is not the server');
  assert.equal(isServerCommandLine('node /Users/me/team-ai/dist/src/cli.js serverless'), false);
  assert.equal(isServerCommandLine('/usr/bin/python3 -m http.server'), false);
  assert.equal(isServerCommandLine('/opt/homebrew/bin/node /opt/homebrew/bin/teamai server'), true, '`teamai server` through the npm link');
  assert.equal(isServerCommandLine('node dist/src/cli.js server'), true, 'a relative path');
  assert.equal(isServerCommandLine('node /x/notteamai server'), false);
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

test('a process is the writer of a record only if it started before the record was written', { timeout: 15_000 }, async () => {
  const before = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 1_200));
    const recordedAt = new Date().toISOString();
    // ps reports whole seconds: wait into the next second before the "reused" pid starts.
    await new Promise((r) => setTimeout(r, 1_200));
    const after = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(startedBy(before.pid!, recordedAt), true, 'started before the record: the writer');
      assert.equal(startedBy(after.pid!, recordedAt), false, 'started after the record: a reused pid');
      assert.equal(startedBy(before.pid!, undefined), null, 'no timestamp: not decidable');
    } finally { after.kill('SIGKILL'); }
  } finally { before.kill('SIGKILL'); }
});

test('a hung server is ours by its start time however it was launched, a later process with its pid is not', { timeout: 20_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'teamai-ownership-start-')); const previous = process.env.TEAMAI_HOME;
  process.env.TEAMAI_HOME = home;
  const config = defaultConfig(); config.proxy.controlPort = await freePort();
  // Launched the way `teamai server` through an npm link looks: no dist/src/cli.js on the line.
  const hung = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)', 'server'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 1_200));
    await writeFile(paths().server, JSON.stringify({ pid: hung.pid, startedAt: new Date().toISOString() }));
    assert.equal(await ownsServerPid(hung.pid!, config), true);
    await new Promise((r) => setTimeout(r, 1_200));
    const reused = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      // The record now names a process that started after it was written.
      await writeFile(paths().server, JSON.stringify({ pid: reused.pid, startedAt: new Date(Date.now() - 2_000).toISOString() }));
      assert.equal(await ownsServerPid(reused.pid!, config), false);
    } finally { reused.kill('SIGKILL'); }
  } finally {
    hung.kill('SIGKILL');
    if (previous === undefined) delete process.env.TEAMAI_HOME; else process.env.TEAMAI_HOME = previous;
  }
});
