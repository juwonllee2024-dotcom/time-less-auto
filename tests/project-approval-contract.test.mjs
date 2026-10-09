import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'background.js'), 'utf8');
const engine = fs.readFileSync(path.join(import.meta.dirname, '..', 'meeting-engine.mjs'), 'utf8');

test('background exposes project build and approval commands', () => {
  assert.match(source, /case 'BUILD_PROJECT_PLAN'/);
  assert.match(source, /case 'APPROVE_PROJECT_RUN'/);
  assert.match(source, /approval\.approved/);
});

test('start path checks approval before provider work', () => {
  const projectCheck = source.indexOf('projectPlan');
  const attach = source.indexOf('attachParticipant', projectCheck);
  assert.ok(projectCheck >= 0);
  assert.ok(attach > projectCheck);
  assert.match(source, /Project plan requires explicit approval/);
});

test('meeting defaults and migration keep project fields additive', () => {
  assert.match(engine, /projectPlan:\s*(?:options\.projectPlan\s*\|\|\s*)?null/);
  assert.match(engine, /sceneTurnCount/);
});
