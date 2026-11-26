import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'remove-teamclaude.mjs');
const skip = process.platform === 'win32' ? 'uses the POSIX npm global layout and ps' : false;
const URL = 'http://localhost:3499';
const REAL_PS = ['/bin/ps', '/usr/bin/ps'].find((p) => existsSync(p)) ?? '/bin/ps';

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
if (cmd === 'route' && sub === 'off') { if (process.env.STUB_ROUTE_FAIL) process.exit(1); clearRoute(); }
`;

// The script sees only this sandbox's processes, so a real TeamClaude or Claude
// Code on the machine running the tests cannot change the outcome. RMTC_PS_FILE
// replaces the listing outright, and RMTC_PS_EXIT makes it fail.
const PS = `#!/bin/sh
if [ -n "$RMTC_PS_FILE" ]; then cat "$RMTC_PS_FILE"; exit "\${RMTC_PS_EXIT:-0}"; fi
out=$(${REAL_PS} "$@") || exit $?
printf '%s\\n' "$out" | grep -F "$RMTC_ROOT" || true
`;

const SKILL_MD = '---\nname: teamclaude\n---\n';
const ROUTE_MJS = '// route\n';

interface Box { root: string; env: NodeJS.ProcessEnv; pkg: string; skill: string; settings: string; log: string; accounts: string }

function sandbox(t: TestContext, { installed = true, route = URL as string | null, skill = true, config = true, name = 'teamclaude-cloud' } = {}): Box {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'teamai-rmtc-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.config'));
  mkdirSync(bin);
  // Only node, npm and the ps wrapper ahead of the system tools, so a real
  // teamclaude elsewhere on PATH stays out of sight.
  const npm = join(dirname(process.execPath), 'npm');
  assert.ok(existsSync(npm), `npm next to node: ${npm}`);
  symlinkSync(process.execPath, join(bin, 'node'));
  symlinkSync(realpathSync(npm), join(bin, 'npm'));
  writeFileSync(join(bin, 'ps'), PS);
  chmodSync(join(bin, 'ps'), 0o755);
  const settings = join(home, '.claude', 'settings.json');
  writeFileSync(settings, JSON.stringify({ env: route ? { FOO: '1', ANTHROPIC_BASE_URL: route } : { FOO: '1' } }, null, 2) + '\n');
  const accounts = join(home, '.config', 'teamclaude.json');
  if (config) writeFileSync(accounts, JSON.stringify({ proxy: { port: 3499 }, accounts: [] }) + '\n');
  const pkg = join(root, 'npm', 'lib', 'node_modules', ...name.split('/'));
  if (installed) {
    mkdirSync(join(pkg, 'src'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, version: '9.9.9', type: 'module' }));
    writeFileSync(join(pkg, 'src', 'index.js'), STUB);
    // The skill files the package ships; the copies in ~/.claude must match them.
    mkdirSync(join(pkg, 'skills', 'teamclaude'), { recursive: true });
    writeFileSync(join(pkg, 'skills', 'teamclaude', 'SKILL.md'), SKILL_MD);
    writeFileSync(join(pkg, 'skills', 'teamclaude', 'route.mjs'), ROUTE_MJS);
  }
  const skillDir = join(home, '.claude', 'skills', 'teamclaude');
  if (skill) {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD);
    writeFileSync(join(skillDir, 'route.mjs'), ROUTE_MJS);
  }
  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), RMTC_ROOT: root,
    npm_config_prefix: join(root, 'npm'), STUB_LOG: join(root, 'stub.log'), STUB_PID: join(root, 'server.pid'),
  };
  return { root, env, pkg, skill: skillDir, settings, log: env.STUB_LOG, accounts };
}

const run = (box: Box, args: string[] = [], extra: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...box.env, ...extra }, encoding: 'utf8', timeout: 120000 });
const stubCalls = (box: Box) => (existsSync(box.log) ? readFileSync(box.log, 'utf8') : '');
const baseUrl = (box: Box) => JSON.parse(readFileSync(box.settings, 'utf8')).env.ANTHROPIC_BASE_URL;

function fakeProcesses(box: Box, lines: string[]): NodeJS.ProcessEnv {
  const file = join(box.root, `ps-${lines.length}.txt`);
  writeFileSync(file, lines.join('\n') + '\n');
  return { RMTC_PS_FILE: file };
}

function idle(t: TestContext, box: Box, file: string, args: string[] = []) {
  const child = spawn(process.execPath, [file, ...args], { env: box.env, stdio: 'ignore' });
  t.after(() => { child.kill('SIGKILL'); });
  return child;
}

test('says so when TeamClaude is not there', { skip }, (t) => {
  const box = sandbox(t, { installed: false, route: null, skill: false });
  const r = run(box);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /nothing to remove/);
});

test('leaves a localhost address alone when nothing else of TeamClaude is there', { skip }, (t) => {
  // TeamAI's own default port is 3456 as well.
  const box = sandbox(t, { installed: false, route: 'http://localhost:3456', skill: false, config: false });
  const r = run(box);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /nothing to remove/);
  assert.equal(baseUrl(box), 'http://localhost:3456');
});

test('the kept account file alone does not make an address TeamClaude\'s', { skip }, (t) => {
  // What a machine looks like after the removal: only teamclaude.json is left.
  const box = sandbox(t, { installed: false, skill: false });
  const r = run(box);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /nothing to remove/);
  assert.equal(baseUrl(box), URL);
});

test('--check lists what is left and changes nothing', { skip }, (t) => {
  const box = sandbox(t);
  const r = run(box, ['--check']);
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

test('removes the package under its old name, @karpeleslab/teamclaude', { skip }, (t) => {
  const box = sandbox(t, { name: '@karpeleslab/teamclaude' });
  const r = run(box);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /@karpeleslab\/teamclaude 9\.9\.9 is installed/);
  assert.equal(stubCalls(box), 'route off\n');
  assert.ok(!existsSync(box.pkg), 'package removed');
});

test('leaves a skill folder that holds files TeamClaude did not write', { skip }, (t) => {
  const box = sandbox(t, { route: null });
  writeFileSync(join(box.skill, 'notes.md'), 'mine');
  const r = run(box);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /did not put there/);
  assert.ok(existsSync(join(box.skill, 'notes.md')));
});

test('leaves a skill folder whose backup-named entry is a folder of its own', { skip }, (t) => {
  const box = sandbox(t, { route: null });
  mkdirSync(join(box.skill, 'route.mjs.prev'));
  writeFileSync(join(box.skill, 'route.mjs.prev', 'mine.txt'), 'mine');
  const r = run(box);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /did not put there/);
  assert.equal(readFileSync(join(box.skill, 'route.mjs.prev', 'mine.txt'), 'utf8'), 'mine');
});

test('keeps a skill folder whose files were edited or backed up', { skip }, (t) => {
  const cases: Array<[string, string]> = [['SKILL.md', SKILL_MD + 'my note\n'], ['route.mjs.prev', 'my earlier copy\n']];
  for (const [file, text] of cases) {
    const box = sandbox(t, { route: null });
    writeFileSync(join(box.skill, file), text);
    const r = run(box);
    assert.equal(r.status, 3, `${file}: ${r.stdout}${r.stderr}`);
    assert.equal(readFileSync(join(box.skill, file), 'utf8'), text);
  }
});

test('does not stop the server while Codex sessions run and TeamClaude routes Codex', { skip }, async (t) => {
  const box = sandbox(t, { route: null });
  const codexConfig = join(box.env.HOME!, '.codex', 'config.toml');
  mkdirSync(dirname(codexConfig));
  writeFileSync(codexConfig, '# >>> teamclaude: route Codex through the TeamClaude proxy (teamclaude codex on|off) >>>\nmodel_provider = "teamclaude"\n# <<< teamclaude <<<\n');
  const server = idle(t, box, join(box.pkg, 'src', 'index.js'), ['server']);
  writeFileSync(box.env.STUB_PID!, String(server.pid));
  const codex = join(box.root, 'codex');
  writeFileSync(codex, 'setInterval(() => {}, 1000);\n');
  idle(t, box, codex);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const r = run(box);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /Not changed: sessions that may go through TeamClaude are running \(Codex pid \d+\)/);
  assert.equal(stubCalls(box), '');
  assert.equal(server.exitCode, null, 'server still running');
});

test('keeps the package when the route cannot be cleared, so `teamclaude route off` can be retried', { skip }, (t) => {
  const box = sandbox(t);
  const r = run(box, [], { STUB_ROUTE_FAIL: '1' });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.equal(stubCalls(box), 'route off\n');
  assert.match(r.stdout, /teamclaude route off/);
  assert.equal(baseUrl(box), URL);
  assert.ok(existsSync(box.pkg), 'package kept');
});

test('reports a leftover Codex block without editing it, and keeps the package for `teamclaude codex off`', { skip }, (t) => {
  const box = sandbox(t, { route: null });
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

test('counts Claude Code sessions, but not the Chrome bridge, an MCP server or the desktop app', { skip }, (t) => {
  const box = sandbox(t);
  const helpers = [
    '101 node /usr/local/lib/node_modules/teamclaude-cloud/src/index.js',
    '102 node /usr/local/bin/teamclaude run',
    '103 /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --chrome-native-host',
    '104 claude mcp serve',
    '105 /Applications/Claude.app/Contents/MacOS/Claude',
    '108 "C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\node_modules\\@karpeleslab\\teamclaude\\src\\index.js"',
    '114 node --enable-source-maps /opt/lib/node_modules/teamclaude-cloud/src/index.js server',
  ];
  const quiet = run(box, ['--dry-run'], fakeProcesses(box, helpers));
  assert.equal(quiet.status, 0, quiet.stdout + quiet.stderr);
  assert.match(quiet.stdout, /TeamClaude is running \(pid 101, 108, 114\)/);
  assert.match(quiet.stdout, /1 'teamclaude run' session\(s\) are open \(pid 102\)/);
  assert.match(quiet.stdout, /would run: teamclaude stop/);

  const sessions = [
    '106 claude --resume abc',
    '107 node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    // Only mentioning a helper word does not make a session a helper.
    '109 claude -p "explain mcp serve"',
    '110 /usr/local/bin/claude --resume x --chrome-native-host',
    '111 claude -p "explain claude mcp serve now"',
    // Mentioning TeamClaude's script does not make a session a TeamClaude server.
    '112 claude -p "inspect /tmp/teamclaude-cloud/src/index.js"',
    '113 claude -p "try node /tmp/teamclaude-cloud/src/index.js run"',
  ];
  const busy = run(box, ['--dry-run'], fakeProcesses(box, [...helpers, ...sessions]));
  assert.match(busy.stdout, /TeamClaude is running \(pid 101, 108, 114\)/);
  assert.match(busy.stdout, /Not changed: sessions that may go through TeamClaude are running \(Claude Code pid 106, 107, 109, 110, 111, 112, 113\)/);
  assert.doesNotMatch(busy.stdout, /would run/);
});

test('changes nothing when the processes cannot be listed, even with --force', { skip }, (t) => {
  const box = sandbox(t);
  const failing = { ...fakeProcesses(box, []), RMTC_PS_EXIT: '1' };
  const check = run(box, ['--check'], failing);
  assert.equal(check.status, 10, check.stdout + check.stderr);
  assert.match(check.stdout, /could not be listed/);
  const forced = run(box, ['--force'], failing);
  assert.equal(forced.status, 3, forced.stdout + forced.stderr);
  assert.equal(stubCalls(box), '');
  assert.equal(baseUrl(box), URL);
  assert.ok(existsSync(box.pkg) && existsSync(box.skill));
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
  assert.match(refused.stdout, /Not changed: sessions that may go through TeamClaude are running \(Claude Code pid \d+\)/);
  assert.equal(stubCalls(box), '');
  assert.equal(server.exitCode, null, 'server still running');

  const forced = run(box, ['--force']);
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.equal(stubCalls(box), 'stop\n');
  assert.equal(baseUrl(box), undefined);
  assert.ok(!existsSync(box.pkg), 'package removed');
});
