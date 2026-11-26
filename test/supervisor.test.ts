import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { defaultConfig, paths } from '../src/storage.js';
import { claimSupervisorRecord, HealthFailureWindow, isSupervisorCommandLine, recordedSupervisorPid, runSupervisor } from '../src/supervisor.js';

test('supervisor ignores startup misses and restarts after consecutive health failures', () => {
  const health = new HealthFailureWindow(3, 5_000, 1_000);
  assert.equal(health.observe(false, 2_000), false, 'startup grace');
  assert.equal(health.observe(false, 6_000), false);
  assert.equal(health.observe(true, 7_000), false, 'a healthy probe resets the counter');
  assert.equal(health.observe(false, 8_000), false);
  assert.equal(health.observe(false, 9_000), false);
  assert.equal(health.observe(false, 10_000), true);
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function pids(path: string, count: number): Promise<number[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const values = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(Number);
      if (values.length >= count) return values;
    } catch { /* child has not written the file yet */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`supervisor did not start ${count} server process(es)`);
}

test('supervisor restarts a server process that exits', { timeout: 10_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'teamai-supervisor-')); const log = join(home, 'pids.log'); const script = join(home, 'fake-server.mjs');
  const config = defaultConfig(); config.proxy.controlPort = await freePort();
  await writeFile(join(home, 'config.json'), JSON.stringify(config));
  await writeFile(script, `
    import { appendFileSync, readFileSync } from 'node:fs';
    import { createServer } from 'node:http';
    const config = JSON.parse(readFileSync(process.env.TEAMAI_HOME + '/config.json', 'utf8'));
    appendFileSync(process.env.TEAMAI_TEST_PID_LOG, String(process.pid) + '\\n');
    const server = createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer ' + config.proxy.clientToken) { res.writeHead(401).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', pid: process.pid }));
    });
    server.listen(config.proxy.controlPort, config.proxy.host);
    const stop = () => server.close(() => process.exit(0));
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  `);
  const names = ['TEAMAI_HOME', 'TEAMAI_TEST_PID_LOG', 'TEAMAI_SUPERVISOR_INTERVAL_MS', 'TEAMAI_SUPERVISOR_STARTUP_GRACE_MS', 'TEAMAI_SUPERVISOR_MAX_FAILURES', 'TEAMAI_SUPERVISOR_BACKOFF_MS', 'TEAMAI_SUPERVISOR_MAX_BACKOFF_MS'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    TEAMAI_HOME: home,
    TEAMAI_TEST_PID_LOG: log,
    TEAMAI_SUPERVISOR_INTERVAL_MS: '50',
    TEAMAI_SUPERVISOR_STARTUP_GRACE_MS: '100',
    TEAMAI_SUPERVISOR_MAX_FAILURES: '2',
    TEAMAI_SUPERVISOR_BACKOFF_MS: '50',
    TEAMAI_SUPERVISOR_MAX_BACKOFF_MS: '100',
  });
  const controller = new AbortController(); const supervising = runSupervisor(script, { signal: controller.signal }); let seen: number[] = [];
  try {
    seen = await pids(log, 1); process.kill(seen[0]!, 'SIGKILL');
    seen = await pids(log, 2); assert.notEqual(seen[0], seen[1]);
  } finally {
    controller.abort(); await supervising;
    await assert.rejects(access(paths().supervisor));
    for (const name of names) { const value = previous[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    for (const pid of seen) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
  }
});

