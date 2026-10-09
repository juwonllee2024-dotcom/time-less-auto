import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const sidepanelPath = new URL('../sidepanel.js', import.meta.url);

test('sidepanel module parses as an ES module', () => {
  const source = fs.readFileSync(sidepanelPath, 'utf8');
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: source,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
