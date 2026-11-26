import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig, paths } from './storage.js';
import { ownsServerPid, probeServer, recordedServerPid, releaseServerFile } from './runtime.js';
import { processAlive, processCommandLine, startedBy, withFileLock } from './process-identity.js';

const numberFromEnv = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const unrefWait = (ms: number): Promise<void> => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref(); });

export class HealthFailureWindow {
  private failures = 0;
  constructor(private readonly limit: number, private readonly startupGraceMs: number, private readonly startedAt = Date.now()) {}
  observe(healthy: boolean, now = Date.now()): boolean {
    if (healthy) { this.failures = 0; return false; }
    if (now - this.startedAt < this.startupGraceMs) return false;
    this.failures++;
    return this.failures >= this.limit;
  }
}

function closed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });
}

// The server handles SIGTERM once; a repeat would interrupt its drain and final
// save. Whichever path signals first (a stop request or a health restart), the
// other must not signal again.
const signalled = new WeakSet<ChildProcess>();
function signalTerm(child: ChildProcess): void {
  if (signalled.has(child) || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGTERM'); signalled.add(child); } catch { /* already stopped */ }
}

async function terminate(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalTerm(child);
  await Promise.race([closed(child), unrefWait(graceMs)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed(child); }
}

const alive = processAlive;

// A server started earlier by a launcher holds the ports, so a supervised child
// would die on EADDRINUSE over and over while the unsupervised one could hang
// unnoticed. Take it over: ask it to stop (it drains and saves its tokens),
// wait, kill it if it will not go, and refuse to start if even that fails. A
// hung server is taken over as well: leaving it would keep the ports taken.
export async function takeOverServer(graceMs: number): Promise<number | null> {
  const pid = await recordedServerPid();
  if (!pid || pid === process.pid || !alive(pid)) return null;
  // Signal only a process that proves it is this relay (authenticated health
  // naming the same pid, or a server command line when it answers nothing); a
  // recycled pid belongs to someone else and only loses the stale record.
  if (!await ownsServerPid(pid)) { await releaseServerFile(paths().server, pid); return null; }
  try { process.kill(pid, 'SIGTERM'); } catch { return null; }
  const deadline = Date.now() + graceMs;
  while (alive(pid) && Date.now() < deadline) await wait(100);
  if (alive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone just now */ }
    const killDeadline = Date.now() + 2_000;
    while (alive(pid) && Date.now() < killDeadline) await wait(50);
    if (!alive(pid)) await releaseServerFile(paths().server, pid);
  }
  if (alive(pid)) throw new Error(`An unsupervised TeamAI server (pid ${pid}) did not stop within ${Math.round(graceMs / 1000)} s; stop it and start the supervisor again`);
  return pid;
}

// A supervisor runs as `node <...>/dist/src/cli.js supervise` (a LaunchAgent) or
// `node <bin>/teamai supervise` (by hand through the npm link).
export function isSupervisorCommandLine(line: string | null): boolean {
  return line !== null && /(?:^|[\s"'\\/])(?:dist[\\/]src[\\/]cli\.js|teamai(?:\.js)?)["']?\s+supervise(?:\s|$)/.test(line);
}

// supervisor.json as stored: its text, and the pid and timestamp when it parses.
async function readRecord(): Promise<{ raw: string; pid: number | null; startedAt: unknown } | null> {
  let raw: string;
  try { raw = await readFile(paths().supervisor, 'utf8'); } catch { return null; }
  try { const value = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown }; return { raw, pid: Number.isInteger(value.pid) ? value.pid as number : null, startedAt: value.startedAt }; } catch { return { raw, pid: null, startedAt: undefined }; }
}

// The running supervisor, or null. A live pid is not enough: after a crash the
// OS can hand it to another program, and then `supervise` would refuse to start
// and every launcher would wait for a supervisor that is not there. The pid has
// to be this process, or a process that started before it wrote the record
// (however it was launched); a record without a timestamp falls back to a
// supervisor's command line.
export async function recordedSupervisorPid(): Promise<number | null> {
  const record = await readRecord();
  if (!record?.pid || !alive(record.pid)) return null;
  if (record.pid === process.pid) return record.pid;
  const started = startedBy(record.pid, record.startedAt);
  return (started ?? isSupervisorCommandLine(processCommandLine(record.pid))) ? record.pid : null;
}

// Take supervisor.json for this supervisor, or throw when another one holds it.
// The record is created exclusively ('wx'), so two supervisors starting at once
// cannot both see it absent and both run. A stale record (dead or foreign pid)
// is replaced only under a lock (supervisor.json.lock) and only while it still reads as it
// did when judged. One that does not parse yet is being written and is given a
// moment before it counts as stale.
export async function claimSupervisorRecord(pid: number = process.pid): Promise<void> {
  const path = paths().supervisor;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ pid, startedAt: new Date().toISOString() });
  const exclusive = async (): Promise<boolean> => {
    try { await writeFile(path, body, { flag: 'wx', mode: 0o600 }); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; return false; }
  };
  const deadline = Date.now() + 2_000;
  for (;;) {
    if (await exclusive()) return;
    const record = await readRecord();
    if (!record) continue;
    if (record.pid === null && Date.now() < deadline) { await wait(50); continue; }
    const holder = await recordedSupervisorPid();
    if (holder) throw new Error(`TeamAI supervisor already running (pid ${holder})`);
    if (Date.now() > deadline + 15_000) throw new Error(`Could not take ${path}; another supervisor may be starting`);
    const reclaimed = await withFileLock(`${path}.lock`, async () => {
      const again = await readRecord();
      if (!again || again.raw !== record.raw || await recordedSupervisorPid()) return false;
      await rm(path, { force: true });
      return exclusive();
    }, 5_000);
    if (reclaimed) return;
  }
}

