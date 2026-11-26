// Telling a process apart from one that later got its pid, and a lock file
// built on that. A pid is only reused after its process has exited, so the
// process holding it now started after anything the old one wrote.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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

// When another process started (ms since epoch), or null when it cannot be read.
// `ps -o lstart` is whole seconds in local time; Win32_Process.CreationDate is exact.
export function processStartTime(pid: number, platform: NodeJS.Platform = process.platform): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const result = platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
      : spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000, env: { ...process.env, LC_ALL: 'C' } });
    const at = result.status === 0 ? Date.parse(result.stdout.trim()) : NaN;
    return Number.isFinite(at) ? at : null;
  } catch { return null; }
}

export const processAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Whether a live pid is the process that wrote a record at recordedAt: it must
// have started by then. null: not decidable (no timestamp in the record, or the
// start time cannot be read).
export function startedBy(pid: number, recordedAt: unknown): boolean | null {
  const at = typeof recordedAt === 'string' ? Date.parse(recordedAt) : NaN;
  if (!Number.isFinite(at)) return null;
  const started = processStartTime(pid);
  return started === null ? null : started <= at;
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

// Move an abandoned lock out of the way. Re-reading and then deleting would not
// be atomic: two waiters that judged the same dead lock could each delete, and
// the second would delete the lock the first had just taken. A rename moves
// whatever is at lockPath at that instant to a name only this waiter knows, and
// only one waiter can move a given file. If what it moved is not the lock it
// judged (another waiter already replaced it and took a fresh one), it is put
// back with link(), which never overwrites, and the move counts for nothing.
async function moveAbandoned(lockPath: string, judged: string): Promise<void> {
  const aside = `${lockPath}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
  try { await rename(lockPath, aside); } catch { return; }
  const moved = await readFile(aside, 'utf8').catch(() => null);
  if (moved !== judged) { try { await link(aside, lockPath); } catch { /* lockPath was taken again meanwhile */ } }
  await rm(aside, { force: true });
}

// Run fn while holding lockPath, created exclusively ('wx'). Only the holder's
// own lock is released, and an abandoned lock is moved aside (moveAbandoned),
// never deleted in place.
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, waitMs = 15_000): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), nonce: randomBytes(8).toString('hex') });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { await writeFile(lockPath, body, { flag: 'wx', mode: 0o600 }); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    let raw: string;
    try { raw = await readFile(lockPath, 'utf8'); } catch { continue; }
    if (await lockAbandoned(lockPath, raw)) { await moveAbandoned(lockPath, raw); continue; }
    if (Date.now() > deadline) throw new Error(`${lockPath} is held by another TeamAI process; try again in a moment`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try { return await fn(); } finally {
    try { if (await readFile(lockPath, 'utf8') === body) await rm(lockPath, { force: true }); } catch { /* already gone */ }
  }
}
