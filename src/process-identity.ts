// Telling a process apart from one that later got its pid, and a lock file
// built on that. A pid is only reused after its process has exited, so the
// process holding it now started after anything the old one wrote.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Another process's command line, or null when it cannot be read.
export function processCommandLine(pid: number, platform: NodeJS.Platform = process.platform): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const result = platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
      : spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
    const line = result.status === 0 ? result.stdout.trim() : '';
    return line || null;
  } catch { return null; }
}

// When another process started, or null when it cannot be read. `ps -o lstart`
// is whole seconds (truncated) in local time, so the real start lies anywhere in
// [at, at + 1000); Win32_Process.CreationDate is exact.
export function processStartTime(pid: number, platform: NodeJS.Platform = process.platform): { at: number; resolutionMs: number } | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const result = platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
      : spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000, env: { ...process.env, LC_ALL: 'C' } });
    const at = result.status === 0 ? Date.parse(result.stdout.trim()) : NaN;
    return Number.isFinite(at) ? { at, resolutionMs: platform === 'win32' ? 0 : 1_000 } : null;
  } catch { return null; }
}

export const processAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Start time against record time, allowing for the start time's resolution.
// true: it started before the record was written, so it is the writer. false:
// it started after, so it got the pid later. null: the record was written in the
// same interval the start time is rounded to (often the case, since a process
// writes its record within its first second), and the order cannot be told.
export function startOrder(startedAt: number, resolutionMs: number, recordedAt: number): boolean | null {
  if (startedAt > recordedAt) return false;
  if (startedAt + resolutionMs <= recordedAt) return true;
  return null;
}

// Whether a live pid is the process that wrote a record at recordedAt. null:
// not decidable (no timestamp, unreadable start time, or the same second).
export function startedBy(pid: number, recordedAt: unknown): boolean | null {
  const at = typeof recordedAt === 'string' ? Date.parse(recordedAt) : NaN;
  if (!Number.isFinite(at)) return null;
  const started = processStartTime(pid);
  return started === null ? null : startOrder(started.at, started.resolutionMs, at);
}

// A lock left behind: its holder exited, or its pid now belongs to a process
// that started after the lock was taken. One that does not parse is being
// written, unless it has stayed that way for 5 s (a holder that died mid-write).
async function lockAbandoned(path: string, raw: string): Promise<boolean> {
  let value: { pid?: unknown; at?: unknown };
  try { value = JSON.parse(raw) as typeof value; } catch {
    try { return Date.now() - (await stat(path)).mtimeMs > 5_000; } catch { return false; }
  }
  if (!Number.isInteger(value.pid) || !processAlive(value.pid as number)) return true;
  return startedBy(value.pid as number, value.at) === false;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const tryCreate = async (path: string, body: string): Promise<boolean> => {
  try { await writeFile(path, body, { flag: 'wx', mode: 0o600 }); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; return false; }
};

// The lock is a directory of numbered files, <lock>.d/<n>. The holder is the one
// who created the highest number and has not released it (<n>.released). To take
// the lock a waiter looks at the highest file: while it is held by a live process
// it waits; when there is none, or it is released, or its holder is gone, it
// creates the next number with 'wx', which only one waiter can do.
//
// Nothing deletes another process's lock in order to take its place: judging a
// lock dead and then deleting it is two steps, and each way of closing the gap
// between them (a second lock, moving the file aside) left it open somewhere
// else. A dead lock is simply outnumbered. Numbers are never reused (release
// writes a marker, it does not delete), so 'wx' on the next number is the one
// point where waiters compete. The holder clears the numbers below its own,
// which are all released or abandoned; a waiter that recreates one of them from
// an old listing finds it is not the highest and lets go of it.
async function generations(dir: string): Promise<number[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((name) => /^[0-9]+$/.test(name)).map(Number).sort((a, b) => a - b);
}

async function generationFree(dir: string, n: number): Promise<boolean | 'gone'> {
  const file = join(dir, String(n));
  if (await stat(`${file}.released`).then(() => true, () => false)) return true;
  const raw = await readFile(file, 'utf8').catch(() => null);
  if (raw === null) return 'gone';
  return lockAbandoned(file, raw);
}

export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, waitMs = 15_000): Promise<T> {
  const dir = `${lockPath}.d`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), nonce: randomBytes(8).toString('hex') });
  const deadline = Date.now() + waitMs;
  let mine = 0;
  for (;;) {
    const top = (await generations(dir)).at(-1) ?? 0;
    if (top > 0) {
      const free = await generationFree(dir, top);
      if (free === 'gone') continue; // cleared by a holder between the listing and the read
      if (!free) {
        if (Date.now() > deadline) throw new Error(`${lockPath} is held by another TeamAI process; try again in a moment`);
        await pause(50);
        continue;
      }
    }
    if (!await tryCreate(join(dir, String(top + 1)), body)) continue;
    if ((await generations(dir)).at(-1) === top + 1) { mine = top + 1; break; }
    await tryCreate(join(dir, `${top + 1}.released`), '');
  }
  for (const n of await generations(dir)) {
    if (n >= mine) continue;
    await rm(join(dir, `${n}.released`), { force: true });
    await rm(join(dir, String(n)), { force: true });
  }
  try { return await fn(); } finally { await tryCreate(join(dir, `${mine}.released`), ''); }
}