async function removeOwnRecord(): Promise<void> {
  try {
    const value = JSON.parse(await readFile(paths().supervisor, 'utf8')) as { pid?: number };
    if (value.pid === process.pid) await rm(paths().supervisor, { force: true });
  } catch { /* no supervisor record */ }
}

export async function runSupervisor(cliPath: string, options: { signal?: AbortSignal } = {}): Promise<void> {
  const intervalMs = numberFromEnv('TEAMAI_SUPERVISOR_INTERVAL_MS', 10_000);
  const startupGraceMs = numberFromEnv('TEAMAI_SUPERVISOR_STARTUP_GRACE_MS', 10_000);
  const maxFailures = numberFromEnv('TEAMAI_SUPERVISOR_MAX_FAILURES', 3);
  // Longer than the server's own 5 s drain, so its final save of rotated tokens
  // runs before a SIGKILL can cut it.
  const stopGraceMs = numberFromEnv('TEAMAI_SUPERVISOR_STOP_GRACE_MS', 12_000);
  const initialBackoffMs = numberFromEnv('TEAMAI_SUPERVISOR_BACKOFF_MS', 1_000);
  const maxBackoffMs = numberFromEnv('TEAMAI_SUPERVISOR_MAX_BACKOFF_MS', 30_000);
  await claimSupervisorRecord();
  try {
    const taken = await takeOverServer(stopGraceMs);
    if (taken) console.error(`[TeamAI] supervisor took over from unsupervised server pid=${taken}`);
  } catch (error) { await removeOwnRecord(); throw error; }
  let stopping = options.signal?.aborted ?? false; let child: ChildProcess | null = null; let backoffMs = initialBackoffMs;
  const stop = (): void => { stopping = true; if (child) signalTerm(child); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  options.signal?.addEventListener('abort', stop, { once: true });
  try {
    while (!stopping) {
      child = spawn(process.execPath, [cliPath, 'server'], { stdio: 'inherit', env: process.env });
      const ended = closed(child); const health = new HealthFailureWindow(maxFailures, startupGraceMs);
      let restartForHealth = false;
      while (!stopping && child.exitCode === null && child.signalCode === null) {
        const event = await Promise.race([ended.then(() => 'exit' as const), wait(intervalMs).then(() => 'tick' as const)]);
        if (event === 'exit') break;
        let healthy = false;
        try { healthy = child.pid ? await probeServer(await loadConfig(), child.pid) : false; } catch { /* invalid config is unhealthy */ }
        if (health.observe(healthy)) { restartForHealth = true; break; }
        if (healthy) backoffMs = initialBackoffMs;
      }
      if (stopping) { await terminate(child, stopGraceMs); break; }
      if (restartForHealth) {
        console.error(`[TeamAI] supervisor restarting unhealthy server pid=${child.pid ?? 'unknown'}`);
        await terminate(child, stopGraceMs);
      } else await ended;
      if (!stopping) { await wait(backoffMs); backoffMs = Math.min(backoffMs * 2, maxBackoffMs); }
    }
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    options.signal?.removeEventListener('abort', stop);
    await removeOwnRecord();
  }
}