test('supervisor sends one SIGTERM so a draining server can finish its final save', { timeout: 10_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'teamai-supervisor-term-')); const log = join(home, 'pids.log'); const terms = join(home, 'terms.log'); const script = join(home, 'slow-server.mjs');
  const config = defaultConfig(); config.proxy.controlPort = await freePort();
  await writeFile(join(home, 'config.json'), JSON.stringify(config));
  await writeFile(script, `
    import { appendFileSync, readFileSync } from 'node:fs';
    import { createServer } from 'node:http';
    const config = JSON.parse(readFileSync(process.env.TEAMAI_HOME + '/config.json', 'utf8'));
    appendFileSync(process.env.TEAMAI_TEST_PID_LOG, String(process.pid) + '\\n');
    const server = createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', pid: process.pid })));
    server.listen(config.proxy.controlPort, config.proxy.host);
    // Count every SIGTERM and take a while to exit, like a server draining a stream.
    process.on('SIGTERM', () => { appendFileSync(process.env.TEAMAI_TEST_TERM_LOG, 'T\\n'); setTimeout(() => process.exit(0), 400); });
  `);
  const names = ['TEAMAI_HOME', 'TEAMAI_TEST_PID_LOG', 'TEAMAI_TEST_TERM_LOG', 'TEAMAI_SUPERVISOR_INTERVAL_MS', 'TEAMAI_SUPERVISOR_STARTUP_GRACE_MS'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { TEAMAI_HOME: home, TEAMAI_TEST_PID_LOG: log, TEAMAI_TEST_TERM_LOG: terms, TEAMAI_SUPERVISOR_INTERVAL_MS: '50', TEAMAI_SUPERVISOR_STARTUP_GRACE_MS: '10000' });
  const controller = new AbortController(); const supervising = runSupervisor(script, { signal: controller.signal }); let seen: number[] = [];
  try {
    seen = await pids(log, 1);
    controller.abort(); await supervising;
    assert.equal((await readFile(terms, 'utf8')).trim().split('\n').length, 1);
  } finally {
    for (const name of names) { const value = previous[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    for (const pid of seen) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
  }
});

