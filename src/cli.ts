#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, open, readFile, rm, writeFile, lstat, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { importAuth, loginClaude, loginCodex } from './auth.js';
import { captureDashboard } from './capture.js';
import { pullAccounts, pushAccounts } from './cloud-fleet.js';
import { DEFAULT_CLOUD_URL, linkFromTeamClaude, loadCloudLink, maskKey, saveCloudLink } from './cloud-sync.js';
import { bindCodexApp, codexAppStatus, unbindCodexApp } from './codex-app.js';
import { relayedCodexConfig } from './codex-config.js';
import { isRedactLevel } from './redact.js';
import { recordedServerPid, runServer, runningPid } from './runtime.js';
import { dataDir, loadConfig, loadState, saveConfig, upsertAccount, upsertAccounts } from './storage.js';
import { recordedSupervisorPid, runSupervisor } from './supervisor.js';
import { runTui } from './tui.js';
import type { ProviderId } from './types.js';

const invokedAs = basename(process.argv[1] || 'teamai');
const inputArgs = process.argv.slice(2);
const invocation = invokedAs === 'tai' ? ['start', ...inputArgs] : invokedAs === 'taic' ? ['run', 'claude', ...inputArgs] : invokedAs === 'tax' ? ['run', 'codex', ...inputArgs] : inputArgs;
const [command = 'help', ...args] = invocation;

