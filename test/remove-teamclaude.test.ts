import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'remove-teamclaude.mjs');
const skip = process.platform === 'win32' ? 'uses the POSIX npm global layout' : false;
const URL = 'http://localhost:3499';

// A stand-in for teamclaude-cloud: `server` idles, `stop` ends it and clears the
// route the way the real one does, `route off` clears the route. Calls are logged.
const STUB = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [cmd, sub] = process.argv.slice(2);
if (cmd !== 'server') appendFileSync(process.env.STUB_LOG, [cmd, sub].filter(Boolean).join(' ') + '\\n');
const settings = process.env.HOME + '/.claude/settings.json';
const clearRoute = () => { const j = JSON.parse(readFileSync(settings, 'utf8')); delete j.env.ANTHROPIC_BASE_URL; writeFileSync(settings, JSON.stringify(j, null, 2) + '\\n'); };
if (cmd === 'server') setInterval(() => {}, 1000);
if (cmd === 'stop') { process.kill(Number(readFileSync(process.env.STUB_PID, 'utf8')), 'SIGTERM'); clearRoute(); }
if (cmd === 'route' && sub === 'off') clearRoute();
`;

interface Box { root: string; env: NodeJS.ProcessEnv; pkg: string; skill: string; settings: string; log: string; accounts: string }

function sandbox(t: TestContext, { installed = true, route = true, skill = true } = {}): Box {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'teamai-rmtc-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.config'));
  mkdirSync(bin);
  // Only node and npm on PATH, so a real teamclaude elsewhere stays out of sight.
  const npm = join(dirname(process.execPath), 'npm');
  assert.ok(existsSync(npm), `npm next to node: ${npm}`);
  symlinkSync(process.execPath, join(bin, 'node'));
  symlinkSync(realpathSync(npm), join(bin, 'npm'));
  const settings = join(home, '.claude', 'settings.json');
  writeFileSync(settings, JSON.stringify({ env: route ? { FOO: '1', ANTHROPIC_BASE_URL: URL } : { FOO: '1' } }, null, 2) + '\n');
  const accounts = join(home, '.config', 'teamclaude.json');
  writeFileSync(accounts, JSON.stringify({ proxy: { port: 3499 }, accounts: [] }) + '\n');
  const pkg = join(root, 'npm', 'lib', 'node_modules', 'teamclaude-cloud');
  if (installed) {
    mkdirSync(join(pkg, 'src'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'teamclaude-cloud', version: '9.9.9', type: 'module' }));
    writeFileSync(join(pkg, 'src', 'index.js'), STUB);
  }
  const skillDir = join(home, '.claude', 'skills', 'teamclaude');
  if (skill) {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: teamclaude\n---\n');
    writeFileSync(join(skillDir, 'route.mjs'), '');
  }
  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
    npm_config_prefix: join(root, 'npm'), STUB_LOG: join(root, 'stub.log'), STUB_PID: join(root, 'server.pid'),
  };
  return { root, env, pkg, skill: skillDir, settings, log: env.STUB_LOG, accounts };
}

const run = (box: Box, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { env: box.env, encoding: 'utf8', timeout: 120000 });
const stubCalls = (box: Box) => (existsSync(box.log) ? readFileSync(box.log, 'utf8') : '');
const baseUrl = (box: Box) => JSON.parse(readFileSync(box.settings, 'utf8')).env.ANTHROPIC_BASE_URL;

function idle(t: TestContext, box: Box, file: string, args: string[] = []) {
  const child = spawn(process.execPath, [file, ...args], { env: box.env, stdio: 'ignore' });
  t.after(() => { child.kill('SIGKILL'); });
  return child;
}

test('says so when TeamClaude is not there', { skip }, (t) => {
  const box = sandbox(t, { installed: false, route: false, skill: false });
  const r = run(box);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /nothing to remove/);
});

test('--check lists what is left and changes nothing', { skip }, (t) => {
  const box = sandbox(t);
  const r = run(box, '--check');
  assert.equal(r.status, 10, r.stdout + r.stderr);
  assert.match(r.stdout, /sends Claude Code to http:\/\/localhost:3499/);
  assert.equal(baseUrl(box), URL);
  assert.ok(existsSync(box.pkg) && existsSync(box.skill));
  assert.equal(stubCalls(box), '');
});

test('clears a leftover route, removes the skill and the package, keeps the accounts', { skip }, (t) => {
  const box = sandbox(t);
  const r = run(box);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(stubCalls(box), 'route off\n');
  assert.deepEqual(JSON.parse(readFileSync(box.settings, 'utf8')).env, { FOO: '1' });
  assert.ok(!existsSync(box.skill), 'skill removed');
  assert.ok(!existsSync(box.pkg), 'package removed');
  assert.ok(existsSync(box.accounts), 'accounts kept');
});

test('leaves a skill folder that holds files TeamClaude did not write', { skip }, (t) => {
  const box = sandbox(t, { route: false });
  writeFileSync(join(box.skill, 'notes.md'), 'mine');
  const r = run(box);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /did not put there/);
  assert.ok(existsSync(join(box.skill, 'notes.md')));
});

test('reports a leftover Codex block without editing it, and keeps the package for `teamclaude codex off`', { skip }, (t) => {
  const box = sandbox(t, { route: false });
  const codex = join(box.env.HOME!, '.codex', 'config.toml');
  mkdirSync(dirname(codex));
  const text = '# >>> teamclaude: route Codex through the TeamClaude proxy (teamclaude codex on|off) >>>\nmodel_provider = "teamclaude"\n# <<< teamclaude <<<\n';
  writeFileSync(codex, text);
  const r = run(box);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /teamclaude codex off/);
  assert.equal(readFileSync(codex, 'utf8'), text);
  assert.ok(existsSync(box.pkg), 'package kept');
});

test('does not stop a running server while Claude Code runs, unless --force', { skip }, async (t) => {
  const box = sandbox(t);
  const server = idle(t, box, join(box.pkg, 'src', 'index.js'), ['server']);
  writeFileSync(box.env.STUB_PID!, String(server.pid));
  const claude = join(box.root, 'claude');
  writeFileSync(claude, 'setInterval(() => {}, 1000);\n');
  idle(t, box, claude);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const refused = run(box);
  assert.equal(refused.status, 3, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /Claude Code process/);
  assert.equal(stubCalls(box), '');
  assert.equal(server.exitCode, null, 'server still running');

  const forced = run(box, '--force');
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.equal(stubCalls(box), 'stop\n');
  assert.equal(baseUrl(box), undefined);
  assert.ok(!existsSync(box.pkg), 'package removed');
});