test('supervisor takes over a healthy unsupervised server instead of fighting it for the port', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'teamai-supervisor-takeover-')); const log = join(home, 'pids.log'); const script = join(home, 'fake-server.mjs');
  const config = defaultConfig(); config.proxy.controlPort = await freePort();
  await writeFile(join(home, 'config.json'), JSON.stringify(config));
  await writeFile(script, `
    import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
    import { createServer } from 'node:http';
    const config = JSON.parse(readFileSync(process.env.TEAMAI_HOME + '/config.json', 'utf8'));
    appendFileSync(process.env.TEAMAI_TEST_PID_LOG, String(process.pid) + '\\n');
    const server = createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer ' + config.proxy.clientToken) { res.writeHead(401).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', pid: process.pid }));
    });
    server.listen(config.proxy.controlPort, config.proxy.host, () => writeFileSync(process.env.TEAMAI_HOME + '/server.json', JSON.stringify({ pid: process.pid })));
    const stop = () => server.close(() => process.exit(0));
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  `);
  const names = ['TEAMAI_HOME', 'TEAMAI_TEST_PID_LOG', 'TEAMAI_SUPERVISOR_INTERVAL_MS', 'TEAMAI_SUPERVISOR_STARTUP_GRACE_MS'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { TEAMAI_HOME: home, TEAMAI_TEST_PID_LOG: log, TEAMAI_SUPERVISOR_INTERVAL_MS: '50', TEAMAI_SUPERVISOR_STARTUP_GRACE_MS: '10000' });
  // A launcher-started server, running before the supervisor.
  const { spawn } = await import('node:child_process');
  const orphan = spawn(process.execPath, [script], { stdio: 'ignore', env: process.env });
  const controller = new AbortController(); let seen: number[] = [];
  try {
    seen = await pids(log, 1);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) { try { if (JSON.parse(await readFile(join(home, 'server.json'), 'utf8')).pid === orphan.pid) break; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 25)); }
    const supervising = runSupervisor(script, { signal: controller.signal });
    seen = await pids(log, 2);
    assert.equal(seen[0], orphan.pid);
    assert.notEqual(seen[1], orphan.pid);
    assert.ok(orphan.exitCode !== null || orphan.signalCode !== null || await new Promise((r) => orphan.once('exit', () => r(true))), 'the unsupervised server was stopped');
    controller.abort(); await supervising;
  } finally {
    controller.abort();
    for (const name of names) { const value = previous[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    for (const pid of [...seen, orphan.pid]) { try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
  }
});

test('supervisor takes over a hung unsupervised server, killing it when it ignores SIGTERM', { timeout: 20_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'teamai-supervisor-hung-')); const log = join(home, 'pids.log'); const script = join(home, 'fake-server.mjs');
  const config = defaultConfig(); config.proxy.controlPort = await freePort();
  await writeFile(join(home, 'config.json'), JSON.stringify(config));
  await writeFile(script, `
    import { appendFileSync, readFileSync } from 'node:fs';
    import { createServer } from 'node:http';
    const config = JSON.parse(readFileSync(process.env.TEAMAI_HOME + '/config.json', 'utf8'));
    appendFileSync(process.env.TEAMAI_TEST_PID_LOG, String(process.pid) + '\\n');
    const server = createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer ' + config.proxy.clientToken) { res.writeHead(401).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', pid: process.pid }));
    });
    server.listen(config.proxy.controlPort, config.proxy.host);
    const stop = () => server.close(() => process.exit(0));
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  `);
  // A hung relay started earlier: the server command line, no /health answer,
  // and it ignores SIGTERM. Leaving it would keep the ports taken.
  const hungCli = join(home, 'dist', 'src', 'cli.js');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(home, 'dist', 'src'), { recursive: true });
  await writeFile(hungCli, "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60_000);\n");
  const names = ['TEAMAI_HOME', 'TEAMAI_TEST_PID_LOG', 'TEAMAI_SUPERVISOR_INTERVAL_MS', 'TEAMAI_SUPERVISOR_STARTUP_GRACE_MS', 'TEAMAI_SUPERVISOR_STOP_GRACE_MS'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { TEAMAI_HOME: home, TEAMAI_TEST_PID_LOG: log, TEAMAI_SUPERVISOR_INTERVAL_MS: '50', TEAMAI_SUPERVISOR_STARTUP_GRACE_MS: '10000', TEAMAI_SUPERVISOR_STOP_GRACE_MS: '500' });
  const { spawn } = await import('node:child_process');
  const hung = spawn(process.execPath, [hungCli, 'server'], { stdio: 'ignore', env: process.env });
  const exited = new Promise<boolean>((r) => hung.once('exit', () => r(true)));
  await writeFile(join(home, 'server.json'), JSON.stringify({ pid: hung.pid }));
  const controller = new AbortController(); let seen: number[] = [];
  try {
    await new Promise((r) => setTimeout(r, 300));
    const supervising = runSupervisor(script, { signal: controller.signal });
    seen = await pids(log, 1);
    assert.notEqual(seen[0], hung.pid, 'the supervisor started its own server');
    assert.equal(await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 3_000))]), true, 'the hung server was killed');
    controller.abort(); await supervising;
  } finally {
    controller.abort();
    for (const name of names) { const value = previous[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    for (const pid of [...seen, hung.pid]) { try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
  }
});

test('supervisor leaves a process that reused a recorded pid alone and only clears the record', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'teamai-supervisor-stranger-')); const log = join(home, 'pids.log'); const script = join(home, 'fake-server.mjs');
  const config = defaultConfig(); config.proxy.controlPort = await freePort();
  await writeFile(join(home, 'config.json'), JSON.stringify(config));
  await writeFile(script, `
    import { appendFileSync } from 'node:fs';
    appendFileSync(process.env.TEAMAI_TEST_PID_LOG, String(process.pid) + '\\n');
    setTimeout(() => {}, 60_000);
    process.once('SIGTERM', () => process.exit(0));
  `);
  const names = ['TEAMAI_HOME', 'TEAMAI_TEST_PID_LOG', 'TEAMAI_SUPERVISOR_INTERVAL_MS', 'TEAMAI_SUPERVISOR_STARTUP_GRACE_MS', 'TEAMAI_SUPERVISOR_STOP_GRACE_MS'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { TEAMAI_HOME: home, TEAMAI_TEST_PID_LOG: log, TEAMAI_SUPERVISOR_INTERVAL_MS: '50', TEAMAI_SUPERVISOR_STARTUP_GRACE_MS: '10000', TEAMAI_SUPERVISOR_STOP_GRACE_MS: '500' });
  const { spawn } = await import('node:child_process');
  const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  await writeFile(join(home, 'server.json'), JSON.stringify({ pid: stranger.pid }));
  const controller = new AbortController(); let seen: number[] = [];
  try {
    await new Promise((r) => setTimeout(r, 300));
    const supervising = runSupervisor(script, { signal: controller.signal });
    seen = await pids(log, 1);
    assert.equal(stranger.exitCode, null, 'the unrelated process is still running');
    assert.equal(stranger.signalCode, null);
    controller.abort(); await supervising;
  } finally {
    controller.abort();
    for (const name of names) { const value = previous[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    for (const pid of [...seen, stranger.pid]) { try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
  }
});

test('a supervisor command line is recognized, other commands are not', () => {
  assert.equal(isSupervisorCommandLine('/usr/local/bin/node /Users/me/team-ai/dist/src/cli.js supervise'), true);
  assert.equal(isSupervisorCommandLine('"C:\\nodejs\\node.exe" "C:\\team-ai\\dist\\src\\cli.js" supervise'), true);
  assert.equal(isSupervisorCommandLine('node /Users/me/team-ai/dist/src/cli.js server'), false);
  assert.equal(isSupervisorCommandLine('node -e setTimeout(()=>{},1e6)'), false);
  assert.equal(isSupervisorCommandLine(null), false);
});

async function withHome<T>(prefix: string, body: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), prefix)); const previous = process.env.TEAMAI_HOME;
  process.env.TEAMAI_HOME = home;
  try { return await body(home); } finally { if (previous === undefined) delete process.env.TEAMAI_HOME; else process.env.TEAMAI_HOME = previous; }
}