function provider(value?: string): ProviderId { if (value !== 'claude' && value !== 'codex') throw new Error('Provider must be claude or codex'); return value; }
function flag(name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function hasFlag(name: string): boolean { return args.includes(name); }

async function main(): Promise<void> {
  switch (command) {
    case 'login': { const id = args[0] ? provider(args[0]) : await selectProvider('Login provider'); const result = id === 'claude' ? await loginClaude() : await loginCodex(); const account = await upsertAccount(id, result.label, result.credential); console.log(`Added ${id} account: ${account.label}`); break; }
    case 'import': {
      const id = provider(args[0]); const results = await importAuth(id, flag('--from'));
      if (hasFlag('--dry-run')) { console.log(`Would import ${results.length} ${id} account(s); source and TeamAI state unchanged`); break; }
      const accounts = await upsertAccounts(id, results);
      for (const account of accounts) console.log(`Imported ${id} account: ${account.label}`);
      break;
    }
    case 'accounts': await accounts(args[0] ? provider(args[0]) : undefined); break;
    case 'cloud': await cloudCommand(args[0]); break;
    case 'enable': await toggle(true); break;
    case 'disable': await toggle(false); break;
    case 'priority': await priority(); break;
    case 'server': await runServer(); break;
    case 'supervise': await runSupervisor(fileURLToPath(import.meta.url)); break;
    case 'codex-app': await codexApp(args[0]); break;
    case 'start': await ensureServer(); await runTui(); break;
    case 'status': await status(); break;
    case 'stop': await stop(); break;
    case 'restart': await stop(true); await ensureServer(); await runTui(); break;
    case 'session': await runClient(await selectProvider('Select session'), args.filter((x) => x !== '--')); break;
    case 'claude': await runClient('claude', args.filter((x) => x !== '--')); break;
    case 'codex': await runClient('codex', args.filter((x) => x !== '--')); break;
    case 'run': await runClient(provider(args[0]), args.slice(args[0] ? 1 : 0).filter((x) => x !== '--')); break;
    case 'tui': await runTui(); break;
    case 'capture': {
      const level = flag('--redact') ?? 'partial'; if (!isRedactLevel(level)) throw new Error('--redact must be partial, full or none');
      const result = await captureDashboard({ level, outDir: flag('--out'), width: process.stdout.columns });
      console.log(result.text); console.log(result.png); break;
    }
    case 'help': case '--help': case '-h': help(); break;
    default: throw new Error(`Unknown command: ${command}`);
  }
}

async function selectProvider(promptLabel: string): Promise<ProviderId> {
  if (!process.stdin.isTTY) throw new Error('Specify claude or codex explicitly in a non-interactive shell');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${promptLabel} — [1] Claude, [2] Codex: `)).trim().toLowerCase();
    if (answer === '1' || answer === 'c' || answer === 'claude') return 'claude';
    if (answer === '2' || answer === 'x' || answer === 'codex') return 'codex';
    throw new Error('Choose 1 for Claude or 2 for Codex');
  } finally { prompt.close(); }
}

async function accounts(filter?: ProviderId): Promise<void> {
  const config = await loadConfig(); const state = await loadState();
  const list = config.accounts.filter((x) => !filter || x.provider === filter);
  list.forEach((a, i) => { const s = state.accounts[a.credentialId]; const usage = s?.usage == null ? 'unknown' : `${Math.round(s.usage * 100)}%`; console.log(`${String(i + 1).padStart(2)}. ${a.provider.padEnd(7)} ${a.enabled ? 'on ' : 'off'} ${usage.padStart(7)} ${a.priority === null ? 'auto' : `#${a.priority}`} ${a.label}`); });
}
async function toggle(enabled: boolean): Promise<void> { const id = provider(args[0]); const name = args.slice(1).join(' '); const config = await loadConfig(); const account = config.accounts.find((a) => a.provider === id && (a.id === name || a.label === name)); if (!account) throw new Error('Account not found'); account.enabled = enabled; await saveConfig(config); console.log(`${enabled ? 'Enabled' : 'Disabled'} ${account.label}`); }
async function priority(): Promise<void> { const id = provider(args[0]); const rankRaw = args.at(-1); const name = args.slice(1, -1).join(' '); const config = await loadConfig(); const account = config.accounts.find((a) => a.provider === id && (a.id === name || a.label === name)); if (!account) throw new Error('Account not found'); if (!rankRaw || (rankRaw !== 'auto' && (!Number.isInteger(Number(rankRaw)) || Number(rankRaw) < 1))) throw new Error('Priority must be a positive integer or auto'); account.priority = rankRaw === 'auto' ? null : Number(rankRaw); await saveConfig(config); console.log(`Priority ${account.priority ?? 'auto'}: ${account.label}`); }

async function status(): Promise<void> {
  const recorded = await recordedServerPid(); const healthy = recorded ? await runningPid() : null; const supervisor = await recordedSupervisorPid();
  const managed = supervisor ? `, supervisor pid ${supervisor}` : '';
  console.log(healthy ? `TeamAI server running (pid ${healthy}${managed})` : recorded ? `TeamAI server unhealthy (pid ${recorded}${managed})` : `TeamAI server is stopped${managed}`);
  await accounts();
}
async function stop(quiet = false): Promise<void> {
  const pid = await recordedServerPid();
  if (!pid) { if (!quiet) console.log('TeamAI server is not running'); return; }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 30 && await recordedServerPid(); i++) await new Promise((r) => setTimeout(r, 100));
  if (!quiet) console.log(await recordedSupervisorPid() ? `Stopped TeamAI server ${pid}; the active supervisor will replace it` : `Stopped TeamAI server ${pid}`);
}

// TeamClaude Cloud as an account registry: pull and push accounts and tokens.
// Refreshing and switching stay with this relay (see cloud-sync.ts).
async function readStdin(): Promise<string> { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(chunk as Buffer); return Buffer.concat(chunks).toString('utf8').trim(); }
async function requireLink(): Promise<NonNullable<Awaited<ReturnType<typeof loadCloudLink>>>> { const link = await loadCloudLink(); if (!link) throw new Error('No cloud key linked. Run "teamai cloud link --from-teamclaude [PATH]" or "teamai cloud link --key-stdin"'); return link; }
// The running relay reads the link at startup; under a supervisor a stop is a restart.
async function reloadServer(reason: string): Promise<void> {
  if (!await recordedServerPid()) return;
  if (await recordedSupervisorPid()) { await stop(true); console.log(`Restarted the TeamAI server to ${reason}`); }
  else console.log(`Restart the TeamAI server ("teamai restart") to ${reason}`);
}
async function cloudCommand(action = 'status'): Promise<void> {
  if (action === 'link') {
    const url = flag('--url') ?? DEFAULT_CLOUD_URL;
    const link = hasFlag('--key-stdin') ? { url, key: await readStdin() } : await linkFromTeamClaude(flag('--from-teamclaude') ?? '~/.config/teamclaude.json');
    if (!link.key) throw new Error('Empty cloud key');
    await saveCloudLink(link); console.log(`Linked TeamClaude Cloud ${link.url} (key ${maskKey(link.key)})`);
    await reloadServer('start syncing tokens with the cloud'); return;
  }
  if (action === 'unlink') { await rm(join(dataDir(), 'cloud.json'), { force: true }); console.log('Unlinked TeamClaude Cloud'); await reloadServer('stop syncing tokens with the cloud'); return; }
  if (action === 'status') {
    const link = await loadCloudLink();
    console.log(link ? `TeamClaude Cloud: ${link.url} (key ${maskKey(link.key)}${process.env.TEAMAI_CLOUD_KEY ? ', from TEAMAI_CLOUD_KEY' : ''})` : 'TeamClaude Cloud: not linked');
    return;
  }
  if (action === 'pull') {
    const result = await pullAccounts(await requireLink());
    for (const label of result.added) console.log(`Added claude account: ${label}`);
    console.log(`Cloud pull: ${result.added.length} added, ${result.known} already here (their tokens stay with this relay)${result.tokenless ? `, ${result.tokenless} without a token skipped` : ''}`);
    if (result.added.length) await reloadServer('load the added accounts');
    return;
  }
  if (action === 'push') { console.log(`Cloud push: sent ${await pushAccounts(await requireLink())} claude account(s); the cloud keeps the newer token per account`); return; }
  throw new Error('cloud action must be link, unlink, status, pull or push');
}

async function codexApp(action = 'status'): Promise<void> {
  if (action === 'bind') { console.log(`Bound Codex App to TeamAI in ${await bindCodexApp()}`); return; }
  if (action === 'unbind') { console.log(`Restored Codex App routing in ${await unbindCodexApp()}`); return; }
  if (action === 'status') {
    const result = await codexAppStatus();
    console.log(`Codex App routing: ${result.bound ? 'TeamAI' : 'not bound'} (${result.configPath})`);
    return;
  }
  throw new Error('codex-app action must be bind, unbind or status');
}

// Start the relay on demand. This is what makes the launchers work whether or
// not a LaunchAgent (or any other supervisor) is managing the server: if
// nothing is listening, the client starts one itself.
async function ensureServer(): Promise<void> {
  if (await runningPid()) return;
  // Capture the child's output instead of discarding it: when startup fails,
  // its stderr is the only thing that says why (a port already taken, a bad
  // credential file), and "did not start" on its own sends the user hunting.
  const log = join(dataDir(), 'server-start.log');
  await mkdir(dirname(log), { recursive: true, mode: 0o700 });
  const handle = await open(log, 'w', 0o600);
  const cli = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [cli, 'server'], { detached: true, stdio: ['ignore', handle.fd, handle.fd], env: process.env });
  child.unref();
  await handle.close();
  for (let i = 0; i < 50; i++) { if (await runningPid()) return; await new Promise((r) => setTimeout(r, 100)); }
  let detail = '';
  try { detail = (await readFile(log, 'utf8')).trim(); } catch { /* nothing was written */ }
  throw new Error(detail ? `TeamAI server did not start: ${detail}` : `TeamAI server did not start (see ${log})`);
}

async function runClient(id: ProviderId, clientArgs: string[]): Promise<void> {
  const config = await loadConfig(); if (!config.accounts.some((a) => a.provider === id && a.enabled)) throw new Error(`No enabled ${id} accounts`); await ensureServer();
  if (id === 'claude') {
    const result = spawnSync('claude', clientArgs, { stdio: 'inherit', env: { ...process.env, ANTHROPIC_BASE_URL: `http://${config.proxy.host}:${config.proxy.claudePort}`, ANTHROPIC_AUTH_TOKEN: config.proxy.clientToken } });
    if (result.error) throw result.error; process.exitCode = result.status ?? 1; return;
  }
  const shadow = join(process.env.TEAMAI_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'teamai'), 'codex-home'); await mkdir(shadow, { recursive: true, mode: 0o700 });
  const originalHome = process.env.CODEX_HOME || join(homedir(), '.codex'); let original = ''; try { original = await readFile(join(originalHome, 'config.toml'), 'utf8'); } catch { /* optional */ }
  await writeFile(join(shadow, 'config.toml'), relayedCodexConfig(original, config.proxy.host, config.proxy.codexPort), { mode: 0o600 }); await chmod(shadow, 0o700);
  for (const name of ['skills', 'plugins', 'rules']) { const source = join(originalHome, name); const target = join(shadow, name); try { await lstat(target); } catch { try { await lstat(source); await symlink(source, target, 'dir'); } catch { /* optional */ } } }
  const overrides = [
    '-c', 'model_provider="teamai"',
    '-c', `model_providers.teamai.name="TeamAI Codex Relay"`,
    '-c', `model_providers.teamai.base_url="http://${config.proxy.host}:${config.proxy.codexPort}/v1"`,
    '-c', 'model_providers.teamai.env_key="TEAMAI_PROXY_TOKEN"',
    '-c', 'model_providers.teamai.wire_api="responses"',
    // Request-level failover (401/429/5xx) is the relay's job, so the client
    // must not retry the initial request and double up on account rotation.
    // Stream retries are different: a mid-body SSE cut from chatgpt.com is a
    // known transient that direct Codex hides with its default of 5 retries.
    // With 0 the first cut ended the turn as a hard "stream disconnected
    // before completion" error and the in-flight answer was lost (2026-09-19).
    '-c', 'model_providers.teamai.request_max_retries=0',
    '-c', 'model_providers.teamai.stream_max_retries=5',
    // Codex declares a stream dead after stream_idle_timeout_ms without an SSE
    // event (default 300s). A high-effort turn routinely thinks for longer than
    // that before its first token, so the default cut live turns mid-reasoning
    // and the client silently reconnected — which reads as a hung session, not
    // an error (2026-09-20, gpt-5.6-luna --effort max: a 15-minute turn cut and
    // retried, a second one lost after 10 minutes of silence). The relay
    // forwards upstream chunks unbuffered and injects no keepalives, so this
    // silence is upstream's and only the client's patience can cover it.
    '-c', 'model_providers.teamai.stream_idle_timeout_ms=1800000',
  ];
  const result = spawnSync('codex', [...overrides, ...clientArgs], { stdio: 'inherit', env: { ...process.env, CODEX_HOME: shadow, TEAMAI_PROXY_TOKEN: config.proxy.clientToken } });
  if (result.error) throw result.error; process.exitCode = result.status ?? 1;
}

