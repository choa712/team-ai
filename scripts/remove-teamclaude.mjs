#!/usr/bin/env node
// Stop and remove TeamClaude (npm package teamclaude-cloud, earlier
// @karpeleslab/teamclaude) on a machine that
// moves to TeamAI. TeamClaude routes Claude Code by writing ANTHROPIC_BASE_URL
// into ~/.claude/settings.json, and that file wins over the address taic passes:
// a leftover line sends TeamAI sessions to TeamClaude, or to a dead port once it
// stops. Its Claude port (3456) is also TeamAI's default.
//
//   node scripts/remove-teamclaude.mjs            stop it, clear its routing, uninstall
//   node scripts/remove-teamclaude.mjs --check    list what is left, change nothing
//   node scripts/remove-teamclaude.mjs --dry-run  print the plan, change nothing
//   node scripts/remove-teamclaude.mjs --force    go ahead while Claude Code runs
//
// Stopping TeamClaude cuts off every Claude session that goes through it, so a
// running server is only stopped when no Claude Code process is running, unless
// --force. When the processes cannot be listed nothing is changed, even with
// --force. The account file (teamclaude.json) is kept.
//
// Exit codes: 0 removed or nothing found, 3 not finished (the output says what is
// left), 10 --check found something, 2 bad option.

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const WIN = process.platform === 'win32';
const OPTIONS = ['--check', '--dry-run', '--force'];
const argv = process.argv.slice(2);
for (const arg of argv) {
  if (!OPTIONS.includes(arg)) { console.error(`unknown option: ${arg}`); process.exit(2); }
}
const CHECK = argv.includes('--check');
const DRY = argv.includes('--dry-run');
const FORCE = argv.includes('--force');

const say = (message) => console.log(`   ${message}`);
const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const pids = (list) => list.map((p) => p.pid).join(', ');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// npm is npm.cmd on Windows, and Node starts a .cmd only through a shell. The
// arguments are fixed words, so one command string is safe (and avoids DEP0190).
const npm = (args) => (WIN
  ? spawnSync(['npm.cmd', ...args].join(' '), { encoding: 'utf8', shell: true, timeout: 120000 })
  : spawnSync('npm', args, { encoding: 'utf8', timeout: 120000 }));

// Every process with its command line, or null when they cannot be listed: an
// unknown process table must not read as "no Claude session is running".
function listProcesses() {
  if (WIN) {
    const query = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress';
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20 });
    if (r.status !== 0) return null;
    try {
      const rows = JSON.parse(r.stdout);
      return (Array.isArray(rows) ? rows : [rows]).map((p) => ({ pid: p.ProcessId, cmd: String(p.CommandLine || p.Name || '') }));
    } catch { return null; }
  }
  const r = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').map((line) => line.match(/^\s*(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m[1]), cmd: m[2] }));
}

