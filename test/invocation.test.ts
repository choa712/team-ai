import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { launcherName, resolveInvocation } from '../src/invocation.js';

test('a launcher linked by name on macOS and Linux runs its command', () => {
  assert.deepEqual(resolveInvocation('/opt/homebrew/bin/taic', ['--resume']), ['run', 'claude', '--resume']);
  assert.deepEqual(resolveInvocation('/Users/me/.nvm/versions/node/v22/bin/tax', ['resume']), ['run', 'codex', 'resume']);
  assert.deepEqual(resolveInvocation('/usr/local/bin/tai', []), ['start']);
  assert.deepEqual(resolveInvocation('/usr/local/bin/tag', ['-p', 'hi']), ['run', 'grok', '-p', 'hi']);
});

test('a launcher started by an npm Windows shim is named by its own file', () => {
  // cmd-shim runs `node "%dp0%\node_modules\teamai-cli\dist\src\bin\tax.js" %*`.
  assert.deepEqual(resolveInvocation('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\teamai-cli\\dist\\src\\bin\\tax.js', ['resume']), ['run', 'codex', 'resume']);
  assert.deepEqual(resolveInvocation('C:\\npm\\node_modules\\teamai-cli\\dist\\src\\bin\\taic.js', []), ['run', 'claude']);
  assert.deepEqual(resolveInvocation('C:\\npm\\node_modules\\teamai-cli\\dist\\src\\bin\\TAI.JS', []), ['start']);
});

test('teamai itself and unknown names pass their arguments through', () => {
  assert.deepEqual(resolveInvocation('/usr/local/bin/teamai', ['status']), ['status']);
  assert.deepEqual(resolveInvocation('C:\\npm\\node_modules\\teamai-cli\\dist\\src\\cli.js', ['status']), ['status']);
  assert.deepEqual(resolveInvocation(undefined, ['help']), ['help']);
  assert.deepEqual(resolveInvocation('/x/constructor', ['status']), ['status']);
  assert.equal(launcherName('/x/tac'), 'tac');
  assert.deepEqual(resolveInvocation('/x/tac', ['status']), ['status'], 'tac is coreutils here; the Claude launcher is taic');
});

test('every launcher in package.json has a file of its own', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { bin: Record<string, string> };
  for (const name of ['tai', 'taic', 'tax', 'tag']) {
    assert.equal(pkg.bin[name], `dist/src/bin/${name}.js`, `${name} must not share cli.js, or a Windows shim cannot tell it apart`);
    const source = readFileSync(new URL(`../src/bin/${name}.ts`, import.meta.url), 'utf8');
    assert.match(source, /^#!\/usr\/bin\/env node\n/, `${name} keeps the shebang`);
    assert.match(source, /import '\.\.\/cli\.js';/);
  }
  assert.equal(pkg.bin.teamai, 'dist/src/cli.js');
});
