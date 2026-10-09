import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAutopilotRun,
  deriveAutopilotMetrics,
  markAutopilotFailed,
  transitionAutopilot,
} from '../autopilot-engine.mjs';

test('run begins with persisted skeleton and visible READY event', () => {
  const run = createAutopilotRun({
    runId: 'run-1',
    projectBrief: '무인도',
    plannerTabId: 12,
    skeletonPlan: { source: 'local-fallback', runPolicy: { expectedTotalTurns: 8, maxTotalTurns: 12 } },
    now: 1000,
  });
  assert.equal(run.state, 'READY');
  assert.equal(run.projectBrief, '무인도');
  assert.equal(run.events[0].type, 'RUN_CREATED');
});

test('invalid state transitions are rejected and valid planning transitions are accepted', () => {
  const run = createAutopilotRun({ runId: 'run-2', projectBrief: '섬', plannerTabId: 12, skeletonPlan: {}, now: 1000 });
  assert.throws(() => transitionAutopilot(run, 'RUNNING'), /Invalid autopilot transition/);
  const planned = transitionAutopilot(run, 'PLAN_REQUESTED', { plannerAttempt: 1 }, 1100);
  assert.equal(planned.state, 'PLAN_REQUESTED');
});

test('metrics count provider turns and verified captures separately', () => {
  const run = createAutopilotRun({ runId: 'run-3', projectBrief: '섬', plannerTabId: 12, skeletonPlan: { runPolicy: { expectedTotalTurns: 4, maxTotalTurns: 6 } }, now: 1000 });
  const measured = { ...run, metrics: { ...run.metrics, actualTurns: 3, successfulCaptures: 2, failedCaptures: 1, zipFiles: 4 } };
  assert.deepEqual(deriveAutopilotMetrics(measured), { expectedTurns: 4, maxTurns: 6, actualTurns: 3, successfulCaptures: 2, failedCaptures: 1, zipFiles: 4 });
});

test('run persists bounded role slots for deterministic tab mapping', () => {
  const run = createAutopilotRun({
    runId: 'run-slots',
    projectBrief: '무인도',
    plannerTabId: 12,
    roleSlots: [
      { roleId: 'role-a', participantId: 'p1', tabId: 21, provider: 'chatgpt', role: '생존 전문가', rolePrompt: '자원 계산' },
      { roleId: 'role-b', participantId: 'p2', tabId: 22, provider: 'claude', role: '유학생', rolePrompt: '영어만 사용' },
    ],
    now: 1000,
  });
  assert.deepEqual(run.roleSlots.map((slot) => ({ roleId: slot.roleId, participantId: slot.participantId, tabId: slot.tabId })), [
    { roleId: 'role-a', participantId: 'p1', tabId: 21 },
    { roleId: 'role-b', participantId: 'p2', tabId: 22 },
  ]);
});

test('failed runs preserve their last state and can explicitly re-enter pause for retry', () => {
  const run = createAutopilotRun({ runId: 'run-retry', projectBrief: '섬', plannerTabId: 12, now: 1000 });
  const requested = transitionAutopilot(run, 'PLAN_REQUESTED', {}, 1100);
  const failed = markAutopilotFailed(requested, { error: 'timeout', stage: 'PLAN_REQUEST', now: 1200 });
  assert.equal(failed.failedFrom, 'PLAN_REQUESTED');
  const paused = transitionAutopilot(failed, 'PAUSED', { pausedFrom: failed.failedFrom }, 1300);
  assert.equal(paused.state, 'PAUSED');
  assert.equal(paused.pausedFrom, 'PLAN_REQUESTED');
});