// Command lines are matched from their start: the executable, then the script or
// first argument. A prompt that only mentions a path or a word (claude -p "look at
// teamclaude-cloud/src/index.js") must not turn a session into something else.
// A token is either "quoted with spaces" or unquoted without spaces.
const token = (tail) => `(?:"[^"]*${tail}"|(?:[^"\\s]*[\\\\/])?${tail})`;
const NODE = token('node(?:\\.exe)?');
const TEAMCLAUDE_SCRIPT = token('(?:teamclaude-cloud[\\\\/]src[\\\\/]index\\.js|@karpeleslab[\\\\/]teamclaude[\\\\/]src[\\\\/]index\\.js|teamclaude)');
// The teamclaude program itself, as a server or as a `teamclaude run` session.
// Node options, with or without values, may sit between node and the script
// (node --require x.cjs …). The status probe below backs this match up.
const NODE_OPTIONS = '(?:\\s+(?:"[^"]*"|[^\\s"]+))*?';
const TEAMCLAUDE = new RegExp(`^${NODE}${NODE_OPTIONS}\\s+${TEAMCLAUDE_SCRIPT}(?=\\s|$)`, 'i');
const RUN = new RegExp(`^${NODE}${NODE_OPTIONS}\\s+${TEAMCLAUDE_SCRIPT}\\s+run(?:\\s|$)`, 'i');
// Claude Code and Codex sessions: their word anywhere. Matching too much only makes
// the removal wait, so these stay broad. Case-sensitive, so the desktop apps
// (Claude, Codex) do not count.
const CLAUDE = /(^|[\s\\/"])claude(\.exe)?("|\s|$)|claude-code[\\/]cli\.js/;
const CODEX = /(^|[\s\\/"])codex(\.exe|\.js)?("|\s|$)/;
// Helpers that stay up after every Claude Code window is closed and make no model
// requests: the Chrome extension bridge and `claude mcp serve`, as the first
// argument right after the claude executable (or after node and Claude's script).
const CLAUDE_EXE = `(?:${NODE}\\s+)?${token('(?:claude(?:\\.exe)?|cli\\.js)')}`;
const HELPER = new RegExp(`^${CLAUDE_EXE}\\s+(?:--chrome-native-host|mcp\\s+serve)(?:\\s|$)`);

function teamclaudeProcesses() {
  const list = listProcesses();
  if (!list) return null;
  const others = list.filter((p) => p.pid !== process.pid);
  const teamclaude = others.filter((p) => TEAMCLAUDE.test(p.cmd));
  return {
    servers: teamclaude.filter((p) => !RUN.test(p.cmd)),
    runs: teamclaude.filter((p) => RUN.test(p.cmd)),
    claudes: others.filter((p) => CLAUDE.test(p.cmd) && !TEAMCLAUDE.test(p.cmd) && !HELPER.test(p.cmd)),
    codexes: others.filter((p) => CODEX.test(p.cmd) && !TEAMCLAUDE.test(p.cmd) && !CLAUDE.test(p.cmd)),
  };
}

// A teamclaude command on PATH that this npm did not install.
function teamclaudeOnPath() {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const name of WIN ? ['teamclaude.cmd', 'teamclaude.ps1'] : ['teamclaude']) {
      if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  return null;
}

const home = homedir();
const npmRoot = (npm(['root', '-g']).stdout || '').trim();
// The package was renamed; the newer name's commands are the ones to run.
const installed = (npmRoot ? ['teamclaude-cloud', '@karpeleslab/teamclaude'] : [])
  .map((name) => ({ name, dir: join(npmRoot, ...name.split('/')) }))
  .map((p) => ({ ...p, json: readJson(join(p.dir, 'package.json')) }))
  .filter((p) => p.json);
const entry = installed.length ? join(installed[0].dir, 'src', 'index.js') : '';
const packageNames = installed.map((p) => p.name).join(' ') || 'teamclaude-cloud';
// The same paths teamclaude itself uses (src/config.js, skills/teamclaude/route.mjs,
// src/codex-config.js, scripts/postinstall.mjs).
const configPath = process.env.TEAMCLAUDE_CONFIG || join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'teamclaude.json');
const port = readJson(configPath)?.proxy?.port || 3456;
const teamclaudeUrl = `http://localhost:${port}`;
const settingsPath = process.env.CLAUDE_SETTINGS || join(home, '.claude', 'settings.json');
const codexPath = join(process.env.CODEX_HOME || join(home, '.codex'), 'config.toml');
const skillDir = join(process.env.HOME || home, '.claude', 'skills', 'teamclaude');

const configExisted = existsSync(configPath);
// A localhost address alone may be TeamAI's own (its default port is 3456 too),
// so it only counts as TeamClaude's while some other trace of TeamClaude is here.
let traces = false;
const sameUrl = (value) => traces && typeof value === 'string' && value.replace(/\/+$/, '') === teamclaudeUrl;
const claudeRouted = () => sameUrl(readJson(settingsPath)?.env?.ANTHROPIC_BASE_URL);
const codexRouted = () => readText(codexPath).includes('# >>> teamclaude:');
const skillPresent = () => existsSync(skillDir);
// The folder is removed only when it holds nothing but regular files that are
// byte-identical to the ones an installed TeamClaude package ships. An edited file
// or a .prev backup (postinstall keeps the user's earlier copy there) stays.
// Returns the file names, or null when anything else is there.
function teamclaudeSkillFiles() {
  try {
    if (!lstatSync(skillDir).isDirectory()) return null;
    const files = readdirSync(skillDir);
    const shipped = (f) => installed.some((p) => {
      try { return readFileSync(join(p.dir, 'skills', 'teamclaude', f)).equals(readFileSync(join(skillDir, f))); } catch { return false; }
    });
    const own = files.length > 0 && files.every((f) => /^(SKILL\.md|route\.mjs)$/.test(f) && lstatSync(join(skillDir, f)).isFile() && shipped(f));
    return own ? files : null;
  } catch { return null; }
}

// TeamClaude's own liveness test (its src/index.js): the status page answers with
// an accounts list and a switch threshold. It does not depend on how the process
// was started, so it catches a server the command-line match misses.
async function serverAnswers() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data?.accounts) && typeof data?.switchThreshold === 'number';
  } catch { return false; }
}