function help(): void { console.log(`TeamAI — multi-account relay for Claude Code and Codex CLI

Usage:
  tai                                  Open the TeamAI dashboard
  taic [CLAUDE_ARGS...]                Start a relayed Claude Code session
  tax [CODEX_ARGS...]                  Start a relayed Codex session
  teamai claude [CLAUDE_ARGS...]       Start a relayed Claude Code session
  teamai codex [CODEX_ARGS...]         Start a relayed Codex session
  teamai session [CLIENT_ARGS...]      Choose Claude or Codex interactively
  teamai login [claude|codex]
  teamai import <claude|codex> [--from PATH] [--dry-run]
  teamai accounts [claude|codex]
  teamai start|restart|status|stop|supervise
  teamai codex-app bind|unbind|status
  teamai cloud link [--from-teamclaude PATH | --key-stdin] [--url URL]
  teamai cloud pull|push|status|unlink  Share accounts via TeamClaude Cloud;
                                       refresh and switching stay in TeamAI
  teamai enable|disable <provider> <account>
  teamai priority <provider> <account> <rank|auto>
  teamai capture [--redact partial|full|none] [--out DIR]
                                       Save the dashboard as .txt and .png,
                                       account addresses masked (no TTY needed)

Run "teamai start", then press 1 for Claude Code or 2 for Codex.`); }

main().catch((error) => { console.error(`teamai: ${(error as Error).message}`); process.exitCode = 1; });
