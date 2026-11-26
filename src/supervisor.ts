import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { atomicWrite, loadConfig, paths } from './storage.js';
import { probeServer, recordedServerPid } from './runtime.js';

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

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A server started earlier by a launcher holds the ports, so a supervised child
// would die on EADDRINUSE over and over while the unsupervised one could hang
// unnoticed. Take it over: ask it to stop (it drains and saves its tokens), wait,
// and refuse to start if it will not go.
export async function takeOverServer(graceMs: number): Promise<number | null> {
  const pid = await recordedServerPid();
  if (!pid || pid === process.pid || !alive(pid)) return null;
  // Signal only a process that proves it is this relay (authenticated health
  // naming the same pid); a recycled pid belongs to someone else.
  let ours = false;
  try { ours = await probeServer(await loadConfig(), pid); } catch { ours = false; }
  if (!ours) return null;
  try { process.kill(pid, 'SIGTERM'); } catch { return null; }
  const deadline = Date.now() + graceMs;
  while (alive(pid) && Date.now() < deadline) await wait(100);
  if (alive(pid)) throw new Error(`An unsupervised TeamAI server (pid ${pid}) did not stop within ${Math.round(graceMs / 1000)} s; stop it and start the supervisor again`);
  return pid;
}

export async function recordedSupervisorPid(): Promise<number | null> {
  try {
    const value = JSON.parse(await readFile(paths().supervisor, 'utf8')) as { pid?: number };
    if (!value.pid) return null;
    process.kill(value.pid, 0);
    return value.pid;
  } catch { return null; }
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
  const existing = await recordedSupervisorPid();
  if (existing && existing !== process.pid) throw new Error(`TeamAI supervisor already running (pid ${existing})`);
  await atomicWrite(paths().supervisor, { pid: process.pid, startedAt: new Date().toISOString() });
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
