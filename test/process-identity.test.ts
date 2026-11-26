import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { withFileLock } from '../src/process-identity.js';

test('withFileLock never lets two holders inside at once', async () => {
  const lock = join(await mkdtemp(join(tmpdir(), 'teamai-lock-')), 'x.lock');
  let inside = 0; let most = 0;
  await Promise.all(Array.from({ length: 6 }, () => withFileLock(lock, async () => {
    inside++; most = Math.max(most, inside);
    await new Promise((r) => setTimeout(r, 20));
    inside--;
  })));
  assert.equal(most, 1);
  await assert.rejects(readFile(lock), 'the lock is released afterwards');
});

test('a lock left by a process that exited is taken over, a live holder is waited for', { timeout: 10_000 }, async () => {
  const lock = join(await mkdtemp(join(tmpdir(), 'teamai-lock-stale-')), 'x.lock');
  const gone = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((r) => gone.once('exit', r));
  await writeFile(lock, JSON.stringify({ pid: gone.pid, at: new Date().toISOString() }));
  assert.equal(await withFileLock(lock, async () => 'ran', 2_000), 'ran');
  // A live holder (this process, taken just now) is not abandoned: wait, then give up.
  await writeFile(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  await assert.rejects(withFileLock(lock, async () => 'ran', 300), /held by another TeamAI process/);
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).pid, process.pid, 'someone else\'s lock is left in place');
});

test('waiters that find the same abandoned lock still get in one at a time', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamai-lock-race-')); const lock = join(dir, 'x.lock');
  const gone = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((r) => gone.once('exit', r));
  for (let round = 0; round < 20; round++) {
    await writeFile(lock, JSON.stringify({ pid: gone.pid, at: new Date(Date.now() - 60_000).toISOString() }));
    let inside = 0; let most = 0; let ran = 0;
    await Promise.all(Array.from({ length: 5 }, () => withFileLock(lock, async () => {
      inside++; most = Math.max(most, inside); ran++;
      await new Promise((r) => setTimeout(r, 5));
      inside--;
    }, 5_000)));
    assert.equal(most, 1, `round ${round}: one holder at a time`);
    assert.equal(ran, 5);
  }
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(dir), [], 'no lock or moved-aside file is left behind');
});
