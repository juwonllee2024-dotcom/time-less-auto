import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProjectPlan,
  currentProjectScene,
  recordProjectTurn,
} from '../project-engine.mjs';

test('expands the deserted-island keyword into a complete ordered project', () => {
  const plan = buildProjectPlan('무인도', { now: 1000 });
  assert.equal(plan.keyword, '무인도');
  assert.equal(plan.scenes.length, 10);
  assert.equal(plan.scenes[0].title, '난파 후 섬 도착');
  assert.equal(plan.scenes.at(-1).title, '구조 또는 잔류');
  assert.ok(plan.totalExpectedTurns > 0);
  assert.ok(plan.totalMaxTurns >= plan.totalExpectedTurns);
  assert.equal(plan.approval.approved, false);
});

test('unknown keyword gets a complete five-scene scaffold containing the keyword', () => {
  const plan = buildProjectPlan('우주 정거장', { now: 1000 });
  assert.equal(plan.scenes.length, 5);
  assert.match(plan.premise, /우주 정거장/);
  assert.ok(plan.scenes.every((scene) => scene.targetTurns > 0 && scene.maxTurns >= scene.targetTurns));
});

test('scene progress advances at target turns and completes final scene at its target', () => {
  let plan = buildProjectPlan('무인도', { now: 1000 });
  const first = currentProjectScene(plan);
  for (let i = 0; i < first.targetTurns - 1; i += 1) {
    const step = recordProjectTurn(plan, { now: 1001 + i });
    plan = step.plan;
    assert.equal(step.transition, null);
  }
  const transition = recordProjectTurn(plan, { now: 2000 });
  assert.equal(transition.transition.from.index, 0);
  assert.equal(transition.transition.to.index, 1);
  assert.equal(transition.plan.currentSceneIndex, 1);
  assert.equal(transition.plan.sceneTurnCount, 0);
});
