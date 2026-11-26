import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { atomicWriteText } from '../src/storage.js';

test('atomicWriteText writes nothing when the file changed after it was read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamai-text-')); const file = join(dir, 'config.toml');
  await writeFile(file, 'model_provider = "openai"\n');
  const read = await readFile(file, 'utf8');
  // Another program saves the file between the read and the write.
  await writeFile(file, 'model_provider = "openai"\nmodel = "edited elsewhere"\n');
  const written = await atomicWriteText(file, 'model_provider = "teamai"\n', async () => await readFile(file, 'utf8') === read);
  assert.equal(written, false);
  assert.equal(await readFile(file, 'utf8'), 'model_provider = "openai"\nmodel = "edited elsewhere"\n', 'the other program\'s edit is kept');
  assert.deepEqual(await readdir(dir), ['config.toml'], 'no temp file is left behind');
  assert.equal(await atomicWriteText(file, 'x\n', async () => true), true);
  assert.equal(await readFile(file, 'utf8'), 'x\n');
});
