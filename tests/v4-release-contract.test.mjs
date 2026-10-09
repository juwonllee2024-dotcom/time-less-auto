import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('Time Less Auto 2.0.0 keeps the existing YouTube project flow', () => {
  const manifest = JSON.parse(fs.readFileSync(`${root}/manifest.json`, 'utf8'));
  const readme = fs.readFileSync(`${root}/README.md`, 'utf8');
  assert.equal(manifest.name, 'Time Less Auto');
  assert.equal(manifest.version, '2.0.0');
  assert.match(readme, /Project Auto-Builder/);
  assert.match(readme, /역할|role guidance/i);
  assert.match(readme, /Scene Contract/i);
  assert.match(readme, /SCENE_TRANSITION/);
  assert.match(readme, /explicit approval/);
  assert.match(readme, /Loop Guard/i);
  assert.match(readme, /실제.*PNG/);
  assert.match(readme, /유튜브/);
  assert.match(readme, /무인도/);
  assert.match(readme, /매일 예약|daily scheduling/);
  assert.match(readme, /업로드|automatic upload/);
});
