import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { legacyPorts, listenersHealthy, recordedServerPid, runningPid } from '../src/runtime.js';
import { defaultConfig, paths, saveConfig } from '../src/storage.js';
import type { TeamAIConfig } from '../src/types.js';

const config = (proxy: Partial<TeamAIConfig['proxy']>): TeamAIConfig => ({ ...defaultConfig(), proxy: { ...defaultConfig().proxy, ...proxy } });
const defaults = defaultConfig().proxy;

test('health requires both control and provider listeners to be open', () => {
  assert.equal(listenersHealthy([{ listening: true }, { listening: true }]), true);
  assert.equal(listenersHealthy([{ listening: true }, { listening: false }]), false);
  assert.equal(listenersHealthy([{ listening: true }]), false, 'control-only is degraded');
});

test('a moved port still answers on the built-in default', () => {
  // The case this exists for: a session started before the config was edited
  // holds the old port in its environment and cannot be told about the new one.
  const moved = config({ claudePort: defaults.claudePort + 10, codexPort: defaults.codexPort + 10 });
  assert.deepEqual(legacyPorts(moved, 'claude'), [defaults.claudePort]);
  assert.deepEqual(legacyPorts(moved, 'codex'), [defaults.codexPort]);
});

test('an unmoved port lists nothing to alias', () => {
  assert.deepEqual(legacyPorts(config({}), 'claude'), []);
  assert.deepEqual(legacyPorts(config({}), 'codex'), []);
});

test('explicitly declared legacy ports are kept alongside the default', () => {
  const moved = config({ claudePort: 4000, legacyPorts: { claude: [3900, 3901] } });
  assert.deepEqual(legacyPorts(moved, 'claude'), [3900, 3901, defaults.claudePort]);
});

test('the live port is never aliased to itself, however it is listed', () => {
  const moved = config({ claudePort: 3900, legacyPorts: { claude: [3900, 3901] } });
  assert.equal(legacyPorts(moved, 'claude').includes(3900), false);
  // A config left on the default must not try to bind its own port twice.
  const same = config({ legacyPorts: { claude: [defaults.claudePort] } });
  assert.deepEqual(legacyPorts(same, 'claude'), []);
});

test('duplicate and invalid entries are dropped', () => {
  const moved = config({ claudePort: 4000, legacyPorts: { claude: [3900, 3900, 0, -1, 1.5] } });
  assert.deepEqual(legacyPorts(moved, 'claude'), [3900, defaults.claudePort]);
});

test('a live PID is unhealthy when the authenticated control port is not answering', async () => {
  const oldHome = process.env.TEAMAI_HOME;
  const home = await mkdtemp(join(tmpdir(), 'teamai-runtime-health-'));
  process.env.TEAMAI_HOME = home;
  const config = defaultConfig();
  config.proxy.controlPort = 0;
  const control = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${config.proxy.clientToken}`) { res.writeHead(401).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', pid: process.pid }));
  });
  try {
    await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve));
    const address = control.address(); assert(address && typeof address !== 'string'); config.proxy.controlPort = address.port;
    await saveConfig(config);
    await writeFile(paths().server, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
    assert.equal(await recordedServerPid(), process.pid);
    assert.equal(await runningPid(), process.pid);
    await new Promise<void>((resolve) => control.close(() => resolve()));
    assert.equal(await recordedServerPid(), process.pid, 'the process is still alive');
    assert.equal(await runningPid(), null, 'health requires the control endpoint, not only kill(pid, 0)');
  } finally {
    if (control.listening) await new Promise<void>((resolve) => control.close(() => resolve()));
    if (oldHome === undefined) delete process.env.TEAMAI_HOME; else process.env.TEAMAI_HOME = oldHome;
  }
});
