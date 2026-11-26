import { readFile, rm } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, atomicWriteText, loadConfig, paths } from './storage.js';
import type { TeamAIConfig } from './types.js';

const BEGIN = '# >>> teamai codex app >>>';
const END = '# <<< teamai codex app <<<';

export interface CodexAppBindingState {
  version: 1;
  phase: 'prepared' | 'bound';
  configPath: string;
  previousModelProviderLine: string | null;
  insertedModelProvider: boolean;
  blockSeparator: string;
}

interface ProviderLine { start: number; end: number; text: string; value: string }

function topLevelProvider(contents: string): ProviderLine | null {
  const firstTable = contents.search(/^\s*\[/m);
  const top = contents.slice(0, firstTable < 0 ? contents.length : firstTable);
  // TOML allows the bare key or either quoted form; all three are the same key.
  const matches = [...top.matchAll(/^[ \t]*(?:model_provider|"model_provider"|'model_provider')[ \t]*=[ \t]*("[^"]*"|'[^']*')[^\r\n]*(?:\r?\n|$)/gm)];
  if (matches.length > 1) throw new Error('Codex config has more than one top-level model_provider');
  const match = matches[0];
  if (!match || match.index === undefined) return null;
  return { start: match.index, end: match.index + match[0].length, text: match[0], value: match[1]!.slice(1, -1) };
}

function managedBlock(config: TeamAIConfig): string {
  const url = `http://${config.proxy.host}:${config.proxy.codexPort}/v1`;
  return [
    BEGIN,
    '[model_providers.teamai]',
    'name = "TeamAI Codex Relay"',
    `base_url = ${JSON.stringify(url)}`,
    'requires_openai_auth = false',
    `experimental_bearer_token = ${JSON.stringify(config.proxy.clientToken)}`,
    'wire_api = "responses"',
    'request_max_retries = 0',
    'stream_max_retries = 5',
    'stream_idle_timeout_ms = 1800000',
    END,
  ].join('\n');
}

function stripManagedBlock(contents: string): { contents: string; found: boolean; appended: boolean } {
  const begin = contents.indexOf(BEGIN);
  if (begin < 0) return { contents, found: false, appended: false };
  if (contents.indexOf(BEGIN, begin + BEGIN.length) >= 0) throw new Error('Codex config has more than one TeamAI managed block');
  const endMarker = contents.indexOf(END, begin + BEGIN.length);
  if (endMarker < 0) throw new Error('Codex config has an incomplete TeamAI managed block');
  const start = contents.lastIndexOf('\n', begin - 1) + 1;
  const markerEnd = endMarker + END.length;
  const newline = contents.indexOf('\n', markerEnd);
  const end = newline < 0 ? contents.length : newline + 1;
  return { contents: contents.slice(0, start) + contents.slice(end), found: true, appended: end === contents.length };
}

export function bindCodexAppConfig(contents: string, config: TeamAIConfig, configPath = ''): { contents: string; state: CodexAppBindingState } {
  const stripped = stripManagedBlock(contents);
  if (stripped.found) throw new Error('Codex config is already managed by TeamAI; use the bind command to refresh it');
  // Judge on the parsed file first: an invalid file is left alone, and a teamai
  // provider defined in any TOML spelling is a conflict. The edit below then
  // works line by line, which multi-line strings, escaped keys and inline or
  // dotted model_providers definitions can defeat, so those are refused too;
  // the parse of the result is the final guard.
  let original: Record<string, unknown>;
  try { original = parse(contents) as Record<string, unknown>; } catch (error) { throw new Error(`Codex config is not valid TOML (${(error as Error).message.split('\n')[0]}); fix it before binding`); }
  const providersTable = original.model_providers;
  if (providersTable && typeof providersTable === 'object' && 'teamai' in providersTable) throw new Error('model_providers.teamai already exists outside the managed block');
  if (/"""|'''/.test(contents)) throw new Error('Codex config uses multi-line strings; add the TeamAI provider by hand');
  if (/^[ \t]*(?:\[[^\n]*)?"[^"\n]*\\/m.test(contents)) throw new Error('Codex config uses escaped quoted keys or table names; add the TeamAI provider by hand');
  if (/^[ \t]*(?:model_providers|"model_providers"|'model_providers')[ \t]*[.=]/m.test(contents)) throw new Error('Codex config defines model_providers inline or with dotted keys; add the TeamAI provider by hand');
  // Same table however it is spelled: quoted segments, inner spaces, a trailing comment.
  if (/^[ \t]*\[[ \t]*(?:model_providers|"model_providers"|'model_providers')[ \t]*\.[ \t]*(?:teamai|"teamai"|'teamai')[ \t]*\][ \t]*(?:#.*)?$/m.test(contents)) throw new Error('model_providers.teamai already exists outside the managed block');

  const existing = topLevelProvider(contents);
  let next: string;
  if (existing) next = contents.slice(0, existing.start) + `model_provider = "teamai"${existing.text.endsWith('\n') ? '\n' : ''}` + contents.slice(existing.end);
  else next = `model_provider = "teamai"\n${contents ? '\n' : ''}${contents}`;

  const separator = next && !next.endsWith('\n\n') ? (next.endsWith('\n') ? '\n' : '\n\n') : '';
  const result = `${next}${separator}${managedBlock(config)}\n`;
  // The edit is textual, so its outcome is checked on the parsed result: it must
  // be valid TOML that selects TeamAI, or the original file stays untouched.
  let parsed: Record<string, unknown>;
  try { parsed = parse(result) as Record<string, unknown>; } catch (error) { throw new Error(`Binding would produce invalid Codex config (${(error as Error).message.split('\n')[0]}); add the TeamAI provider by hand`); }
  if (parsed.model_provider !== 'teamai') throw new Error('Binding would not select the TeamAI provider; add it by hand');
  return {
    contents: result,
    state: { version: 1, phase: 'prepared', configPath, previousModelProviderLine: existing?.text ?? null, insertedModelProvider: !existing, blockSeparator: separator },
  };
}

export function unbindCodexAppConfig(contents: string, state: CodexAppBindingState): string {
  const stripped = stripManagedBlock(contents);
  if (!stripped.found) throw new Error('Codex config does not contain the TeamAI managed block');
  let next = stripped.contents;
  if (stripped.appended && state.blockSeparator && next.endsWith(state.blockSeparator)) next = next.slice(0, -state.blockSeparator.length);
  const current = topLevelProvider(next);
  if (current?.value !== 'teamai') return next;
  if (state.insertedModelProvider) {
    next = next.slice(0, current.start) + next.slice(current.end);
    if (next.startsWith('\n')) next = next.slice(1);
    return next;
  }
  if (!state.previousModelProviderLine) throw new Error('Codex App binding state is missing the previous provider');
  return next.slice(0, current.start) + state.previousModelProviderLine + next.slice(current.end);
}

function configPath(): string { return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'); }

async function optionalText(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}

async function bindingState(): Promise<CodexAppBindingState | null> {
  try { return JSON.parse(await readFile(paths().codexAppBinding, 'utf8')) as CodexAppBindingState; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function bindCodexApp(): Promise<string> {
  const target = configPath();
  let contents = await optionalText(target);
  const previous = await bindingState();
  if (previous) {
    if (previous.configPath !== target) throw new Error(`TeamAI is already bound to a different Codex config: ${previous.configPath}`);
    if (contents.includes(BEGIN)) contents = unbindCodexAppConfig(contents, previous);
    else if (previous.phase === 'bound') throw new Error('Codex App binding state exists but its managed config block is missing');
    else await rm(paths().codexAppBinding, { force: true });
  }
  const result = bindCodexAppConfig(contents, await loadConfig(), target);
  await atomicWrite(paths().codexAppBinding, result.state);
  let written = false;
  try {
    await atomicWriteText(target, result.contents);
    written = true;
    await atomicWrite(paths().codexAppBinding, { ...result.state, phase: 'bound' });
  } catch (error) {
    // Once the config is written, the prepared state is the only record of the
    // provider it replaced: keep it (unbind accepts a prepared state). Before
    // that, the config on disk is still the one the previous state describes.
    if (!written) {
      if (previous) await atomicWrite(paths().codexAppBinding, previous).catch(() => {});
      else await rm(paths().codexAppBinding, { force: true });
    }
    throw error;
  }
  return target;
}

export async function unbindCodexApp(): Promise<string> {
  const state = await bindingState();
  if (!state) throw new Error('Codex App is not bound to TeamAI');
  const contents = await optionalText(state.configPath);
  if (!contents.includes(BEGIN) && state.phase === 'prepared') { await rm(paths().codexAppBinding, { force: true }); return state.configPath; }
  await atomicWriteText(state.configPath, unbindCodexAppConfig(contents, state));
  await rm(paths().codexAppBinding, { force: true });
  return state.configPath;
}

export async function codexAppStatus(): Promise<{ bound: boolean; configPath: string }> {
  const target = configPath(); const state = await bindingState(); const contents = await optionalText(target);
  const managed = contents.includes(BEGIN) && contents.includes(END) && topLevelProvider(contents)?.value === 'teamai';
  return { bound: Boolean(state?.phase === 'bound' && state.configPath === target && managed), configPath: target };
}
