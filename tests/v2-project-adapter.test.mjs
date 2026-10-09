import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptAiProjectPlan, alignPlanToRoleSlots, buildLocalSkeletonProjectPlan, currentProjectScene } from '../project-engine.mjs';

test('local skeleton is complete before any web request', () => {
  const plan = buildLocalSkeletonProjectPlan('무인도', { now: 1000, requestId: 'run-1', requestNonce: 'nonce-1' });
  assert.equal(plan.source, 'local-fallback');
  assert.equal(plan.schemaVersion, '2.0');
  assert.ok(plan.roles.length >= 2);
  assert.ok(plan.scenes.length >= 5);
  assert.equal(plan.runPolicy.expectedTotalTurns, plan.scenes.reduce((sum, scene) => sum + scene.expectedTurns, 0));
  assert.equal(currentProjectScene(plan).index, 0);
});

test('AI adapter maps strict V2 fields without losing turn or emotion data', () => {
  const aiPlan = {
    schemaVersion: '2.0', requestId: 'run-2', requestNonce: 'nonce-2',
    project: { id: 'p', title: '한밤의 섬', premise: '두 사람이 갇혔다', language: 'ko', tone: '감정적', hook: '누가 거짓말하는가' },
    roles: [
      { id: 'r1', name: 'A', objective: '생존', personality: '차분', speechStyle: '간결', roleGuidance: '관찰', forbiddenBehaviors: [], escalationStyle: '침묵' },
      { id: 'r2', name: 'B', objective: '탈출', personality: '거침', speechStyle: '직설', roleGuidance: '반박', forbiddenBehaviors: [], escalationStyle: '폭발' },
    ],
    scenes: [{ id: 's1', index: 1, title: '폭풍 뒤', purpose: '관계 균열', setting: '부서진 야영지', participants: ['r1', 'r2'], opening: '천둥이 멎었다', goal: '책임을 묻는다', emotionStart: '불안', emotionPeak: '분노', expectedTurns: 3, maxTurns: 5, endCondition: '책임자가 드러난다', transitionInstruction: '단서를 따라간다' }],
    runPolicy: { mode: 'autonomous', turnUnit: 'provider_response', aiIntervalMs: 3000, expectedTotalTurns: 3, maxTotalTurns: 5 },
    capturePolicy: { mode: 'actual_response_only', retryLimit: 3, zipRequiredFiles: ['manifest.json', 'run-report.json', 'checksums.sha256'] },
  };
  const plan = adaptAiProjectPlan({ aiPlan, keyword: '한밤의 섬', requestId: 'run-2', requestNonce: 'nonce-2', now: 2000 });
  assert.equal(plan.source, 'web-ai');
  assert.equal(plan.scenes[0].index, 0);
  assert.equal(plan.scenes[0].targetTurns, 3);
  assert.equal(plan.scenes[0].maxTurns, 5);
  assert.equal(plan.scenes[0].emotionStart, '불안');
  assert.equal(plan.scenes[0].emotionPeak, '분노');
  assert.equal(plan.totalExpectedTurns, 3);
});

test('role slots keep exact configured count without rewriting a scene cast', () => {
  const source = buildLocalSkeletonProjectPlan('무인도', { now: 1000, requestId: 'run-slots', requestNonce: 'nonce-slots' });
  const aligned = alignPlanToRoleSlots(source, [
    { roleId: 'role-a', participantId: 'p1', role: '생존 전문가', rolePrompt: '자원을 먼저 계산한다.' },
    { roleId: 'role-b', participantId: 'p2', role: '싸가지 없는 유학생', rolePrompt: '한국어를 무시하고 영어로만 반응한다.' },
    { roleId: 'role-c', participantId: 'p3', role: '겁 많은 촬영감독', rolePrompt: '감정을 숨기지 않는다.' },
  ]);
  assert.equal(aligned.roles.length, 3);
  assert.deepEqual(aligned.roles.map((role) => role.id), ['role-a', 'role-b', 'role-c']);
  assert.equal(aligned.roles[1].role, '싸가지 없는 유학생');
  assert.equal(aligned.roles[1].roleGuidance, '한국어를 무시하고 영어로만 반응한다.');
  assert.ok(aligned.scenes.every((scene) => scene.participants.includes('role-a') && scene.participants.includes('role-b')));
  assert.ok(aligned.scenes.every((scene) => !scene.participants.includes('role-c')));
  const retried = alignPlanToRoleSlots(aligned, [
    { roleId: 'role-a', participantId: 'p1', role: '생존 전문가', rolePrompt: '자원을 먼저 계산한다.' },
    { roleId: 'role-b', participantId: 'p2', role: '싸가지 없는 유학생', rolePrompt: '한국어를 무시하고 영어로만 반응한다.' },
    { roleId: 'role-c', participantId: 'p3', role: '겁 많은 촬영감독', rolePrompt: '감정을 숨기지 않는다.' },
  ]);
  assert.equal(retried.planHash, aligned.planHash);
});

test('scene-specific cast is preserved instead of forcing every role into every scene', () => {
  const source = {
    schemaVersion: '2.0',
    keyword: '무인도',
    roles: [
      { id: 'role-a', name: 'A', role: 'A' },
      { id: 'role-b', name: 'B', role: 'B' },
      { id: 'role-c', name: 'C', role: 'C' },
    ],
    scenes: [
      { id: 'scene-a', title: 'A only', participants: ['role-a'], expectedTurns: 2, maxTurns: 3 },
      { id: 'scene-b', title: 'B and C', participants: ['role-b', 'role-c'], expectedTurns: 2, maxTurns: 3 },
    ],
  };
  const aligned = alignPlanToRoleSlots(source, [
    { roleId: 'slot-a', participantId: 'p1', role: 'A' },
    { roleId: 'slot-b', participantId: 'p2', role: 'B' },
    { roleId: 'slot-c', participantId: 'p3', role: 'C' },
  ]);
  assert.deepEqual(aligned.scenes.map((scene) => scene.participants), [
    ['slot-a'],
    ['slot-b', 'slot-c'],
  ]);
});
