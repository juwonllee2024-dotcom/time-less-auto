import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAutopilotSurfaceModel, buildYouTubeSurfaceModel, captureStatusLabel, sceneStatusLabel } from '../youtube-ui-model.mjs';

test('maps internal statuses to plain creator language', () => {
  assert.equal(sceneStatusLabel('READY'), '준비됨');
  assert.equal(sceneStatusLabel('LIVE'), '진행 중');
  assert.equal(sceneStatusLabel('PAUSED'), '일시정지');
  assert.equal(sceneStatusLabel('FINISHED'), '완료');
  assert.equal(sceneStatusLabel('NEEDS_ATTENTION'), '확인 필요');
  assert.equal(captureStatusLabel('complete'), '저장됨');
  assert.equal(captureStatusLabel('retry'), '다시 확인 중');
  assert.equal(captureStatusLabel('failed'), '캡처 실패');
});

test('builds a compact project/scene/captures view model without engine jargon', () => {
  const model = buildYouTubeSurfaceModel({
    id: 'm1', title: '기숙사 복도', topicText: '싸가지 없는 유학생의 첫날', status: 'LIVE',
    interactionMode: 'autonomous', currentTurn: 2,
    participants: [{ id: 'p1', label: 'ChatGPT', provider: 'chatgpt', role: '유학생', rolePrompt: '무뚝뚝하게 말해' }],
    transcript: [{ id: 'e1', speakerType: 'AI', participantId: 'p1', text: 'Nope.', turnNumber: 1 }],
    activityLog: [], settings: {},
  }, [
    { key: 'm1:t1:1', participantId: 'p1', turnNumber: 1, provider: 'chatgpt', status: 'complete', filename: 'turn-001.png', downloadId: 7 },
    { key: 'm1:t2:2', participantId: 'p1', turnNumber: 2, provider: 'chatgpt', status: 'retry', filename: 'turn-002.png' },
  ]);
  assert.equal(model.status.label, '진행 중');
  assert.equal(model.mode.label, '자동 진행');
  assert.equal(model.characters[0].role, '유학생');
  assert.deepEqual(model.captures.counts, { total: 2, complete: 1, pending: 1, failed: 0 });
  assert.equal(model.captures.items[0].label, '저장됨');
  assert.equal(model.actions.canPause, true);
  assert.equal(model.actions.canStart, false);
});

test('handles missing legacy fields without exposing technical state', () => {
  const model = buildYouTubeSurfaceModel({ status: 'READY', participants: [], transcript: [] }, []);
  assert.equal(model.title, '새 쇼츠 장면');
  assert.equal(model.topic, '');
  assert.equal(model.status.label, '준비됨');
  assert.equal(model.captures.counts.total, 0);
});

test('autopilot model exposes phase timeline and measured counts for the control tower', () => {
  const model = buildAutopilotSurfaceModel({
    runId: 'run-1',
    state: 'CAPTURE_VERIFIED',
    plan: { planHash: 'sha256:1234567890' },
    metrics: { expectedTurns: 8, maxTurns: 12, actualTurns: 3, successfulCaptures: 3, failedCaptures: 0, zipFiles: 0 },
    events: [{ type: 'CAPTURE_VERIFIED', status: 'complete', message: 'ok', at: 10 }],
  }, []);
  assert.equal(model.phaseLabel, '캡처 확인');
  assert.equal(model.metrics.actualTurns, 3);
  assert.equal(model.events[0].type, 'CAPTURE_VERIFIED');
  assert.equal(model.canPause, true);
});

test('autopilot model exposes reset for paused or terminal runs', () => {
  const paused = buildAutopilotSurfaceModel({ runId: 'run-paused', state: 'PAUSED', metrics: {}, events: [] }, []);
  const stopped = buildAutopilotSurfaceModel({ runId: 'run-stopped', state: 'CANCELLED', metrics: {}, events: [] }, []);
  const complete = buildAutopilotSurfaceModel({ runId: 'run-complete', state: 'COMPLETE', metrics: {}, events: [] }, []);
  assert.equal(paused.canReset, true);
  assert.equal(stopped.canReset, true);
  assert.equal(stopped.canResume, true);
  assert.equal(complete.canReset, true);
});

test('projects expose every planned scene and the active scene contract', () => {
  const model = buildYouTubeSurfaceModel({
    status: 'READY',
    projectPlan: {
      title: '무인도 생존 기록',
      keyword: '무인도',
      premise: '두 사람이 살아남는다.',
      status: 'APPROVED',
      currentSceneIndex: 3,
      sceneTurnCount: 2,
      approval: { approved: true, scope: 'all' },
      scenes: [
        { index: 0, title: '도착', summary: '도착', goal: '규칙 세우기', targetTurns: 4, maxTurns: 6, emotionIntensity: 'medium', endCondition: '합의' },
        { index: 1, title: '밤', summary: '밤', goal: '버티기', targetTurns: 4, maxTurns: 6, emotionIntensity: 'high', endCondition: '아침' },
        { index: 2, title: '식량', summary: '식량', goal: '찾기', targetTurns: 5, maxTurns: 7, emotionIntensity: 'high', endCondition: '발견' },
        { index: 3, title: '갈등', summary: '갈등', goal: '배분', targetTurns: 6, maxTurns: 8, emotionIntensity: 'very-high', endCondition: '합의' },
      ],
    },
    participants: [],
    transcript: [],
  }, []);

  assert.equal(model.project.sceneCount, 4);
  assert.equal(model.project.currentScene.number, 4);
  assert.equal(model.project.currentScene.sceneTurnCount, 2);
  assert.equal(model.project.approval.approved, true);
  assert.equal(model.project.scenes[3].goal, '배분');
});

test('transition transcript entries remain typed for the visual card', () => {
  const model = buildYouTubeSurfaceModel({
    status: 'LIVE',
    transcript: [{ kind: 'SCENE_TRANSITION', speakerType: 'SYSTEM', text: '━━ 장면 전환 ━━', sceneTransition: { kind: 'SCENE_TRANSITION', to: { title: '첫날 밤' } } }],
    participants: [],
  }, []);
  assert.equal(model.transcript[0].kind, 'SCENE_TRANSITION');
  assert.equal(model.transcript[0].sceneTransition.to.title, '첫날 밤');
});