test('a supervisor record naming a pid another program reused is not a running supervisor, and is taken over', { timeout: 10_000 }, async () => {
  await withHome('teamai-supervisor-record-', async (home) => {
    const { spawn } = await import('node:child_process');
    const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 200));
      await writeFile(join(home, 'supervisor.json'), JSON.stringify({ pid: stranger.pid }));
      assert.equal(await recordedSupervisorPid(), null, 'launchers do not wait for it');
      await claimSupervisorRecord();
      assert.equal(JSON.parse(await readFile(join(home, 'supervisor.json'), 'utf8')).pid, process.pid);
      assert.equal(stranger.exitCode, null, 'the other program is left alone');
    } finally { stranger.kill('SIGKILL'); }
  });
});

test('two supervisors claiming at once: exactly one gets the record', async () => {
  await withHome('teamai-supervisor-race-', async (home) => {
    // Both claimers are live supervisors (this process stands in for each), so
    // only the exclusive create decides; neither record can look stale.
    const results = await Promise.allSettled([claimSupervisorRecord(), claimSupervisorRecord()]);
    const won = results.filter((r) => r.status === 'fulfilled').length;
    const record = JSON.parse(await readFile(join(home, 'supervisor.json'), 'utf8')) as { pid: number };
    assert.equal(won, 1, `one claim wins: ${results.map((r) => r.status).join(', ')}`);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(record.pid, process.pid);
    assert.match(String(loser.reason), /already running \(pid \d+\)/);
  });
});

test('a supervisor started through an npm link is recognized by its start time', { timeout: 15_000 }, async () => {
  await withHome('teamai-supervisor-linked-', async (home) => {
    const { spawn } = await import('node:child_process');
    // `node /usr/local/bin/teamai supervise`: no dist/src/cli.js on the command line.
    const linked = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)', 'supervise'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 1_200));
      await writeFile(join(home, 'supervisor.json'), JSON.stringify({ pid: linked.pid, startedAt: new Date().toISOString() }));
      assert.equal(await recordedSupervisorPid(), linked.pid);
      await assert.rejects(claimSupervisorRecord(), /already running/);
    } finally { linked.kill('SIGKILL'); }
  });
});

test('a stale record judged by two supervisors at once is taken over by exactly one', async () => {
  await withHome('teamai-supervisor-reclaim-', async (home) => {
    const { spawn } = await import('node:child_process');
    const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await new Promise((r) => dead.once('exit', r));
    await writeFile(join(home, 'supervisor.json'), JSON.stringify({ pid: dead.pid, startedAt: new Date(Date.now() - 60_000).toISOString() }));
    const results = await Promise.allSettled([claimSupervisorRecord(), claimSupervisorRecord(), claimSupervisorRecord()]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, `one claim wins: ${results.map((r) => r.status).join(', ')}`);
    assert.equal(JSON.parse(await readFile(join(home, 'supervisor.json'), 'utf8')).pid, process.pid);
  });
});