const procs = teamclaudeProcesses();
const answering = await serverAnswers();
const serverRunning = Boolean(procs?.servers.length) || answering;
const strayCommand = installed.length ? null : teamclaudeOnPath();
// The account file does not count: this script keeps it on purpose.
traces = Boolean(installed.length || strayCommand || skillPresent() || serverRunning || procs?.runs.length);
// Inside Claude Code (CLAUDECODE=1) the variable comes from settings.json, which
// is already covered above, not from the user's shell.
const shellRouted = sameUrl(process.env.ANTHROPIC_BASE_URL) && !process.env.CLAUDECODE;

const found = [];
if (!procs) found.push('the running processes could not be listed, so a running TeamClaude could be missed');
for (const p of installed) found.push(`${p.name} ${p.json.version} is installed in ${p.dir}`);
if (strayCommand) found.push(`a teamclaude command is at ${strayCommand}, outside this npm's global folder`);
if (procs?.servers.length) found.push(`TeamClaude is running (pid ${pids(procs.servers)})`);
else if (answering) found.push(`TeamClaude is running (it answers on port ${port})`);
if (procs?.runs.length) found.push(`${procs.runs.length} 'teamclaude run' session(s) are open (pid ${pids(procs.runs)})`);
if (claudeRouted()) found.push(`${settingsPath} sends Claude Code to ${teamclaudeUrl}`);
if (codexRouted()) found.push(`${codexPath} sends Codex to TeamClaude`);
if (skillPresent()) found.push(`the /teamclaude skill is at ${skillDir}`);
if (shellRouted) found.push(`this shell has ANTHROPIC_BASE_URL=${teamclaudeUrl}`);

if (CHECK) {
  if (!found.length) process.exit(0);
  console.log('   TeamClaude is still on this machine:');
  for (const item of found) say(`  - ${item}`);
  process.exit(10);
}
if (!found.length) { say('TeamClaude not found; nothing to remove.'); process.exit(0); }
say('Found:');
for (const item of found) say(`  - ${item}`);

// A running server is what live sessions depend on. Everything else (the
// settings line, the package, the skill) only affects sessions started later.
// --force vouches for the Claude sessions, not for a process table nobody saw.
if (!procs) {
  say('');
  say('Not changed: the running processes could not be listed, so a running TeamClaude cannot be ruled out.');
  process.exit(DRY ? 0 : 3);
}
// Codex sessions depend on the server too while TeamClaude routes Codex.
const dependents = serverRunning ? [
  procs.claudes.length && `Claude Code pid ${pids(procs.claudes)}`,
  codexRouted() && procs.codexes.length && `Codex pid ${pids(procs.codexes)}`,
].filter(Boolean) : [];
if (dependents.length && !FORCE) {
  say('');
  say(`Not changed: sessions that may go through TeamClaude are running (${dependents.join('; ')}).`);
  say('Stopping TeamClaude would cut them off.');
  say('Close all Claude Code and Codex windows and run this again. If none of them');
  say('uses TeamClaude (for example they all run through taic or tax), run it with --force.');
  process.exit(DRY ? 0 : 3);
}

const unfinished = [];
const teamclaude = (...args) => {
  if (DRY) { say(`would run: teamclaude ${args.join(' ')}`); return; }
  spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit', timeout: 60000 });
};

