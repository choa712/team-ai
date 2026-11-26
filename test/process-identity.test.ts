import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startOrder, withFileLock } from '../src/process-identity.js';

// A pid that no process holds any more.
async function deadPid(): Promise<number> {
  const gone = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((r) => gone.once('exit', r));
  return gone.pid!;
}
// Put a lock file at generation n, as a holder that took it at `at` would.
async function holdAt(lock: string, n: number, pid: number, at: Date): Promise<string> {
  await mkdir(`${lock}.d`, { recursive: true });
  const file = join(`${lock}.d`, String(n));
  await writeFile(file, JSON.stringify({ pid, at: at.toISOString() }));
  return file;
}
// The generation that holds the lock now: the highest one that is not released.
async function holder(lock: string): Promise<number | null> {
  const names = await readdir(`${lock}.d`).catch(() => [] as string[]);
  const numbers = names.filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
  const top = numbers.at(-1);
  return top === undefined || names.includes(`${top}.released`) ? null : top;
}

test('withFileLock never lets two holders inside at once, and releases afterwards', async () => {
  const lock = join(await mkdtemp(join(tmpdir(), 'teamai-lock-')), 'x.lock');
  let inside = 0; let most = 0;
  await Promise.all(Array.from({ length: 6 }, () => withFileLock(lock, async () => {
    inside++; most = Math.max(most, inside);
    await new Promise((r) => setTimeout(r, 20));
    inside--;
  })));
  assert.equal(most, 1);
  assert.equal(await holder(lock), null, 'nobody holds it afterwards');
});

test('a lock left by a process that exited is outnumbered, a live holder is waited for', { timeout: 10_000 }, async () => {
  const lock = join(await mkdtemp(join(tmpdir(), 'teamai-lock-stale-')), 'x.lock');
  const dead = await holdAt(lock, 1, await deadPid(), new Date());
  assert.equal(await withFileLock(lock, async () => 'ran', 2_000), 'ran');
  await assert.rejects(readFile(dead), 'the dead holder\'s file is cleared by the next holder');
  // A live holder (this process, taken just now) is waited for, then given up on.
  const live = await holdAt(lock, 10, process.pid, new Date());
  const old = new Date(Date.now() - 60_000); await utimes(live, old, old);
  await assert.rejects(withFileLock(lock, async () => 'ran', 300), /held by another TeamAI process/);
  assert.equal(await holder(lock), 10, 'however old its file, a live holder keeps the lock');
});

test('waiters that find the same abandoned lock still get in one at a time', { timeout: 30_000 }, async () => {
  const lock = join(await mkdtemp(join(tmpdir(), 'teamai-lock-race-')), 'x.lock');
  const dead = await deadPid();
  for (let round = 0; round < 20; round++) {
    const top = (await readdir(`${lock}.d`).catch(() => [] as string[])).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b).at(-1) ?? 0;
    await holdAt(lock, top + 1, dead, new Date(Date.now() - 60_000));
    let inside = 0; let most = 0; let ran = 0;
    await Promise.all(Array.from({ length: 5 }, () => withFileLock(lock, async () => {
      inside++; most = Math.max(most, inside); ran++;
      await new Promise((r) => setTimeout(r, 5));
      inside--;
    }, 5_000)));
    assert.equal(most, 1, `round ${round}: one holder at a time`);
    assert.equal(ran, 5);
    assert.equal(await holder(lock), null);
  }
});

test('start order allows for a start time rounded down to the second', () => {
  const second = Date.parse('2026-11-26T00:00:00.000Z');
  // ps shows 00:00:00 for anything that started in that second.
  assert.equal(startOrder(second, 1_000, second + 1_500), true, 'started at least a second before the record: the writer');
  assert.equal(startOrder(second, 1_000, second + 1_000), true);
  assert.equal(startOrder(second, 1_000, second + 400), null, 'record in the same second: the order cannot be told');
  assert.equal(startOrder(second, 1_000, second), null);
  assert.equal(startOrder(second, 1_000, second - 1), false, 'started after the record: a reused pid');
  assert.equal(startOrder(second + 250, 0, second + 400), true, 'an exact start time needs no margin');
  assert.equal(startOrder(second + 500, 0, second + 400), false);
});
