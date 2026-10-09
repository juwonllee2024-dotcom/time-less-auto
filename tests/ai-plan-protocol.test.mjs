import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PLAN_MARKERS,
  buildPlanPrompt,
  buildPlanRepairPrompt,
  extractPlanEnvelope,
  validatePlanShape,
} from '../ai-plan-protocol.mjs';

const ids = { requestId: 'run-1', requestNonce: 'nonce-1' };
const candidate = {
  schemaVersion: '2.0',
  requestId: ids.requestId,
  requestNonce: ids.requestNonce,
  project: { id: 'project-1', title: '무인도', premise: '두 사람이 생존한다', language: 'ko', tone: '감정적', hook: '협력할 수 있을까' },
  roles: [
    { id: 'a', name: '생존자 A', objective: '살아남기', personality: '냉정', speechStyle: '짧게', roleGuidance: '현실적인 선택을 한다', forbiddenBehaviors: [], escalationStyle: '압박' },
    { id: 'b', name: '생존자 B', objective: '탈출하기', personality: '충동적', speechStyle: '직설적', roleGuidance: '감정이 먼저 나온다', forbiddenBehaviors: [], escalationStyle: '반발' },
  ],
  scenes: [{ id: 's1', index: 1, title: '도착', purpose: '관계 설정', setting: '해변', participants: ['a', 'b'], opening: '파도 소리가 들린다', goal: '첫 선택', emotionStart: '긴장', emotionPeak: '불안', expectedTurns: 2, maxTurns: 4, endCondition: '첫 선택이 나온다', transitionInstruction: '다음 위기로 이동' }],
  runPolicy: { mode: 'autonomous', turnUnit: 'provider_response', aiIntervalMs: 3500, expectedTotalTurns: 2, maxTotalTurns: 4 },
  capturePolicy: { mode: 'actual_response_only', retryLimit: 3, zipRequiredFiles: ['manifest.json', 'run-report.json', 'checksums.sha256'] },
};

test('prompt includes exact markers, IDs, JSON-only rules, and brief', () => {
  const prompt = buildPlanPrompt({ projectBrief: '무인도에서 싸우는 두 유학생', requestId: ids.requestId, requestNonce: ids.requestNonce });
  assert.match(prompt, new RegExp(PLAN_MARKERS.begin));
  assert.match(prompt, new RegExp(PLAN_MARKERS.end));
  assert.match(prompt, /schemaVersion/);
  assert.match(prompt, /run-1/);
  assert.match(prompt, /nonce-1/);
  assert.match(prompt, /무인도에서 싸우는 두 유학생/);
  assert.match(prompt, /JSON/);
});

test('plan prompt makes configured role slots exact and actionable', () => {
  const prompt = buildPlanPrompt({
    projectBrief: '무인도 상황극',
    requestId: ids.requestId,
    requestNonce: ids.requestNonce,
    roleSlots: [
      { roleId: 'role-a', role: '생존 전문가', rolePrompt: '자원을 계산한다.' },
      { roleId: 'role-b', role: '싸가지 없는 유학생', rolePrompt: '영어로만 반응한다.' },
      { roleId: 'role-c', role: '촬영감독', rolePrompt: '감정을 보여준다.' },
    ],
  });
  assert.match(prompt, /ROLE_SLOT_COUNT: 3/);
  assert.match(prompt, /role-a/);
  assert.match(prompt, /exactly 3 roles/i);
});

test('auto planner prompt permits AI-selected role count', () => {
  const prompt = buildPlanPrompt({ projectBrief: '무인도', requestId: ids.requestId, requestNonce: ids.requestNonce, autoRoleProvisioning: true });
  assert.match(prompt, /ROLE_SLOT_COUNT: AI_CHOICE/);
  assert.match(prompt, /2.*6.*unique roles/i);
  assert.doesNotMatch(prompt, /create exactly two roles/i);
});

test('receiver accepts only matching markers and nonce', () => {
  const text = `${PLAN_MARKERS.begin}\n${JSON.stringify(candidate)}\n${PLAN_MARKERS.end}`;
  const result = extractPlanEnvelope(text, ids);
  assert.equal(result.ok, true);
  assert.equal(result.candidate.requestNonce, ids.requestNonce);
  const stale = extractPlanEnvelope(text.replace('nonce-1', 'nonce-old'), ids);
  assert.equal(stale.ok, false);
  assert.ok(stale.errors.some((error) => error.code === 'NONCE_MISMATCH'));
});

test('validator catches missing references and incorrect totals', () => {
  const invalid = { ...candidate, scenes: [{ ...candidate.scenes[0], participants: ['a', 'missing'] }], runPolicy: { ...candidate.runPolicy, expectedTotalTurns: 99 } };
  const result = validatePlanShape(invalid, ids);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'ROLE_REFERENCE'));
  assert.ok(result.errors.some((error) => error.code === 'TOTAL_MISMATCH'));
});

test('repair prompt keeps the candidate and machine-readable errors', () => {
  const prompt = buildPlanRepairPrompt({ candidateJson: JSON.stringify(candidate), errors: [{ code: 'TOTAL_MISMATCH', path: 'runPolicy.expectedTotalTurns', message: 'must equal scene sum' }], ...ids });
  assert.match(prompt, /TLA_PLAN_V2_REPAIR/);
  assert.match(prompt, /TOTAL_MISMATCH/);
  assert.match(prompt, /TLA_PLAN_V2_BEGIN/);
  assert.match(prompt, /nonce-1/);
});

test('repair prompt repeats the configured role-slot contract', () => {
  const prompt = buildPlanRepairPrompt({
    candidateJson: '{}',
    errors: [{ code: 'ROLE_REFERENCE', path: '$.scenes[0].participants', message: 'unknown role' }],
    roleSlots: [{ roleId: 'role-a', role: '생존 전문가', rolePrompt: '자원을 계산한다.' }],
    ...ids,
  });
  assert.match(prompt, /ROLE_SLOT_COUNT: 1/);
  assert.match(prompt, /role-a/);
  assert.match(prompt, /자원을 계산한다/);
});

test('auto repair prompt preserves role-count range', () => {
  const prompt = buildPlanRepairPrompt({ candidateJson: '{}', errors: [], autoRoleProvisioning: true, ...ids });
  assert.match(prompt, /2.*6/i);
});
