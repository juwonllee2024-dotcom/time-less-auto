import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const background = fs.readFileSync(path.join(import.meta.dirname, '..', 'background.js'), 'utf8');

test('background exposes the V2 autopilot commands and fallback path', () => {
  assert.match(background, /START_AUTOPILOT/);
  assert.match(background, /GET_AUTOPILOT_STATE/);
  assert.match(background, /buildLocalSkeletonProjectPlan/);
  assert.match(background, /PLAN_FALLBACK_USED/);
  assert.match(background, /extractPlanEnvelope/);
});

test('background persists the skeleton before sending a plan request', () => {
  const skeleton = background.indexOf('buildLocalSkeletonProjectPlan');
  const planSend = background.indexOf('SEND_TLA_PLAN_PROMPT');
  assert.ok(skeleton >= 0);
  assert.ok(planSend > skeleton);
  assert.match(background, /createAutopilotRun/);
});

test('project build expands participant cards before applying generated roles', () => {
  const buildStart = background.indexOf('async function buildProjectRun');
  const roleApply = background.indexOf('applyProjectRoles', buildStart);
  assert.ok(buildStart >= 0);
  assert.ok(roleApply > buildStart);
  assert.match(background.slice(buildStart, roleApply), /ensureParticipantSlots/);
});

test('background exposes reset and resume recovery for paused autopilot runs', () => {
  assert.match(background, /case 'RESET_AUTOPILOT'/);
  assert.match(background, /async function resetAutopilot/);
  assert.match(background, /resumeState === 'PLAN_VALIDATED'/);
  assert.match(background, /resumeState === 'CAPTURE_QUEUED'/);
});