const where = (list) => (list?.length ? `pid ${pids(list)}` : `port ${port}`);
if (serverRunning) {
  if (entry) {
    teamclaude('stop');
    // A stopping server can take a moment to finish in-flight requests. It is gone
    // only when neither its process nor its status page is left.
    for (let i = 0; i < 20 && !DRY; i++) {
      const left = teamclaudeProcesses();
      if (left && !left.servers.length && !(await serverAnswers())) break;
      if (i === 19) unfinished.push(`TeamClaude is still running (${where(left?.servers)}): stop it, then run this again`);
      await sleep(500);
    }
  } else {
    unfinished.push(`TeamClaude is running (${where(procs.servers)}) but its package is not in this npm: stop it, then run this again`);
  }
}

if (!unfinished.length) {
  // When the line cannot be cleared, keep the package too, so `teamclaude route off`
  // is still there to retry.
  let routeLeft = false;
  if (claudeRouted()) {
    if (entry) teamclaude('route', 'off');
    routeLeft = DRY ? !entry : claudeRouted();
    if (routeLeft) {
      unfinished.push(entry
        ? `${settingsPath} still sends Claude Code to ${teamclaudeUrl}: run \`teamclaude route off\` (or delete that ANTHROPIC_BASE_URL line), then run this again`
        : `delete the ANTHROPIC_BASE_URL line from the "env" block of ${settingsPath}`);
    }
  }
  // TeamAI never edits ~/.codex (AGENTS.md). A graceful `teamclaude stop` takes
  // its block out; if one is left, keep the package so the user can run
  // `teamclaude codex off` and then this script again.
  const codexLeft = codexRouted();
  if (codexLeft) {
    unfinished.push(entry
      ? `${codexPath} still sends Codex to TeamClaude: run \`teamclaude codex off\`, then run this again`
      : `${codexPath} still sends Codex to TeamClaude: delete its "# >>> teamclaude" blocks`);
  }
  if (skillPresent()) {
    const files = teamclaudeSkillFiles();
    if (!files) unfinished.push(`${skillDir} holds something TeamClaude did not put there; left as is`);
    else if (DRY) say(`would remove ${skillDir}`);
    else {
      // File by file, then the now-empty folder: nothing is removed recursively.
      try {
        for (const f of files) unlinkSync(join(skillDir, f));
        rmdirSync(skillDir);
        say(`removed ${skillDir}`);
      } catch (err) { unfinished.push(`could not remove ${skillDir}: ${err.message}`); }
    }
  }
  const keepPackage = Boolean((codexLeft || routeLeft) && entry);
  let uninstallFailed = false;
  if (installed.length && !keepPackage) {
    if (DRY) say(`would run: npm rm -g ${packageNames}`);
    else {
      const r = npm(['rm', '-g', ...installed.map((p) => p.name), '--loglevel=error']);
      uninstallFailed = r.status !== 0 || installed.some((p) => existsSync(join(p.dir, 'package.json')));
      if (uninstallFailed) unfinished.push(`npm rm -g ${packageNames} failed: ${(r.stderr || r.error?.message || '').trim()}`);
      else say(`uninstalled ${packageNames}`);
    }
  }
  // Another Node install can carry its own copy; look again after uninstalling.
  const leftOnPath = keepPackage || uninstallFailed ? null : DRY ? strayCommand : teamclaudeOnPath();
  if (leftOnPath) unfinished.push(`a teamclaude command is still at ${leftOnPath}: uninstall it with the npm that installed it (npm rm -g teamclaude-cloud, or @karpeleslab/teamclaude for the old name)`);
  if (shellRouted) unfinished.push(`ANTHROPIC_BASE_URL=${teamclaudeUrl} comes from your shell profile or Windows environment variables: delete it there`);
}

if (configExisted) say(`kept ${configPath} (TeamClaude's accounts); delete it once TeamAI works`);
if (unfinished.length) {
  say('');
  say(DRY ? 'Would be left for you:' : 'Not finished:');
  for (const item of unfinished) say(`  - ${item}`);
}
if (DRY) process.exit(0);
if (unfinished.length) process.exit(3);
say('TeamClaude removed.');
