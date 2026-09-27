import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { bindCodexApp, bindCodexAppConfig, codexAppStatus, unbindCodexApp, unbindCodexAppConfig } from '../src/codex-app.js';
import { defaultConfig, paths, saveConfig } from '../src/storage.js';

const config = () => {
  const value = defaultConfig();
  value.proxy.codexPort = 3467;
  value.proxy.clientToken = 'tai-local-test-token';
  return value;
};

test('Codex App binding preserves unrelated TOML and restores the previous provider', () => {
  const original = '# user comment\nmodel_provider = "openai"\nmodel_reasoning_effort = "high"\n\n[projects."/tmp/example"]\ntrust_level = "trusted"\n';
  const bound = bindCodexAppConfig(original, config());
  assert.match(bound.contents, /^# user comment/m);
  assert.match(bound.contents, /^model_provider = "teamai"$/m);
  assert.match(bound.contents, /\[model_providers\.teamai\]/);
  assert.match(bound.contents, /base_url = "http:\/\/127\.0\.0\.1:3467\/v1"/);
  assert.match(bound.contents, /experimental_bearer_token = "tai-local-test-token"/);
  assert.match(bound.contents, /\[projects\."\/tmp\/example"\]/);
  assert.equal(unbindCodexAppConfig(bound.contents, bound.state), original);
});

test('Codex App unbind keeps a provider the user changed after binding', () => {
  const original = 'model_provider = "openai"\n';
  const bound = bindCodexAppConfig(original, config());
  const changed = bound.contents.replace('model_provider = "teamai"', 'model_provider = "custom"');
  const unbound = unbindCodexAppConfig(changed, bound.state);
  assert.match(unbound, /^model_provider = "custom"$/m);
  assert.doesNotMatch(unbound, /model_providers\.teamai/);
});

test('Codex App unbind removes a model provider that binding had inserted', () => {
  const original = '# comment\n\n[projects."/tmp/example"]\ntrust_level = "trusted"\n';
  const bound = bindCodexAppConfig(original, config());
  assert.equal(bound.state.insertedModelProvider, true);
  assert.equal(unbindCodexAppConfig(bound.contents, bound.state), original);
});

test('Codex App binding refuses to overwrite an unmanaged TeamAI provider table', () => {
  assert.throws(() => bindCodexAppConfig('[model_providers.teamai]\nname = "custom"\n', config()), /already exists outside the managed block/);
});

test('Codex App bind and unbind use restrictive files without touching unrelated config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-codex-app-')); const teamaiHome = join(root, 'teamai'); const codexHome = join(root, 'codex');
  const oldTeamai = process.env.TEAMAI_HOME; const oldCodex = process.env.CODEX_HOME;
  process.env.TEAMAI_HOME = teamaiHome; process.env.CODEX_HOME = codexHome;
  await mkdir(codexHome, { recursive: true });
  const original = '# preserve me\nmodel_provider = "openai"\n\n[mcp_servers.example]\ncommand = "example"\n';
  await writeFile(join(codexHome, 'config.toml'), original);
  const value = config(); await saveConfig(value);
  try {
    assert.equal(await bindCodexApp(), join(codexHome, 'config.toml'));
    assert.equal((await codexAppStatus()).bound, true);
    assert.equal((await stat(join(codexHome, 'config.toml'))).mode & 0o777, 0o600);
    assert.equal((await stat(paths().codexAppBinding)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(paths().codexAppBinding, 'utf8')).phase, 'bound');
    await unbindCodexApp();
    assert.equal(await readFile(join(codexHome, 'config.toml'), 'utf8'), original);
    await assert.rejects(access(paths().codexAppBinding));
  } finally {
    if (oldTeamai === undefined) delete process.env.TEAMAI_HOME; else process.env.TEAMAI_HOME = oldTeamai;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
  }
});

test('Codex App binding recognises a quoted model_provider key instead of adding a second one', () => {
  for (const key of ['"model_provider"', "'model_provider'"]) {
    const original = `${key} = "openai"\n`;
    const bound = bindCodexAppConfig(original, config());
    assert.equal(bound.contents.match(/model_provider["']?\s*=/g)?.length, 1);
    assert.equal(bound.state.insertedModelProvider, false);
    assert.equal(unbindCodexAppConfig(bound.contents, bound.state), original);
  }
});

test('Codex App binding refuses a TeamAI table however it is spelled', () => {
  for (const table of ['[model_providers."teamai"]', "[ model_providers . 'teamai' ]", '[model_providers.teamai] # mine']) {
    assert.throws(() => bindCodexAppConfig(`${table}\nname = "custom"\n`, config()), /already exists outside the managed block/, table);
  }
});

test('Codex App binding refuses config shapes a line edit cannot rewrite safely', () => {
  for (const original of ['model_providers = { teamai = { name = "x" } }\n', 'model_providers.teamai.name = "x"\n', 'model_provider = """\nopenai"""\n']) {
    assert.throws(() => bindCodexAppConfig(original, config()), /add the TeamAI provider by hand/, original);
  }
});
