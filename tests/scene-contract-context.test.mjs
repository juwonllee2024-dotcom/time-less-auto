import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdaptiveContextPlan,
  buildAutonomousContextPlan,
} from '../context-engine.mjs';

const sceneContract = {
  projectTitle: '무인도 생존 기록',
  sceneNumber: 4,
  totalScenes: 10,
  sceneTitle: '식량 독점 갈등',
  goal: '식량 배분 원칙을 정하고 동맹의 균열을 드러낸다.',
  currentTurn: 2,
  targetTurns: 6,
  maxTurns: 8,
  remainingTargetTurns: 4,
  remainingMaxTurns: 6,
  emotionIntensity: 82,
  endCondition: '식량 배분 합의 또는 8턴 도달',
  mode: 'autonomous',
};

test('adaptive context carries the scene contract into the prompt', () => {
  const plan = buildAdaptiveContextPlan({
    provider: 'chatgpt',
    meetingTitle: '무인도 생존 기록',
    targetLabel: '제이든',
    participants: ['제이든', '유학생'],
    turnNumber: 12,
    topicText: '식량을 숨긴 사람이 누구인지 추궁한다.',
    role: '싸가지 없는 유학생',
    rolePrompt: '한국어를 무시하고 영어로만 반응한다.',
    sessionPhase: '대립',
    sceneContract,
    entries: [],
  });

  assert.match(plan.promptText, /SCENE CONTRACT/);
  assert.match(plan.promptText, /Scene: 4\/10/);
  assert.match(plan.promptText, /8 maximum/);
  assert.match(plan.promptText, /식량 배분 합의 또는 8턴 도달/);
});

test('autonomous context carries remaining scene turns and end condition', () => {
  const plan = buildAutonomousContextPlan({
    provider: 'claude',
    meetingTitle: '무인도 생존 기록',
    targetLabel: '제이든',
    participants: ['제이든', '유학생'],
    turnNumber: 3,
    topicText: '다음 행동을 결정한다.',
    role: '제이든',
    rolePrompt: '감정을 숨기지 말고 행동으로 보여준다.',
    sessionPhase: '대립',
    sceneContract,
    entries: [],
  });

  assert.match(plan.promptText, /SCENE CONTRACT/);
  assert.match(plan.promptText, /2\/6 expected/);
  assert.match(plan.promptText, /8 maximum/);
  assert.match(plan.promptText, /식량 배분 합의 또는 8턴 도달/);
});
